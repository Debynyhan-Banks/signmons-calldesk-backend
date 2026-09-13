import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  AddressOperationLedger,
} = require("../dist/communications/address-operation-ledger.js");
const {
  ControlledIntakeAuthority,
} = require("../dist/communications/controlled-intake-authority.js");
const {
  requestContextMiddleware,
  setAuthContext,
} = require("../dist/common/context/request-context.js");

export async function verifyAddressOperationLedger({
  prisma,
  credentials,
  responses,
}) {
  const [db] = await prisma.$queryRawUnsafe(
    "SELECT current_database() AS name, inet_server_addr() AS address",
  );
  assert.match(db.name, /^calldesk_org_[0-9a-f]{12}$/);
  assert.equal(db.address, null);
  const accountId = randomUUID(),
    bindings = new Map();
  const actor = (tenantId, fn) =>
    new Promise((resolve, reject) =>
      requestContextMiddleware({ headers: {} }, {}, () => {
        setAuthContext({
          tenantId,
          userId: "integration:vo1",
          role: "webchat_integration",
        });
        Promise.resolve().then(fn).then(resolve, reject);
      }),
    );
  const policy = () => ({
    mode: "FIXTURE_ONLY",
    approved: true,
    version: "fictional-v1",
    rateVersion: "not-a-price",
    validUntil: Date.now() + 3600000,
    costMicros: 10,
    account: { micros: 20, requests: 10 },
    tenant: { micros: 20, requests: 10 },
    session: { micros: 20, requests: 10 },
  });
  const factory = (database = prisma) =>
    new AddressOperationLedger(database, credentials, {
      accountId,
      readBinding: async (_tx, scope) => bindings.get(scope.sessionId) ?? null,
    });
  const service = factory();
  async function customer() {
    const tenant = await prisma.tenantOrganization.create({
      data: { name: "Fictional VO1", timezone: "UTC", settings: {} },
    });
    const { sessionToken } = await actor(tenant.id, () => responses.start());
    const scope = credentials.verifySession(sessionToken);
    bindings.set(scope.sessionId, {
      intentId: randomUUID(),
      revision: 1,
      policy: policy(),
    });
    const request = {
      sessionToken,
      requestId: randomUUID(),
      action: "reserve",
    };
    return {
      scope,
      request,
      run: (input = request, ledger = service) =>
        actor(tenant.id, () => ledger.execute(input)),
    };
  }
  const a = await customer(),
    b = await customer();
  // Different client logical IDs for identical current intent still reserve once.
  const ids = Array.from({ length: 4 }, () => randomUUID());
  const duplicate = await Promise.all(
    ids.map((requestId) => a.run({ ...a.request, requestId })),
  );
  assert.equal(new Set(duplicate.map((r) => r.operationId)).size, 1);
  const operationId = duplicate[0].operationId;
  assert.equal(
    await prisma.addressVerificationOperation.count({ where: { accountId } }),
    1,
  );
  assert.equal(
    await prisma.auditLog.count({
      where: {
        entityId: a.scope.conversationId,
        action: "conversation.address_operation_reserved",
      },
    }),
    1,
  );
  a.request.requestId = ids[0];
  const claims = await Promise.all(
    ids.map((requestId) => a.run({ ...a.request, requestId, action: "claim" })),
  );
  assert.equal(claims.filter((r) => r.claimed).length, 1);
  assert.ok(
    claims.every(
      (r) => r.dispatchAuthorized === false && r.admissionAuthorized === false,
    ),
  );
  assert.equal(
    (await a.run({ ...a.request, action: "claim" }, factory())).claimed,
    false,
  );
  await assert.rejects(a.run({ ...a.request, action: "cancel" }));
  await assert.rejects(b.run({ ...b.request, requestId: ids[0] }));
  const original = structuredClone(bindings.get(a.scope.sessionId));
  bindings.get(a.scope.sessionId).intentId = randomUUID();
  bindings.get(a.scope.sessionId).revision++;
  await assert.rejects(a.run(a.request));
  // Shared account cap: two distinct tenant contenders can only consume one remaining slot.
  const attempts = await Promise.allSettled([
    a.run({ ...a.request, requestId: randomUUID() }),
    b.run(),
  ]);
  assert.equal(attempts.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    (
      await prisma.addressVerificationOperation.aggregate({
        where: { accountId },
        _sum: { heldMicros: true },
      })
    )._sum.heldMicros,
    20n,
  );
  // Prior-month unresolved liabilities do not disappear at a boundary or restart.
  await prisma.addressVerificationOperation.updateMany({
    where: { accountId },
    data: { createdAt: new Date("2026-08-31T23:59:59Z") },
  });
  await assert.rejects(
    b.run(
      { ...b.request, requestId: randomUUID() },
      new AddressOperationLedger(prisma, credentials, {
        accountId,
        readBinding: async () => ({
          intentId: randomUUID(),
          revision: 2,
          policy: policy(),
        }),
      }),
    ),
  );
  bindings.set(a.scope.sessionId, original);
  assert.equal(
    (await a.run({ ...a.request, action: "claim" }, factory())).claimed,
    false,
  );
  // Missing/stale/malformed policy refuses without ledger/audit mutations.
  for (const change of [
    null,
    { ...original, policy: { ...original.policy, approved: false } },
    { ...original, policy: { ...original.policy, validUntil: 0 } },
    { ...original, policy: { ...original.policy, costMicros: NaN } },
  ]) {
    bindings.set(a.scope.sessionId, change);
    await assert.rejects(a.run());
  }
  bindings.set(a.scope.sessionId, original);
  // Isolated second account for atomic rollback and safe pre-dispatch cancellation.
  const isolated = randomUUID();
  const make = (database = prisma, p = original.policy) =>
    new AddressOperationLedger(database, credentials, {
      accountId: isolated,
      readBinding: async () => ({ ...original, policy: p }),
    });
  const failAudit = {
    $transaction: (fn) =>
      prisma.$transaction((tx) =>
        fn(
          new Proxy(tx, {
            get(target, key) {
              if (key === "auditLog")
                return {
                  ...target.auditLog,
                  create: async () => {
                    throw Error("synthetic audit failure");
                  },
                };
              const value = target[key];
              return typeof value === "function" ? value.bind(target) : value;
            },
          }),
        ),
      ),
  };
  const fresh = { ...a.request, requestId: randomUUID() };
  await assert.rejects(a.run(fresh, make(failAudit)));
  assert.equal(
    await prisma.addressVerificationOperation.count({
      where: { accountId: isolated },
    }),
    0,
  );
  assert.equal(
    await prisma.addressVerificationRequest.count({
      where: { id: fresh.requestId },
    }),
    0,
  );
  const saved = await a.run(fresh, make());
  await assert.rejects(a.run({ ...fresh, action: "claim" }, make(failAudit)));
  assert.equal(
    (
      await prisma.addressVerificationOperation.findUnique({
        where: { id: saved.operationId },
      })
    ).state,
    "RESERVED",
  );
  await a.run({ ...fresh, action: "cancel" }, make());
  assert.equal(
    (await a.run({ ...fresh, action: "claim" }, make())).claimed,
    false,
  );
  assert.equal(
    (
      await prisma.addressVerificationOperation.findUnique({
        where: { id: saved.operationId },
      })
    ).heldMicros,
    0n,
  );
  // Independently exercise each budget dimension without the shared cap masking it.
  for (const dimension of ["account", "tenant", "session"]) {
    for (const kind of ["micros", "requests"]) {
      const cap = policy();
      cap.account = { micros: 100, requests: 10 };
      cap.tenant = { micros: 100, requests: 10 };
      cap.session = { micros: 100, requests: 10 };
      cap[dimension][kind] = kind === "micros" ? 10 : 1;
      let currentIntent = randomUUID();
      const bounded = new AddressOperationLedger(prisma, credentials, {
        accountId: randomUUID(),
        readBinding: async () => ({
          ...original,
          intentId: currentIntent,
          policy: cap,
        }),
      });
      await a.run({ ...fresh, requestId: randomUUID() }, bounded);
      currentIntent = randomUUID();
      await assert.rejects(
        a.run({ ...fresh, requestId: randomUUID() }, bounded),
      );
    }
  }
  // Cancellation/claim compete under the same durable lock: never both win.
  const racing = make(prisma, { ...original.policy, version: "race-v1" });
  const raceRequest = { ...fresh, requestId: randomUUID() };
  const race = await a.run(raceRequest, racing);
  await Promise.allSettled([
    a.run({ ...raceRequest, action: "claim" }, racing),
    a.run({ ...raceRequest, action: "cancel" }, racing),
  ]);
  const raceRow = await prisma.addressVerificationOperation.findUnique({
    where: { id: race.operationId },
  });
  assert.ok(
    (raceRow.state === "CANCELLED" &&
      raceRow.heldMicros === 0n &&
      raceRow.attemptId === null) ||
      (raceRow.state === "DISPATCH_CLAIMED" &&
        raceRow.heldMicros === 10n &&
        raceRow.attemptId),
  );
  const rows = await prisma.addressVerificationOperation.findMany({
    where: { accountId },
  });
  assert.ok(
    rows.every(
      (r) =>
        !Object.keys(r).some((k) =>
          /address|phone|token|digest|payload/i.test(k),
        ),
    ),
  );
  await prisma.conversation.update({
    where: { id: a.scope.conversationId },
    data: { status: "COMPLETED" },
  });
  await assert.rejects(a.run({ ...a.request, action: "claim" }));
  // Controlled entry reuses the same real tables/locks, with no fake request role.
  const controlledCustomer = await customer();
  const controlledScope = credentials.verifySession(
    controlledCustomer.request.sessionToken,
  );
  const category = randomUUID();
  const approvedAt = new Date(Date.now() - 1000).toISOString();
  const activation = {
    version: 1,
    enabled: true,
    tenantId: controlledScope.tenantId,
    integrationId: "controlled-test",
    origin: "https://example.invalid",
    policyVersion: "v1",
    organizationApprovedAt: approvedAt,
    organizationDigest: "a".repeat(64),
    paymentApprovedAt: approvedAt,
    paymentDigest: "b".repeat(64),
    allowedServiceCategoryIds: [category],
    priorityPolicy: "AUTO_INTAKE_STANDARD_V1",
    validFrom: approvedAt,
    validUntil: new Date(Date.now() + 60000).toISOString(),
    packetId: randomUUID(),
  };
  const authority = new ControlledIntakeAuthority(
    () => activation,
    async (tx) => {
      const [clock] = await tx.$queryRawUnsafe(
        "SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS ms",
      );
      return {
        tenantId: controlledScope.tenantId,
        tenantActive: true,
        serviceCategoryId: category,
        categoryActive: true,
        organizationApprovedAt: approvedAt,
        organizationDigest: activation.organizationDigest,
        paymentApprovedAt: approvedAt,
        paymentDigest: activation.paymentDigest,
        nowMs: Number(clock.ms),
      };
    },
  );
  const controlledConfig = {
    accountId: randomUUID(),
    authority,
    capability: authority.issue(),
    scope: {
      tenantId: controlledScope.tenantId,
      integrationId: activation.integrationId,
      origin: activation.origin,
      serviceCategoryId: category,
    },
    readBinding: async () => bindings.get(controlledScope.sessionId),
  };
  const controlledPolicy = {
    ...policy(),
    mode: "CONTROLLED_ADDRESS_V1",
    execution: "CONTROLLED_8S_2_ATTEMPTS",
    account: { micros: 100, requests: 10 },
    tenant: { micros: 100, requests: 10 },
    session: { micros: 20, requests: 2 },
  };
  bindings.set(controlledScope.sessionId, {
    intentId: randomUUID(),
    revision: 1,
    policy: controlledPolicy,
  });
  const controlled = new AddressOperationLedger(
    prisma,
    credentials,
    undefined,
    controlledConfig,
  );
  const controlledRequest = {
    sessionToken: controlledCustomer.request.sessionToken,
    requestId: controlledCustomer.request.requestId,
  };
  await controlled.executeControlled({
    ...controlledRequest,
    action: "reserve",
  });
  const raced = await Promise.all(
    [0, 1].map(() =>
      controlled.executeControlled({ ...controlledRequest, action: "claim" }),
    ),
  );
  assert.equal(raced.filter((x) => x.claimed).length, 1);
  const claim = raced.find((x) => x.claimed);
  assert.equal(claim.fixtureOnly, false);
  const restarted = new AddressOperationLedger(
    prisma,
    credentials,
    undefined,
    controlledConfig,
  );
  assert.equal(
    (
      await restarted.executeControlled({
        ...controlledRequest,
        action: "claim",
      })
    ).claimed,
    false,
  );
  await controlled.completeControlled({
    ...controlledRequest,
    attemptId: claim.attemptId,
    state: "OBSERVED",
  });
  const observation = {
    ...controlledRequest,
    operationId: claim.operationId,
    attemptId: claim.attemptId,
    intentId: claim.intentId,
    revision: claim.revision,
    policyHash: claim.policyHash,
    executionDeadline: claim.executionDeadline,
  };
  await prisma.$transaction((tx) =>
    controlled.checkControlledObservation(tx, observation),
  );
  controlledPolicy.approved = false;
  await assert.rejects(
    prisma.$transaction((tx) =>
      controlled.checkControlledObservation(tx, observation),
    ),
  );
  controlledPolicy.approved = true;
  controlledPolicy.rateVersion = "changed-rate";
  await assert.rejects(
    prisma.$transaction((tx) =>
      controlled.checkControlledObservation(tx, observation),
    ),
  );
  controlledPolicy.rateVersion = "not-a-price";
  bindings.set(controlledScope.sessionId, {
    intentId: randomUUID(),
    revision: 2,
    policy: controlledPolicy,
  });
  const secondRequest = { ...controlledRequest, requestId: randomUUID() };
  await controlled.executeControlled({ ...secondRequest, action: "reserve" });
  const secondClaim = await controlled.executeControlled({
    ...secondRequest,
    action: "claim",
  });
  await controlled.completeControlled({
    ...secondRequest,
    attemptId: secondClaim.attemptId,
    state: "UNCERTAIN",
  });
  bindings.set(controlledScope.sessionId, {
    intentId: randomUUID(),
    revision: 3,
    policy: controlledPolicy,
  });
  await assert.rejects(
    controlled.executeControlled({
      ...controlledRequest,
      requestId: randomUUID(),
      action: "reserve",
    }),
  );
  assert.equal(
    (
      await prisma.addressVerificationOperation.aggregate({
        where: { accountId: controlledConfig.accountId },
        _sum: { heldMicros: true },
      })
    )._sum.heldMicros,
    20n,
  );
  activation.enabled = false;
  await assert.rejects(
    controlled.executeControlled({ ...secondRequest, action: "claim" }),
  );
  // Connected controlled core on the same disposable database, a separate fictional
  // account budget, real encrypted phone ledger, and synthetic SDK/Google transport.
  // Phone spend admission is explicitly substituted here; existing phone-cap harness
  // runs separately. This proves no live pricing/consent/release authority.
  activation.enabled = true;
  const {
    DurableVerificationService,
  } = require("../dist/communications/durable-verification.service.js");
  const {
    TwilioVerifyAdapter,
  } = require("../dist/communications/twilio-verify.adapter.js");
  const {
    ConversationMemoryCipher,
  } = require("../dist/logging/conversation-memory-cipher.service.js");
  const {
    GoogleAddressOAuthTransport,
  } = require("../dist/communications/google-address-oauth.transport.js");
  const {
    ControlledIntakeVerificationService,
  } = require("../dist/communications/controlled-intake-verification.service.js");
  const phone = "+12025550123",
    accountSid = "AC" + "a".repeat(32),
    serviceSid = "VA" + "b".repeat(32);
  let syntheticPhoneCalls = 0,
    syntheticAddressCalls = 0;
  const phoneRaw = (status) => ({
    status,
    accountSid,
    serviceSid,
    sid: "VE" + "c".repeat(32),
    to: phone,
    channel: "sms",
  });
  const adapter = new TwilioVerifyAdapter(
    { tenantId: controlledScope.tenantId, accountSid, serviceSid },
    () => ({
      verify: {
        v2: {
          services: () => ({
            verifications: {
              create: async () => {
                syntheticPhoneCalls++;
                return phoneRaw("pending");
              },
            },
            verificationChecks: {
              create: async () => {
                syntheticPhoneCalls++;
                return phoneRaw("approved");
              },
            },
          }),
        },
      },
    }),
  );
  const durable = new DurableVerificationService(
    prisma,
    new ConversationMemoryCipher({
      conversationDataEncryptionKey: "8".repeat(64),
    }),
    credentials,
    Buffer.alloc(32, 8),
    adapter,
    { lock: async () => {}, reserve: async () => {}, check: async () => {} },
    undefined,
    async () => ({
      mode: "CONTROLLED_VERIFY_V1",
      version: "v1",
      accountSid,
      serviceSid,
      noticeVersion: "synthetic",
      businessPolicyVersion: approvedAt,
      lifetimeMs: 1800000,
    }),
  );
  const start = {
    sessionToken: controlledRequest.sessionToken,
    operationId: randomUUID(),
    kind: "START",
    phone,
    code: "",
    startOperationId: "",
  };
  await durable.execute(start);
  await durable.execute({
    ...start,
    operationId: randomUUID(),
    kind: "CHECK",
    code: "123456",
    startOperationId: start.operationId,
  });
  const connectedBinding = {
    intentId: randomUUID(),
    revision: 4,
    policy: { ...controlledPolicy },
  };
  bindings.set(controlledScope.sessionId, connectedBinding);
  const connectedLedger = new AddressOperationLedger(
    prisma,
    credentials,
    undefined,
    {
      ...controlledConfig,
      accountId: randomUUID(),
      capability: authority.issue(),
    },
  );
  const googleBody = {
    responseId: "P03_SENTINEL_NO_STORAGE",
    result: {
      verdict: { addressComplete: true, validationGranularity: "PREMISE" },
      address: {
        postalAddress: {
          regionCode: "US",
          administrativeArea: "OH",
          locality: "Example",
          postalCode: "44101",
          addressLines: ["123 Fictional Street"],
        },
        addressComponents: Object.entries({
          street_number: "123",
          route: "Fictional Street",
          locality: "Example",
          administrative_area_level_1: "Ohio",
          postal_code: "44101",
          country: "United States",
        }).map(([componentType, text]) => ({
          componentType,
          componentName: { text },
          confirmationLevel: "CONFIRMED",
        })),
      },
      uspsData: {
        dpvConfirmation: "Y",
        dpvCmra: "N",
        addressRecordType: "H",
        fipsCountyCode: "035",
        county: "Cuyahoga",
      },
      metadata: { poBox: false },
    },
  };
  const transport = new GoogleAddressOAuthTransport(true, {
    token: async () => "synthetic-not-a-credential",
    fetch: async () => {
      syntheticAddressCalls++;
      return new Response(JSON.stringify(googleBody), {
        headers: { "content-type": "application/json" },
      });
    },
  });
  const verification = new ControlledIntakeVerificationService({
    prisma,
    credentials,
    authority,
    capability: authority.issue(),
    phone: durable,
    ledger: connectedLedger,
    transport,
    readSubmission: async () => ({
      intentId: connectedBinding.intentId,
      revision: connectedBinding.revision,
      submissionDigest: "e".repeat(64),
      policyVersion: "v1",
      organizationApprovedAt: approvedAt,
      phone,
      address: {
        street: "123 Fictional Street",
        city: "Example",
        postalCode: "44101",
        unit: "",
      },
      authorityScope: controlledConfig.scope,
    }),
  });
  const connectedRequest = {
    sessionToken: controlledRequest.sessionToken,
    requestId: randomUUID(),
  };
  let captured;
  assert.deepEqual(
    await verification.run(connectedRequest, (check) =>
      prisma.$transaction(async (tx) => {
        captured = check;
        await check(tx);
        return { noJobWrite: true };
      }),
    ),
    { status: "CONSUMED", value: { noJobWrite: true } },
  );
  await assert.rejects(prisma.$transaction((tx) => captured(tx)));
  assert.deepEqual(
    await verification.run(connectedRequest, () => {
      throw Error("must not replay callback");
    }),
    { status: "UNCERTAIN", jobCreated: false },
  );
  assert.equal(syntheticPhoneCalls, 2);
  assert.equal(syntheticAddressCalls, 1);
  const persisted = JSON.stringify(
    await prisma.conversation.findUnique({
      where: { id: controlledScope.conversationId },
      select: { collectedData: true },
    }),
  );
  const audit = JSON.stringify(
    await prisma.auditLog.findMany({
      where: { tenantId: controlledScope.tenantId },
    }),
  );
  for (const sentinel of [
    "P03_SENTINEL_NO_STORAGE",
    "fipsCountyCode",
    "Cuyahoga",
    "123 Fictional Street",
  ]) {
    assert.ok(!persisted.includes(sentinel));
    assert.ok(!audit.includes(sentinel));
  }
  return {
    checks: [
      "identical intent aliases reserve once",
      "concurrent claim once",
      "restart never reclaims",
      "wrong scope or edited intent refuses",
      "cross-tenant shared ceiling",
      "old-month holds retained",
      "missing stale malformed unapproved policy refuses",
      "reservation and claim audit rollback",
      "safe cancellation releases only unclaimed cost",
      "all three money and request ceilings independently refuse",
      "claim versus cancel race cannot release claimed liability",
      "closed session refuses",
      "no customer or provider payload columns",
      "controlled capability with real ledger locks: concurrent claim once, restart no reclaim, exact observed read",
      "controlled changed policy refuses final observation; two-request cap and unknown liability retained",
      "controlled activation revocation refuses without fake operator context",
      "connected real encrypted CHECK ledger, claimed synthetic Google evaluation and final database transaction; no provider-content persistence or replay",
    ],
    liveProviderCalls: 0,
    dispatchAuthorized: false,
    productionRegistered: false,
  };
}
