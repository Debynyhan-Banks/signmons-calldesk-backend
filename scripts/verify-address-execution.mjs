import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  AddressOperationLedger,
} = require("../dist/communications/address-operation-ledger.js");
const {
  AddressOperationExecutor,
} = require("../dist/communications/address-operation-executor.js");
const {
  requestContextMiddleware,
  setAuthContext,
} = require("../dist/common/context/request-context.js");
export async function verifyAddressExecution({
  prisma,
  credentials,
  responses,
}) {
  const [db] = await prisma.$queryRawUnsafe(
    "SELECT current_database() AS name, inet_server_addr() AS address",
  );
  assert.match(db.name, /^calldesk_org_[0-9a-f]{12}$/);
  assert.equal(db.address, null);
  const tenant = await prisma.tenantOrganization.create({
    data: { name: "Fictional VO2", timezone: "UTC", settings: {} },
  });
  const context = (
    fn,
    role = "webchat_integration",
    userId = "integration:vo2",
    tenantId = tenant.id,
  ) =>
    new Promise((resolve, reject) =>
      requestContextMiddleware({ headers: {} }, {}, () => {
        setAuthContext({ tenantId, userId, role });
        Promise.resolve().then(fn).then(resolve, reject);
      }),
    );
  const { sessionToken } = await context(() => responses.start());
  const scope = credentials.verifySession(sessionToken);
  const policy = {
    mode: "FIXTURE_ONLY",
    approved: true,
    version: "vo2-local",
    rateVersion: "fictional-not-a-price",
    validUntil: Date.now() + 3600000,
    costMicros: 10,
    account: { micros: 100, requests: 10 },
    tenant: { micros: 100, requests: 10 },
    session: { micros: 100, requests: 10 },
    execution: "VO2_FIXTURE_8S_3_ATTEMPTS_30S",
  };
  let binding = { intentId: randomUUID(), revision: 1, policy };
  const accountId = randomUUID(),
    evidenceId = randomUUID(),
    owner = randomUUID();
  let evidence = null;
  const factory = (database = prisma, account = accountId) =>
    new AddressOperationLedger(database, credentials, {
      accountId: account,
      readBinding: async () => binding,
      recoveryEvidence: async (_tx, id) =>
        id === evidenceId ? evidence : null,
    });
  const ledger = factory(),
    executor = new AddressOperationExecutor(ledger);
  const input = { sessionToken, requestId: randomUUID() };
  let calls = 0;
  const run = async () => {
    calls++;
    return { candidate: "mock" };
  };
  // Mock executes after account lock has been committed/released.
  const first = await context(() =>
    executor.run(input, {
      mode: "FIXTURE_ONLY",
      run: async () => {
        const lock = await prisma.$transaction((tx) =>
          tx.$queryRawUnsafe(
            "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS free",
            "address-account:" + accountId,
          ),
        );
        assert.equal(lock[0].free, true);
        return run();
      },
    }),
  );
  assert.equal(
    first.status,
    "OBSERVED",
    JSON.stringify({
      calls,
      now: Date.now(),
      rows: (
        await prisma.addressVerificationOperation.findMany({
          where: { accountId },
        })
      ).map((r) => ({ state: r.state, deadline: r.executionDeadline })),
    }),
  );
  assert.equal(
    (
      await context(() =>
        new AddressOperationExecutor(factory()).run(input, {
          mode: "FIXTURE_ONLY",
          run,
        }),
      )
    ).status,
    "UNCERTAIN",
  );
  assert.equal(calls, 1);
  binding = { ...binding, intentId: randomUUID(), revision: 2 };
  const second = { sessionToken, requestId: randomUUID() };
  assert.equal(
    (await context(() => executor.run(second, { mode: "FIXTURE_ONLY", run })))
      .status,
    "UNCERTAIN",
  );
  assert.equal(calls, 1);
  assert.equal(
    await prisma.addressVerificationOperation.count({ where: { accountId } }),
    1,
  );
  await prisma.addressVerificationOperation.updateMany({
    where: { accountId },
    data: { createdAt: new Date(Date.now() - 31000) },
  });
  assert.equal(
    (
      await context(() =>
        executor.run(second, {
          mode: "FIXTURE_ONLY",
          run: async () => {
            calls++;
            throw Error("lost provider result");
          },
        }),
      )
    ).status,
    "UNCERTAIN",
  );
  assert.equal(
    (await context(() => executor.run(second, { mode: "FIXTURE_ONLY", run })))
      .status,
    "UNCERTAIN",
  );
  assert.equal(calls, 2);
  await prisma.addressVerificationOperation.updateMany({
    where: { accountId },
    data: { createdAt: new Date(Date.now() - 31000) },
  });
  binding = { ...binding, intentId: randomUUID(), revision: 3 };
  const third = { sessionToken, requestId: randomUUID() };
  await context(() => ledger.execute({ ...third, action: "reserve" }));
  const claim = await context(() =>
    ledger.execute({ ...third, action: "claim" }),
  );
  assert.ok(
    claim.executionDeadline > Date.now() &&
      claim.executionDeadline <= Date.now() + 8000,
  );
  assert.equal(
    (
      await context(() =>
        new AddressOperationExecutor(factory()).run(third, {
          mode: "FIXTURE_ONLY",
          run,
        }),
      )
    ).status,
    "UNCERTAIN",
  );
  assert.equal(calls, 2);
  await prisma.addressVerificationOperation.updateMany({
    where: { accountId },
    data: { createdAt: new Date(Date.now() - 31000) },
  });
  binding = { ...binding, intentId: randomUUID(), revision: 4 };
  assert.equal(
    (
      await context(() =>
        executor.run(
          { sessionToken, requestId: randomUUID() },
          { mode: "FIXTURE_ONLY", run },
        ),
      )
    ).status,
    "UNCERTAIN",
  );
  assert.equal(calls, 2);
  assert.equal(
    (
      await prisma.addressVerificationOperation.aggregate({
        where: { accountId },
        _sum: { heldMicros: true },
      })
    )._sum.heldMicros,
    30n,
  );
  evidence = {
    operationId: claim.operationId,
    attemptId: claim.attemptId,
    decision: "RETAIN_LIABILITY",
  };
  const recovery = {
    operationId: claim.operationId,
    attemptId: claim.attemptId,
    evidenceId,
  };
  await assert.rejects(context(() => ledger.recover(recovery), "owner", owner)); // still within deadline
  await prisma.addressVerificationOperation.update({
    where: { id: claim.operationId },
    data: { executionDeadline: new Date(Date.now() - 1) },
  });
  await assert.rejects(context(() => ledger.recover(recovery))); // customer integration not operator
  await assert.rejects(
    context(
      () => ledger.recover({ ...recovery, evidenceId: randomUUID() }),
      "owner",
      owner,
    ),
  );
  await assert.rejects(
    context(
      () => ledger.recover({ ...recovery, attemptId: randomUUID() }),
      "owner",
      owner,
    ),
  );
  await assert.rejects(
    context(() => ledger.recover(recovery), "owner", owner, randomUUID()),
  );
  const recoveryFault = {
    $transaction: (fn) =>
      prisma.$transaction((tx) =>
        fn(
          new Proxy(tx, {
            get(target, key) {
              if (key === "auditLog")
                return {
                  ...target.auditLog,
                  create: () => {
                    throw Error("synthetic recovery audit fault");
                  },
                };
              const value = target[key];
              return typeof value === "function" ? value.bind(target) : value;
            },
          }),
        ),
      ),
  };
  await assert.rejects(
    context(() => factory(recoveryFault).recover(recovery), "owner", owner),
  );
  assert.equal(
    (
      await prisma.addressVerificationOperation.findUnique({
        where: { id: claim.operationId },
      })
    ).state,
    "DISPATCH_CLAIMED",
  );
  const recovered = await Promise.all([
    context(() => ledger.recover(recovery), "owner", owner),
    context(() => ledger.recover(recovery), "owner", owner),
  ]);
  assert.ok(recovered.every((r) => r.liabilityRetained));
  assert.equal(
    await prisma.auditLog.count({
      where: {
        tenantId: tenant.id,
        action: "conversation.address_operation_recovered",
      },
    }),
    1,
  );
  assert.equal(
    (
      await prisma.addressVerificationOperation.findUnique({
        where: { id: claim.operationId },
      })
    ).heldMicros,
    10n,
  );
  // Fresh independent account: a DB deadline crossed during mock execution cannot publish.
  const lateAccount = randomUUID(),
    lateLedger = factory(prisma, lateAccount);
  const lateInput = { sessionToken, requestId: randomUUID() };
  const late = await context(() =>
    new AddressOperationExecutor(lateLedger).run(lateInput, {
      mode: "FIXTURE_ONLY",
      run: async () => {
        await prisma.addressVerificationOperation.updateMany({
          where: { accountId: lateAccount },
          data: { executionDeadline: new Date(Date.now() - 1) },
        });
        return "late";
      },
    }),
  );
  assert.equal(late.status, "UNCERTAIN");
  assert.equal(
    (
      await prisma.addressVerificationOperation.findFirst({
        where: { accountId: lateAccount },
      })
    ).state,
    "UNCERTAIN",
  );
  // Persist/audit fault after mock work leaves the claim and potential cost intact.
  const failedAccount = randomUUID();
  const broken = {
    $transaction: (fn) =>
      prisma.$transaction((tx) =>
        fn(
          new Proxy(tx, {
            get(target, key) {
              if (key === "auditLog")
                return {
                  ...target.auditLog,
                  create: (args) => {
                    if (
                      args.data.action ===
                      "conversation.address_operation_observed"
                    )
                      throw Error("synthetic result audit fault");
                    return target.auditLog.create(args);
                  },
                };
              const value = target[key];
              return typeof value === "function" ? value.bind(target) : value;
            },
          }),
        ),
      ),
  };
  const failedInput = { sessionToken, requestId: randomUUID() };
  const failed = await context(() =>
    new AddressOperationExecutor(factory(broken, failedAccount)).run(
      failedInput,
      { mode: "FIXTURE_ONLY", run },
    ),
  );
  assert.equal(failed.status, "UNCERTAIN");
  const failedRow = await prisma.addressVerificationOperation.findFirst({
    where: { accountId: failedAccount },
  });
  assert.equal(failedRow.state, "DISPATCH_CLAIMED");
  assert.equal(failedRow.heldMicros, 10n);
  const before = calls;
  await context(() =>
    new AddressOperationExecutor(factory(prisma, failedAccount)).run(
      failedInput,
      { mode: "FIXTURE_ONLY", run },
    ),
  );
  assert.equal(calls, before);
  return {
    checks: [
      "mock outside account transaction",
      "observed replay never dispatches again",
      "30 second cooldown before new intent",
      "three attempt cap despite higher money limits",
      "unknown result preserves liability and exact retry",
      "orphan claim survives service reconstruction",
      "late result refused",
      "result audit failure retains claim",
      "owner evidence scope and expected attempt required",
      "concurrent recovery audited once with no refund",
      "recovery audit failure rolls back state",
    ],
    liveProviderCalls: 0,
    productionRegistered: false,
    dispatchAuthorized: false,
  };
}
