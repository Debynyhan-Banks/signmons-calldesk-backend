// Invoked only by the disposable Unix-socket database harness. No real SDK calls.
import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
export async function verifyStagingPhone({ prisma, cipher }) {
  const [db] = await prisma.$queryRawUnsafe(
    "SELECT current_database() AS name, inet_server_addr() AS address",
  );
  assert.match(db.name, /^calldesk_org_[0-9a-f]{12}$/);
  assert.equal(db.address, null);
  const {
    CustomerConsentCredentials,
  } = require("../dist/communications/customer-consent-credentials.js");
  const {
    CustomerConsentResponseService,
  } = require("../dist/communications/customer-consent-response.service.js");
  const {
    requestContextMiddleware,
    setAuthContext,
  } = require("../dist/common/context/request-context.js");
  const {
    stagingPhoneDigest,
  } = require("../dist/communications/staging-phone-policy.js");
  const actor = (tenantId, role, fn) =>
    new Promise((resolve, reject) =>
      requestContextMiddleware({ headers: {} }, {}, () => {
        setAuthContext({
          tenantId,
          userId: role === "owner" ? "fixture-owner" : "integration:phone",
          role,
        });
        Promise.resolve().then(fn).then(resolve, reject);
      }),
    );
  const sdkPath = require.resolve("twilio");
  require(sdkPath);
  const originalSdk = require.cache[sdkPath].exports;
  let calls = 0,
    behavior = "pending",
    hold,
    entered;
  require.cache[sdkPath].exports = (accountSid, _token, options) => {
    assert.equal(options.autoRetry, false);
    assert.equal(options.maxRetries, 0);
    return {
      verify: {
        v2: {
          services: (serviceSid) => ({
            verifications: {
              create: async ({ to, channel, riskCheck }) => {
                calls++;
                assert.equal(channel, "sms");
                assert.equal(riskCheck, "enable");
                if (entered) entered();
                if (hold) await hold;
                if (behavior === "unknown") throw Error("fictional timeout");
                return {
                  accountSid,
                  serviceSid,
                  sid: "VE" + "c".repeat(32),
                  to,
                  channel: "sms",
                  status: "pending",
                };
              },
            },
            verificationChecks: {
              create: async () => {
                calls++;
                return {
                  accountSid,
                  serviceSid,
                  sid: "VE" + "c".repeat(32),
                  to: "+12025550123",
                  channel: "sms",
                  status: "approved",
                };
              },
            },
          }),
        },
      },
    };
  };
  // Import after replacing SDK in this isolated process; restore in finally.
  const {
    StagingPhoneService,
  } = require("../dist/communications/staging-phone.service.js");
  const fixture = async (
    accountSid = "AC" + randomBytes(16).toString("hex"),
  ) => {
    const tenant = await prisma.tenantOrganization.create({
      data: { name: "Fictional phone-only", timezone: "UTC", settings: {} },
    });
    const credentials = new CustomerConsentCredentials({
      activeKeyId: "staging-phone",
      keys: { "staging-phone": Buffer.alloc(32, 9) },
    });
    const responses = new CustomerConsentResponseService(
      prisma,
      cipher,
      credentials,
      {
        record: async () => {
          throw Error("no email writes");
        },
      },
    );
    const { sessionToken } = await actor(tenant.id, "webchat_integration", () =>
      responses.start(),
    );
    const scope = credentials.verifySession(sessionToken);
    const p = {
      version: 1,
      tenantId: tenant.id,
      conversationId: scope.conversationId,
      sessionId: scope.sessionId,
      operatorId: "fixture-owner",
      accountSid,
      serviceSid: "VA" + "b".repeat(32),
      phoneDigest: createHmac("sha256", Buffer.alloc(32, 8))
        .update("+12025550123")
        .digest("hex"),
      startsAt: Date.now() - 1000,
      expiresAt: Date.now() + 60000,
      rateVersion: "fictional-not-a-price",
      flowUpperBoundMicros: 300000,
      noticeVersion: "fictional-notice",
    };
    const save = async (enabled) =>
      prisma.tenantOrganization.update({
        where: { id: tenant.id },
        data: {
          settings: {
            stagingPhoneTestApproval: {
              enabled,
              digest: stagingPhoneDigest(p),
            },
          },
        },
      });
    await save(true);
    const config = {
      STAGING_PHONE_TEST_ENABLED: "true",
      STAGING_PHONE_TEST_POLICY: JSON.stringify(p),
      K_SERVICE: "signmons-calldesk-staging",
      GOOGLE_CLOUD_PROJECT: "signmons",
      STAGING_PHONE_SESSION_KEY: Buffer.alloc(32, 9).toString("hex"),
      STAGING_PHONE_DIGEST_KEY: Buffer.alloc(32, 8).toString("hex"),
      STAGING_PHONE_TWILIO_AUTH_TOKEN: "a".repeat(32),
    };
    const service = new StagingPhoneService(
      { get: (key) => config[key] },
      prisma,
      cipher,
    );
    const request = {
      sessionToken,
      operationId: randomUUID(),
      kind: "START",
      phone: "+12025550123",
      code: "",
      startOperationId: "",
    };
    const run = (r = request) =>
      actor(tenant.id, "owner", () =>
        service.execute(
          r,
          r.kind === "START"
            ? { requested: true, noticeVersion: p.noticeVersion }
            : undefined,
        ),
      );
    return {
      p,
      config,
      request,
      run,
      save,
      stop: () => actor(tenant.id, "owner", () => service.stop()),
    };
  };
  try {
    const jobs = await prisma.job.count();
    const f = await fixture();
    const results = await Promise.all([f.run(), f.run()]);
    assert.equal(calls, 1);
    assert.ok(results.some((r) => r.outcome === "PENDING"));
    assert.equal((await f.run()).outcome, "PENDING");
    assert.equal(calls, 1);
    await assert.rejects(f.run({ ...f.request, operationId: randomUUID() }));
    const checked = await f.run({
      ...f.request,
      kind: "CHECK",
      code: "123456",
      operationId: randomUUID(),
      startOperationId: f.request.operationId,
    });
    assert.equal(checked.outcome, "APPROVED");
    assert.equal(checked.phoneAccessAuthorized, false);
    assert.equal(checked.jobAdmissionAuthorized, false);
    assert.equal(checked.addressValidationAuthorized, false);
    await assert.rejects(
      f.run({
        ...f.request,
        kind: "CHECK",
        code: "123456",
        operationId: randomUUID(),
        startOperationId: f.request.operationId,
      }),
    );
    await f.stop();
    await assert.rejects(f.run());
    assert.equal(calls, 2);

    behavior = "unknown";
    const uncertain = await fixture();
    await uncertain.run();
    const atUnknown = calls;
    assert.equal((await uncertain.run()).outcome, "UNKNOWN");
    assert.equal(calls, atUnknown);
    await assert.rejects(
      uncertain.run({ ...uncertain.request, operationId: randomUUID() }),
    );
    const held = await prisma.auditLog.findMany({
      where: {
        tenantId: uncertain.p.tenantId,
        action: "conversation.staging_phone_held",
      },
    });
    assert.equal(held.length, 1);
    assert.equal(held[0].metadata.reservedMicros, 300000);

    behavior = "pending";
    const shared = "AC" + randomBytes(16).toString("hex"),
      a = await fixture(shared),
      b = await fixture(shared);
    const before = calls;
    const race = await Promise.allSettled([a.run(), b.run()]);
    assert.equal(race.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(calls, before + 1);

    const stopped = await fixture();
    let release;
    hold = new Promise((resolve) => {
      release = resolve;
    });
    const dispatchEntered = new Promise((resolve) => {
      entered = resolve;
    });
    const pending = stopped.run();
    await dispatchEntered;
    const stopping = stopped.stop();
    release();
    await pending;
    await stopping;
    hold = undefined;
    entered = undefined;
    const atStop = calls;
    await assert.rejects(stopped.run());
    assert.equal(calls, atStop);

    const expired = await fixture();
    const policy = JSON.parse(expired.config.STAGING_PHONE_TEST_POLICY);
    policy.startsAt = Date.now() - 10000;
    policy.expiresAt = Date.now() - 1;
    expired.config.STAGING_PHONE_TEST_POLICY = JSON.stringify(policy);
    await assert.rejects(expired.run());
    assert.equal(calls, atStop);
    assert.equal(await prisma.job.count(), jobs);
    const unqualified = await fixture();
    await unqualified.run();
    const priorHold = await prisma.auditLog.findFirstOrThrow({
      where: {
        tenantId: unqualified.p.tenantId,
        action: "conversation.staging_phone_held",
      },
    });
    await prisma.auditLog.update({
      where: { id: priorHold.id },
      data: {
        metadata: {
          ...priorHold.metadata,
          approvalDigest: "old-fixture-not-staging",
        },
      },
    });
    const beforeRefusal = calls;
    await assert.rejects(unqualified.run());
    assert.equal(calls, beforeRefusal);
    return "PASS phone-only: concurrent replay, one START, successful CHECK without authority, stop, uncertainty with retained liability, shared-account cap, in-flight stop, expiry; real local PostgreSQL, substituted SDK, zero provider traffic.";
  } finally {
    require.cache[sdkPath].exports = originalSdk;
  }
}
