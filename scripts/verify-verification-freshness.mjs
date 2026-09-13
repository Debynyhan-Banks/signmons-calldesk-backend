// Parent-owned disposable PostgreSQL only. No provider network clients.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { localCorrectionPort } from "./local-correction-port.mjs";
const require = createRequire(import.meta.url);
const {
  DurableVerificationService,
} = require("../dist/communications/durable-verification.service.js");
const {
  VerificationBudgetAdmission,
} = require("../dist/communications/verification-budget-admission.js");
const {
  requestContextMiddleware,
  setAuthContext,
} = require("../dist/common/context/request-context.js");

export async function verifyVerificationFreshness({
  prisma,
  cipher,
  credentials,
  responses,
}) {
  const [db] = await prisma.$queryRawUnsafe(
    "SELECT current_database() AS name, inet_server_addr() AS address",
  );
  assert.match(db.name, /^calldesk_org_[0-9a-f]{12}$/);
  assert.equal(db.address, null);
  const tenant = await prisma.tenantOrganization.create({
    data: { name: "Fictional 1A freshness", timezone: "UTC", settings: {} },
  });
  const tenantId = tenant.id;
  const fixture = (fn) =>
    new Promise((resolve, reject) =>
      requestContextMiddleware({ headers: {} }, {}, () => {
        setAuthContext({
          tenantId,
          userId: "integration:freshness-fixture",
          role: "webchat_integration",
        });
        Promise.resolve().then(fn).then(resolve, reject);
      }),
    );
  const original = {
    mode: "FIXTURE_ONLY",
    version: "1A",
    lifetimeMs: 1800000,
    noticeVersion: "fixture-v1",
    sourceVersion: "mock",
    businessPolicyVersion: "approved-v1",
  };
  let policy = original,
    calls = 0,
    onCheck = async () => {};
  const result = (input, kind) => ({
    operationId: input.operationId,
    outcome: kind === "START" ? "PENDING" : "APPROVED",
    verificationSid: "VE" + "a".repeat(32),
    usage: { operation: kind, sdkInvocations: 1, billing: "UNRECONCILED" },
    phoneAccessAuthorized: false,
    bookingAuthorized: false,
    deliveryAuthorized: false,
  });
  const adapter = {
    start: async (input) => {
      calls++;
      return result(input, "START");
    },
    check: async (input) => {
      calls++;
      await onCheck();
      return result(input, "CHECK");
    },
  };
  const budget = new VerificationBudgetAdmission({
    mode: "FIXTURE_ONLY",
    tenantId,
    noticeVersion: "fixture-v1",
    noticeText:
      "Request a test code. Standard message and data rates may apply",
    termsUrl: "https://example.test/terms",
    privacyUrl: "https://example.test/privacy",
    rateVersion: "fictional",
    flowUpperBoundUsdMicros: 10,
  });
  const make = (client = prisma) =>
    new DurableVerificationService(
      client,
      cipher,
      credentials,
      Buffer.alloc(32, 4),
      adapter,
      budget,
      async () => policy,
    );
  const service = make();
  async function begin(approve = true) {
    const { sessionToken } = await fixture(() => responses.start());
    const start = {
      sessionToken,
      phone: "+12025550123",
      operationId: randomUUID(),
      kind: "START",
      code: "",
      startOperationId: "",
    };
    await fixture(() =>
      service.execute(start, { requested: true, noticeVersion: "fixture-v1" }),
    );
    const check = {
      ...start,
      kind: "CHECK",
      operationId: randomUUID(),
      code: "123456",
      startOperationId: start.operationId,
    };
    if (approve) await fixture(() => service.execute(check));
    return {
      sessionToken,
      check,
      scope: credentials.verifySession(sessionToken),
      args: { sessionToken, phone: start.phone, revoke: false },
    };
  }
  const status = (test, client = service) =>
    fixture(() => client.freshness(test.args));
  async function changeProof(test, fn) {
    const row = await prisma.conversation.findUnique({
      where: { id: test.scope.conversationId },
    });
    const ledger = JSON.parse(
      cipher.decrypt(row.collectedData.verificationOperations),
    );
    fn(ledger.entries.find((e) => e.kind === "CHECK"));
    await prisma.conversation.update({
      where: { id: row.id },
      data: {
        collectedData: {
          ...row.collectedData,
          verificationOperations: cipher.encrypt(JSON.stringify(ledger)),
        },
      },
    });
  }
  const a = await begin();
  const first = await status(a);
  assert.equal(first.state, "CURRENT");
  assert.equal(first.expiresAt, a.scope.expiresAt); // Existing fifteen-minute session wins over thirty-minute ceiling.
  const before = calls;
  await fixture(() => service.execute(a.check));
  assert.deepEqual(await status(a, make()), first);
  assert.equal(calls, before);
  assert.equal(
    (
      await fixture(() =>
        service.freshness({ ...a.args, phone: "+12025550124" }),
      )
    ).state,
    "NOT_CURRENT",
  );
  assert.deepEqual(await status(a), first);
  const other = await begin();
  const correction = localCorrectionPort({
    prisma,
    credentials,
    readPolicy: async () => policy,
    adapter: {
      preview: async () => ({
        candidate: {
          addressLines: ["123 Fictional Street"],
          locality: "Example",
          administrativeArea: "OH",
          postalCode: "44101",
          regionCode: "US",
        },
      }),
    },
  });
  const propose = {
    sessionToken: a.sessionToken,
    action: "propose",
    requestId: randomUUID(),
    candidateId: "",
    confirmed: false,
    revision: 0,
    input: {
      street: "123 Fictional St",
      city: "Example",
      postalCode: "44101",
      unit: "",
    },
  };
  const candidate = await fixture(() => correction.handle(propose));
  assert.equal(candidate.status, "CONFIRMATION_REQUIRED");
  const confirm = {
    ...propose,
    action: "confirm",
    requestId: "",
    candidateId: candidate.candidateId,
    revision: candidate.revision,
    confirmed: true,
  };
  assert.equal(
    (await fixture(() => correction.handle(confirm))).status,
    "CUSTOMER_CONFIRMED",
  );
  assert.deepEqual(await status(a), first); // Address validation did not revoke phone.
  await fixture(() => service.freshness({ ...other.args, revoke: true }));
  assert.deepEqual(await status(a), first); // Session isolation.
  await fixture(() => service.freshness({ ...a.args, revoke: true }));
  assert.equal(
    (await fixture(() => correction.handle(confirm))).status,
    "CUSTOMER_CONFIRMED",
  ); // Phone edit cannot revoke unchanged address.
  const addressHold = await prisma.addressVerificationOperation.findFirst({
    where: { sessionId: a.scope.sessionId },
  });
  assert.equal(addressHold.heldMicros, 10n);
  correction.clear();
  await fixture(() => service.execute(a.check));
  assert.equal((await status(a)).state, "NOT_CURRENT"); // Exact replay cannot renew revoked proof.
  const expired = await begin();
  await changeProof(expired, (e) => {
    e.proof.checkedAt = Date.now() - 1800001;
    e.proof.confirmedAt = e.proof.checkedAt;
    e.proof.expiresAt = e.proof.checkedAt + 1800000;
  });
  assert.equal((await status(expired)).state, "NOT_CURRENT");
  const legacy = await begin();
  await changeProof(legacy, (e) => {
    delete e.proof;
  });
  await fixture(() => service.execute(legacy.check));
  assert.equal((await status(legacy)).state, "NOT_CURRENT");
  const changed = await begin();
  policy = { ...original, businessPolicyVersion: "new-approval" };
  assert.equal((await status(changed)).state, "NOT_CURRENT");
  policy = original;
  assert.equal((await status(changed)).state, "NOT_CURRENT");
  const missing = await begin();
  policy = null;
  assert.equal((await status(missing)).state, "NOT_CURRENT");
  policy = original;
  const rollback = await begin();
  const fail = make({
    $transaction: (fn) =>
      prisma.$transaction((tx) =>
        fn(
          new Proxy(tx, {
            get(target, key) {
              if (key === "auditLog")
                return {
                  ...target.auditLog,
                  create: async () => {
                    throw Error("fictional audit failure");
                  },
                };
              const value = target[key];
              return typeof value === "function" ? value.bind(target) : value;
            },
          }),
        ),
      ),
  });
  await assert.rejects(
    fixture(() => fail.freshness({ ...rollback.args, revoke: true })),
  );
  assert.equal((await status(rollback)).state, "CURRENT");
  // Revoke wins while CHECK is in flight; result may be observed but cannot mint proof.
  const race = await begin(false);
  let release, entered;
  const gate = new Promise((r) => {
    release = r;
  });
  const signal = new Promise((r) => {
    entered = r;
  });
  onCheck = async () => {
    entered();
    await gate;
  };
  const checking = fixture(() => service.execute(race.check));
  await signal;
  await fixture(() => service.freshness({ ...race.args, revoke: true }));
  release();
  await checking;
  onCheck = async () => {};
  assert.equal((await status(race)).state, "NOT_CURRENT");
  // A changed policy during provider I/O refuses proof even with a successful observed result.
  const policyRace = await begin(false);
  onCheck = async () => {
    policy = { ...original, noticeVersion: "new-notice" };
  };
  await fixture(() => service.execute(policyRace.check));
  onCheck = async () => {};
  policy = original;
  assert.equal((await status(policyRace)).state, "NOT_CURRENT");
  const between = await begin(false);
  const betweenCalls = calls;
  policy = { ...original, sourceVersion: "changed-before-check" };
  await assert.rejects(fixture(() => service.execute(between.check)));
  assert.equal(calls, betweenCalls);
  policy = original;
  const closed = await begin();
  const forged = credentials.issueSession({
    tenantId: randomUUID(),
    conversationId: closed.scope.conversationId,
    sessionId: closed.scope.sessionId,
  });
  await assert.rejects(
    fixture(() => service.freshness({ ...closed.args, sessionToken: forged })),
  );
  await prisma.conversation.update({
    where: { id: closed.scope.conversationId },
    data: { status: "COMPLETED" },
  });
  await assert.rejects(status(closed));
  const noPolicyCalls = calls;
  policy = null;
  await assert.rejects(begin());
  policy = original;
  assert.equal(calls, noPolicyCalls);
  const holds = await prisma.auditLog.findMany({
    where: { tenantId, action: "conversation.verification_budget_reserved" },
  });
  assert.equal(holds.length, 11);
  assert.equal(
    holds.reduce((n, r) => n + r.metadata.reservedMicros, 0),
    110,
  );
  assert.equal(await prisma.job.count({ where: { tenantId } }), 0);
  return {
    checks: [
      "thirty-minute proof capped by existing session",
      "read and exact replay/reconstruction do not renew or call provider",
      "phone and session isolation",
      "address confirmation survives phone revocation; phone proof survives address validation",
      "revocation survives successful receipt replay",
      "expired and legacy proof refused",
      "policy change/missing policy invalidation",
      "real audit rollback",
      "in-flight CHECK revocation race",
      "notice change during provider I/O",
      "source or notice policy cannot change between START and CHECK",
      "closed session refuses and all cost holds remain",
      "foreign tenant refuses; missing policy rolls back before dispatch or reservation",
    ],
    mockedCalls: calls,
    heldMicros: 110,
    liveProviderCalls: 0,
    newJobs: 0,
    productionRegistered: false,
  };
}
