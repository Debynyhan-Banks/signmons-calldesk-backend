import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { verifyMessagingSettingsBrowser } from "./verify-messaging-settings-browser.mjs";
const require = createRequire(import.meta.url);
export async function verifyCustomerEmailSettings({
  prisma,
  tenantId,
  otherTenantId,
}) {
  const [db] = await prisma.$queryRawUnsafe(
    "SELECT current_database() AS name, inet_server_addr() AS address",
  );
  assert.match(db.name, /^calldesk_app013_intents_[0-9a-f]{12}$/);
  assert.equal(db.address, null);
  const {
    CustomerEmailSettingsService,
  } = require("../dist/communications/customer-email-settings.service.js");
  const {
    CustomerMessagingSettingsService,
  } = require("../dist/communications/customer-messaging-settings.service.js");
  const {
    TransactionalMessageTemplateService,
  } = require("../dist/communications/transactional-message-template.service.js");
  const {
    customerSmsPolicy,
  } = require("../dist/communications/customer-messaging-policy.js");
  const {
    requestContextMiddleware,
    setAuthContext,
  } = require("../dist/common/context/request-context.js");
  const service = new CustomerEmailSettingsService(prisma);
  const sms = new CustomerMessagingSettingsService(
    prisma,
    new TransactionalMessageTemplateService(),
  );
  const asActor = (fn, tenant = tenantId, role = "owner", impersonation) =>
    new Promise((resolve, reject) => {
      requestContextMiddleware({ headers: {} }, {}, () => {
        setAuthContext(
          { userId: "fixture-owner", tenantId: tenant, role },
          impersonation,
        );
        Promise.resolve().then(fn).then(resolve, reject);
      });
    });
  const all = (enabled) => ({
    APPOINTMENT_CONFIRMED: enabled,
    APPOINTMENT_RESCHEDULED: enabled,
    APPOINTMENT_CANCELLED: enabled,
  });
  const where = {
    tenantId,
    action: "communication.customer_email_preferences_updated",
  };
  const original = await prisma.tenantOrganization.findUniqueOrThrow({
    where: { id: tenantId },
  });
  const sideEffects = async () => ({
    messages: await prisma.communicationEvent.count(),
    intents: await prisma.smsEnqueueIntent.count(),
    jobs: await prisma.job.count(),
    calendar: await prisma.calendarOperation.count(),
  });
  const before = await sideEffects();
  try {
    const base = {
      unrelated: { privateFixture: true },
      customerSmsPreferences: {
        version: 1,
        events: { ...all(true), TECHNICIAN_ON_THE_WAY: true },
      },
    };
    await prisma.tenantOrganization.update({
      where: { id: tenantId },
      data: { settings: base },
    });
    const initial = await asActor(() => service.read());
    assert.equal(initial.source, "default");
    assert.deepEqual(initial.events, all(false));
    const saved = await asActor(() =>
      service.save({ expectedUpdatedAt: initial.updatedAt, events: all(true) }),
    );
    assert.equal(saved.deliveryAvailable, false);
    assert.deepEqual(
      (await asActor(() => new CustomerEmailSettingsService(prisma).read()))
        .events,
      all(true),
    );
    const row = await prisma.tenantOrganization.findUniqueOrThrow({
      where: { id: tenantId },
    });
    assert.deepEqual(row.settings.unrelated, base.unrelated);
    assert.deepEqual(
      row.settings.customerSmsPreferences,
      base.customerSmsPreferences,
    );
    await assert.rejects(
      asActor(() =>
        service.save({
          expectedUpdatedAt: initial.updatedAt,
          events: all(false),
        }),
      ),
      /changed/,
    );
    for (const role of ["dispatcher", "tech"])
      await assert.rejects(
        asActor(
          () =>
            service.save({
              expectedUpdatedAt: saved.updatedAt,
              events: all(false),
            }),
          tenantId,
          role,
        ),
        /owner or admin/,
      );
    await assert.rejects(
      asActor(() => service.read(), tenantId, "admin", otherTenantId),
      /impersonation/,
    );
    assert.deepEqual(
      (await asActor(() => service.read(), otherTenantId)).events,
      all(false),
    );
    const auditBefore = await prisma.auditLog.count({ where });
    const results = await Promise.allSettled([
      asActor(() =>
        service.save({
          expectedUpdatedAt: saved.updatedAt,
          events: all(false),
        }),
      ),
      asActor(() =>
        sms.save({
          expectedUpdatedAt: saved.updatedAt,
          events: { ...all(false), TECHNICIAN_ON_THE_WAY: false },
        }),
      ),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const current = await prisma.tenantOrganization.findUniqueOrThrow({
      where: { id: tenantId },
    });
    assert.deepEqual(current.settings.unrelated, base.unrelated);
    if (results[0].status === "fulfilled") {
      assert.deepEqual(
        current.settings.customerSmsPreferences,
        base.customerSmsPreferences,
      );
      assert.equal(await prisma.auditLog.count({ where }), auditBefore + 1);
    } else
      assert.deepEqual(
        current.settings.customerEmailPreferences.events,
        all(true),
      );
    const failed = new CustomerEmailSettingsService({
      $transaction: (fn) =>
        prisma.$transaction((tx) =>
          fn({
            tenantOrganization: tx.tenantOrganization,
            auditLog: {
              create() {
                throw Error("PRIVATE-AUDIT");
              },
            },
          }),
        ),
    });
    await assert.rejects(
      asActor(() =>
        failed.save({
          expectedUpdatedAt: current.updatedAt.toISOString(),
          events: all(true),
        }),
      ),
      /unconfirmed/,
    );
    assert.deepEqual(
      await prisma.tenantOrganization.findUniqueOrThrow({
        where: { id: tenantId },
      }),
      current,
    );
    const lost = new CustomerEmailSettingsService({
      $transaction: async (fn) => {
        await prisma.$transaction(fn);
        throw Error("PRIVATE-ACK");
      },
    });
    await assert.rejects(
      asActor(() =>
        lost.save({
          expectedUpdatedAt: current.updatedAt.toISOString(),
          events: all(true),
        }),
      ),
      /unconfirmed/,
    );
    await assert.rejects(
      asActor(() =>
        service.save({
          expectedUpdatedAt: current.updatedAt.toISOString(),
          events: all(false),
        }),
      ),
      /changed/,
    );
    assert.deepEqual((await asActor(() => service.read())).events, all(true));
    await prisma.tenantOrganization.update({
      where: { id: tenantId },
      data: { status: "SUSPENDED" },
    });
    await assert.rejects(
      asActor(() => service.read()),
      /unavailable for this tenant/,
    );
    await assert.rejects(
      asActor(() =>
        service.save({
          expectedUpdatedAt: current.updatedAt.toISOString(),
          events: all(false),
        }),
      ),
      /unavailable for this tenant/,
    );
    await prisma.tenantOrganization.update({
      where: { id: tenantId },
      data: { status: "ACTIVE", settings: base },
    });
    await verifyMessagingSettingsBrowser({
      prisma,
      tenantId,
      otherTenantId,
      channel: "email",
    });
    const afterBrowser = await prisma.tenantOrganization.findUniqueOrThrow({
      where: { id: tenantId },
    });
    assert.deepEqual(
      customerSmsPolicy(afterBrowser.settings),
      customerSmsPolicy(base),
    );
    assert.deepEqual(await sideEffects(), before);
    return [
      "email preferences: default off, independent SMS preservation, active tenant/role/impersonation boundaries",
      "email preferences: cross-channel concurrent single-winner CAS, atomic audit rollback, lost acknowledgment and stale replay refusal",
      "email preferences: actual React/Nest/PostgreSQL browser save/reload, conflict/denial, channel-switch stale response, invalid version and uncertain commit proof; zero delivery effects",
    ];
  } finally {
    await prisma.tenantOrganization.update({
      where: { id: tenantId },
      data: { settings: original.settings, status: original.status },
    });
  }
}
