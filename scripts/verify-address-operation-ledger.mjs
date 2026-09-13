import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  AddressOperationLedger,
} = require("../dist/communications/address-operation-ledger.js");
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
    ],
    liveProviderCalls: 0,
    dispatchAuthorized: false,
    productionRegistered: false,
  };
}
