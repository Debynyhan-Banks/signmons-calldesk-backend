// Called only by the disposable organization verifier; no URL or live credentials.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { verifyLoadedIntakeBrowser } from "./verify-loaded-intake-browser.mjs";
const require = createRequire(import.meta.url);
const {
  loadControlledIntakeRuntime,
} = require("../dist/communications/controlled-intake-runtime.js");
const {
  controlledCustomerAdmissionDigest,
} = require("../dist/communications/controlled-customer-admission.js");
export async function verifyControlledRuntime({
  prisma,
  cipher,
  activation,
  scoped,
  browser,
  evidence,
}) {
  const [db] = await prisma.$queryRawUnsafe(
    "SELECT current_database() AS name, inet_server_addr() AS address",
  );
  assert.match(db.name, /^calldesk_org_[0-9a-f]{12}$/);
  assert.equal(db.address, null);
  const tenantId = activation.tenantId,
    phone = "+12165550123",
    from = Date.now() - 1000,
    until = Date.now() + 60000;
  const config = {
    version: 1,
    enabled: true,
    project: "signmons",
    service: "synthetic",
    configuration: "synthetic",
    revision: "synthetic",
    origin: activation.origin,
    activation: {
      ...activation,
      packetId: randomUUID(),
      validFrom: new Date(from).toISOString(),
      validUntil: new Date(until).toISOString(),
    },
    phone: {
      tenantId,
      packetId: "",
      accountSid: "AC" + "a".repeat(32),
      serviceSid: "VA" + "b".repeat(32),
      participantHmac: createHmac("sha256", Buffer.alloc(32, 8))
        .update(phone)
        .digest("hex"),
      noticeVersion: "synthetic",
      rateVersion: "synthetic",
      startsAt: from,
      expiresAt: until,
      flowUpperBoundMicros: 10,
      accountCeilingMicros: 1000,
    },
    browserBudget: {
      tenantId,
      packetId: "",
      validFrom: from,
      validUntil: until,
      total: 20,
      tenant: 20,
      session: 15,
      starts: 1,
      inFlight: 2,
    },
    addressAccountId: randomUUID(),
    addressPolicy: {
      mode: "CONTROLLED_ADDRESS_V1",
      approved: true,
      version: "synthetic",
      rateVersion: "synthetic",
      validUntil: until,
      costMicros: 1,
      account: { micros: 2, requests: 2 },
      tenant: { micros: 2, requests: 2 },
      session: { micros: 2, requests: 2 },
      execution: "CONTROLLED_8S_2_ATTEMPTS",
    },
    secrets: {
      activeKeyId: "s1",
      sessionKeys: {
        s1: "projects/signmons/secrets/synthetic-session/versions/1",
      },
      digestKey: "projects/signmons/secrets/synthetic-digest/versions/1",
      fingerprintKey:
        "projects/signmons/secrets/synthetic-fingerprint/versions/1",
      fingerprintKeyVersion: "synthetic",
      twilioToken: "projects/signmons/secrets/synthetic-token/versions/1",
    },
  };
  config.phone.packetId = config.activation.packetId;
  config.browserBudget.packetId = config.activation.packetId;
  const facts = {
    nodeEnv: "production",
    project: config.project,
    service: config.service,
    configuration: config.configuration,
    revision: config.revision,
    port: "8080",
    flags: Object.fromEntries(
      [
        "DEV_AUTH_ENABLED",
        "SCHEDULING_ENABLED",
        "STRIPE_WEBHOOK_LIVEMODE",
        "SMS_DELIVERY_ENABLED",
        "BACKGROUND_WORKERS_ENABLED",
        "STAGING_PHONE_TEST_ENABLED",
      ].map((k) => [k, "false"]),
    ),
  };
  const secrets = {
    [config.secrets.sessionKeys.s1]: Buffer.alloc(32, 7),
    [config.secrets.digestKey]: Buffer.alloc(32, 8),
    [config.secrets.fingerprintKey]: Buffer.alloc(32, 6),
    [config.secrets.twilioToken]: "d".repeat(32),
  };
  const saved = (
    await prisma.tenantOrganization.findUniqueOrThrow({
      where: { id: tenantId },
    })
  ).settings;
  const approval = {
    enabled: true,
    digest: createHash("sha256").update(JSON.stringify(config)).digest("hex"),
  };
  const settings = {
    ...saved,
    controlledRuntimeApproval: approval,
    controlledPhoneApproval: {
      enabled: true,
      digest: controlledCustomerAdmissionDigest(config.phone),
    },
  };
  let calls = 0;
  const raw = (status) => ({
    status,
    accountSid: config.phone.accountSid,
    serviceSid: config.phone.serviceSid,
    sid: "VE" + "c".repeat(32),
    to: phone,
    channel: "sms",
  });
  const resources = {
    prisma,
    cipher,
    secrets,
    verifyFactory: () => ({
      verify: {
        v2: {
          services: () => ({
            verifications: {
              create: async () => {
                calls++;
                return raw("pending");
              },
            },
            verificationChecks: {
              create: async () => {
                calls++;
                return raw("approved");
              },
            },
          }),
        },
      },
    }),
    googlePorts: {
      token: async () => {
        throw Error("No Google request expected");
      },
      fetch: async () => {
        throw Error("No Google request expected");
      },
    },
  };
  try {
    await assert.rejects(loadControlledIntakeRuntime(config, facts, resources));
    assert.equal(calls, 0);
    await prisma.tenantOrganization.update({
      where: { id: tenantId },
      data: { settings },
    });
    await assert.rejects(
      loadControlledIntakeRuntime(config, facts, {
        ...resources,
        secrets: {
          ...secrets,
          [config.secrets.fingerprintKey]: Buffer.alloc(32, 8),
        },
      }),
    );
    await assert.rejects(
      loadControlledIntakeRuntime(config, facts, {
        ...resources,
        secrets: { ...secrets, [config.secrets.twilioToken]: "invalid" },
      }),
    );
    const runtime = await loadControlledIntakeRuntime(config, facts, resources);
    assert.ok(Object.isFrozen(runtime.binding));
    assert.equal(calls, 0);
    const request = async (path, body) =>
      scoped(() =>
        runtime.binding.transport.handle({
          method: "POST",
          url: "/customer-session/" + path,
          rawHeaders: [
            "Host",
            new URL(config.origin).host,
            "Origin",
            config.origin,
            "Content-Type",
            "application/json",
            "Sec-Fetch-Site",
            "same-origin",
            "Sec-Fetch-Mode",
            "cors",
            "Sec-Fetch-Dest",
            "empty",
            "X-CallDesk-Request",
            "customer-intake-v1",
          ],
          body: Buffer.from(JSON.stringify(body)),
          peerAddress: "127.0.0.1",
          encrypted: true,
        }),
      );
    const start = await request("start", {});
    assert.equal(start.status, 200);
    const sessionToken = start.body.sessionToken;
    assert.ok(sessionToken);
    assert.equal(start.body.sessionCloseAvailable, true);
    const input = {
      action: "START",
      code: "",
      noticeVersion: "synthetic",
      operationId: randomUUID(),
      phone,
      requested: true,
      sessionToken,
      startOperationId: "",
    };
    const sent = await request("verify", input);
    assert.equal(sent.status, 200);
    assert.equal(sent.body.outcome, "PENDING");
    const checked = await request("verify", {
      ...input,
      action: "CHECK",
      code: "123456",
      operationId: randomUUID(),
      startOperationId: input.operationId,
    });
    assert.equal(checked.status, 200);
    assert.equal(checked.body.outcome, "APPROVED");
    assert.equal(calls, 2);
    await prisma.tenantOrganization.update({
      where: { id: tenantId },
      data: {
        settings: {
          ...settings,
          controlledRuntimeApproval: { ...approval, enabled: false },
        },
      },
    });
    assert.notEqual((await request("verify", input)).status, 200);
    assert.equal(calls, 2);
    await prisma.tenantOrganization.update({
      where: { id: tenantId },
      data: { settings },
    });
    const {
      VerificationCleanupService,
    } = require("../dist/communications/verification-cleanup.service.js");
    const {
      CustomerConsentCredentials,
    } = require("../dist/communications/customer-consent-credentials.js");
    const credentials = new CustomerConsentCredentials({
      activeKeyId: "s1",
      keys: { s1: secrets[config.secrets.sessionKeys.s1] },
    });
    const claims = credentials.verifySession(sessionToken);
    await assert.rejects(
      new VerificationCleanupService(prisma, credentials, {
        mode: "CONTROLLED_SESSION_V1",
        tenantId: randomUUID(),
      }).end(sessionToken),
    );
    let transactions = 0;
    const failedPurge = new VerificationCleanupService(
      {
        $transaction: async (fn) => {
          if (++transactions === 2) throw Error("Synthetic purge failure");
          return prisma.$transaction(fn);
        },
      },
      credentials,
      { mode: "CONTROLLED_SESSION_V1", tenantId },
    );
    const pending = await failedPurge.end(sessionToken);
    assert.equal(pending.cleanupPending, true);
    const awaitingPurge = await prisma.conversation.findUniqueOrThrow({
      where: { id: claims.conversationId },
    });
    assert.ok(awaitingPurge.collectedData.verificationLifecycle.closedAt);
    assert.equal(
      awaitingPurge.collectedData.verificationLifecycle.purgedAt,
      null,
    );
    assert.equal(
      typeof awaitingPurge.collectedData.verificationOperations,
      "string",
    );
    assert.notEqual((await request("verify", input)).status, 200);
    assert.equal(calls, 2);
    const held = await prisma.auditLog.count({
      where: { action: "conversation.controlled_phone_held" },
    });
    const closed = await request("end", { sessionToken });
    assert.equal(closed.status, 200);
    assert.equal(closed.body.cleanupPending, false);
    assert.equal(closed.body.fixtureOnly, false);
    const repeated = await request("end", { sessionToken });
    assert.equal(repeated.status, 200);
    const row = await prisma.conversation.findUniqueOrThrow({
      where: { id: claims.conversationId },
    });
    assert.ok(row.collectedData.verificationLifecycle.closedAt);
    assert.ok(row.collectedData.verificationLifecycle.purgedAt);
    assert.equal(row.collectedData.verificationOperations, undefined);
    assert.equal(
      await prisma.auditLog.count({
        where: { action: "conversation.controlled_phone_held" },
      }),
      held,
    );
    assert.notEqual((await request("verify", input)).status, 200);
    assert.equal(calls, 2);
    runtime.retire();
    assert.notEqual((await request("verify", input)).status, 200);
    assert.equal(calls, 2);
    console.log(
      JSON.stringify({
        controlledRuntime: {
          startupNoProviderCalls: true,
          realApprovalReader: true,
          syntheticStartCheckCalls: calls,
          revocationRefused: true,
          retirementRefused: true,
          liveProviderCalls: 0,
        },
      }),
    );
    await verifyLoadedIntakeBrowser({
      browser,
      prisma,
      cipher,
      template: config,
      facts,
      secrets,
      evidence,
    });
  } finally {
    await prisma.tenantOrganization.update({
      where: { id: tenantId },
      data: { settings: saved },
    });
  }
}
