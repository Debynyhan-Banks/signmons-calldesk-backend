// Imported only by the disposable PostgreSQL harness. No production config.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { verifyMessagingSettingsBrowser } from "./verify-messaging-settings-browser.mjs";
const require = createRequire(import.meta.url);
const {
  CustomerMessagingSettingsService,
} = require("../dist/communications/customer-messaging-settings.service.js");
const {
  TransactionalMessageTemplateService,
  TransactionalMessageTemplateKey: Key,
} = require("../dist/communications/transactional-message-template.service.js");
const {
  TransactionalMessagingService,
} = require("../dist/communications/transactional-messaging.service.js");
const {
  SmsDeliveryService,
} = require("../dist/communications/sms-delivery.service.js");
const {
  requestContextMiddleware,
  setAuthContext,
} = require("../dist/common/context/request-context.js");
const keys = Object.values(Key);
export async function verifyCustomerMessagingSettings({
  prisma,
  jobData,
  otherTenantId,
}) {
  const [db] = await prisma.$queryRawUnsafe(
    "SELECT current_database() AS name, inet_server_addr() AS address",
  );
  assert.match(db.name, /^calldesk_app013_intents_[0-9a-f]{12}$/);
  assert.equal(db.address, null);
  const tenantId = jobData.tenantId,
    templates = new TransactionalMessageTemplateService();
  const service = new CustomerMessagingSettingsService(prisma, templates);
  const asActor = (fn, role = "owner", tenant = tenantId) =>
    new Promise((resolve, reject) => {
      requestContextMiddleware({ headers: {} }, {}, () => {
        setAuthContext({ userId: "fixture-reviewer", tenantId: tenant, role });
        Promise.resolve().then(fn).then(resolve, reject);
      });
    });
  const all = (enabled) =>
    Object.fromEntries(keys.map((key) => [key, enabled]));
  const save = async (events) =>
    asActor(async () =>
      service.save({
        expectedUpdatedAt: (await service.read()).updatedAt,
        events,
      }),
    );
  const original = await prisma.tenantOrganization.findUniqueOrThrow({
    where: { id: tenantId },
  });
  const auditWhere = {
    tenantId,
    action: "communication.customer_sms_preferences_updated",
  };
  let providerCalls = 0;
  const config = {
    smsConsentHashKey: "local-fixture-hash-only",
    smsDeliveryEnabled: false,
    twilioWebhookEnvironment: "test",
    twilioWebhookBaseUrl: "http://127.0.0.1",
    twilioTenantIdentities: [
      {
        tenantId,
        enabled: true,
        environment: "test",
        phoneNumber: "+15555550000",
      },
    ],
  };
  const delivery = new SmsDeliveryService(
    prisma,
    { evaluateOutbound: async () => ({ allowed: true }) },
    { encrypt: (text) => text, decrypt: (text) => text },
    {
      send: async () => {
        providerCalls++;
        throw new Error("Provider forbidden in this fixture");
      },
    },
    config,
  );
  const messaging = new TransactionalMessagingService(
    prisma,
    templates,
    delivery,
  );
  const ids = [];
  try {
    await prisma.tenantOrganization.update({
      where: { id: tenantId },
      data: { settings: { unrelated: { privateFixture: true } } },
    });
    const initial = await asActor(() => service.read());
    assert.equal(initial.source, "legacy");
    assert.equal(JSON.stringify(initial).includes("privateFixture"), false);
    await save(all(false));
    const persisted = await asActor(() =>
      new CustomerMessagingSettingsService(prisma, templates).read(),
    );
    assert.ok(persisted.templates.every((t) => t.enabled === false));
    assert.deepEqual(
      (
        await prisma.tenantOrganization.findUniqueOrThrow({
          where: { id: tenantId },
        })
      ).settings.unrelated,
      { privateFixture: true },
    );
    await assert.rejects(
      asActor(() =>
        service.save({
          expectedUpdatedAt: initial.updatedAt,
          events: all(true),
        }),
      ),
      /changed/,
    );
    for (const role of ["dispatcher", "tech"])
      await assert.rejects(
        asActor(
          () =>
            service.save({
              expectedUpdatedAt: persisted.updatedAt,
              events: all(true),
            }),
          role,
        ),
        /owner or admin/,
      );
    assert.equal(
      (await asActor(() => service.read(), "admin", otherTenantId)).source,
      "legacy",
    );
    const beforeConcurrent = await prisma.auditLog.count({ where: auditWhere });
    const concurrent = await Promise.allSettled(
      [false, true].map((enabled) =>
        asActor(() =>
          service.save({
            expectedUpdatedAt: persisted.updatedAt,
            events: all(enabled),
          }),
        ),
      ),
    );
    assert.equal(concurrent.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(
      await prisma.auditLog.count({ where: auditWhere }),
      beforeConcurrent + 1,
    );
    const beforeRollback = await prisma.tenantOrganization.findUniqueOrThrow({
      where: { id: tenantId },
    });
    const failAudit = new CustomerMessagingSettingsService(
      {
        $transaction: (fn) =>
          prisma.$transaction((tx) =>
            fn({
              tenantOrganization: tx.tenantOrganization,
              auditLog: {
                create: () => {
                  throw new Error("PRIVATE-AUDIT");
                },
              },
            }),
          ),
      },
      templates,
    );
    await assert.rejects(
      asActor(() =>
        failAudit.save({
          expectedUpdatedAt: beforeRollback.updatedAt.toISOString(),
          events: all(true),
        }),
      ),
      /unconfirmed/,
    );
    assert.deepEqual(
      await prisma.tenantOrganization.findUniqueOrThrow({
        where: { id: tenantId },
      }),
      beforeRollback,
    );
    for (const key of keys) {
      await save(all(true));
      const job = await prisma.job.create({
        data: {
          ...jobData,
          intakeSessionId: randomUUID(),
          status: key === Key.APPOINTMENT_CANCELLED ? "CANCELLED" : "ACCEPTED",
          technicianStatus: "EN_ROUTE",
          technicianStatusUpdatedAt: new Date(),
          calendarEventId: "fixture-only",
          serviceWindowStart: new Date(Date.UTC(2039, 0, 15 + ids.length, 15)),
          serviceWindowEnd: new Date(Date.UTC(2039, 0, 15 + ids.length, 17)),
        },
      });
      ids.push(job.id);
      const event = await messaging.queueLifecycle({
        tenantId,
        jobId: job.id,
        templateKey: key,
      });
      await save(all(false));
      const count = await prisma.communicationEvent.count({
        where: { tenantId },
      });
      await assert.rejects(
        messaging.queueLifecycle({ tenantId, jobId: job.id, templateKey: key }),
        /disabled by tenant/,
      );
      assert.equal(
        await prisma.communicationEvent.count({ where: { tenantId } }),
        count,
      );
      assert.equal(await delivery.deliver(tenantId, event.id), "DEAD_LETTER");
      assert.equal(
        (
          await prisma.communicationEvent.findUniqueOrThrow({
            where: { id: event.id },
          })
        ).lastErrorCode,
        "suppressed_tenant_preference",
      );
      await save(all(true));
      assert.equal(
        (
          await prisma.communicationEvent.findUniqueOrThrow({
            where: { id: event.id },
          })
        ).status,
        "DEAD_LETTER",
      );
    }
    assert.equal(providerCalls, 0);
    assert.equal(await delivery.processDue(), 0);
    await prisma.tenantOrganization.update({
      where: { id: tenantId },
      data: { settings: { unrelated: { privateFixture: true } } },
    });
    await verifyMessagingSettingsBrowser({ prisma, tenantId, otherTenantId });
    assert.equal(providerCalls, 0);
    return [
      "messaging settings: real DB persistence, unrelated-setting preservation, tenant/role refusal, stale/concurrent single-winner save and audit rollback",
      "all four SMS templates: saved preferences block queue admission and suppress pre-existing queued records before provider access; re-enable never replays stopped records",
      "real browser -> HTTP/auth/service -> disposable PostgreSQL save/reload, desktop/mobile and conflict/denial proof",
    ];
  } finally {
    await prisma.communicationEvent.deleteMany({
      where: { jobId: { in: ids } },
    });
    await prisma.job.deleteMany({ where: { id: { in: ids } } });
    await prisma.auditLog.deleteMany({ where: auditWhere });
    await prisma.tenantOrganization.update({
      where: { id: tenantId },
      data: { settings: original.settings },
    });
  }
}
