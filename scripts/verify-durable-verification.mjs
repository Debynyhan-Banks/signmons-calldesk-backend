import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  DurableVerificationService: Durable,
} = require("../dist/communications/durable-verification.service.js");
const {
  TwilioVerifyAdapter: Adapter,
} = require("../dist/communications/twilio-verify.adapter.js");
export async function verifyDurableVerification({
  prisma,
  cipher,
  credentials,
  responses,
  fixture,
  tenantId,
}) {
  const [db] = await prisma.$queryRawUnsafe(
    "SELECT current_database() AS name, inet_server_addr() AS address",
  );
  assert.match(db.name, /^calldesk_org_[0-9a-f]{12}$/);
  assert.equal(db.address, null);
  const binding = {
    tenantId,
    accountSid: "AC" + "a".repeat(32),
    serviceSid: "VA" + "b".repeat(32),
  };
  const sid = "VE" + "c".repeat(32);
  let starts = 0,
    checks = 0,
    release,
    notify;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const entered = new Promise((resolve) => {
    notify = resolve;
  });
  let block = true,
    scope;
  const provider = new Adapter(binding, () => ({
    verify: {
      v2: {
        services: () => ({
          verifications: {
            create: async ({ to }) => {
              starts++;
              const row = await prisma.conversation.findUnique({
                where: { id: scope.conversationId },
              });
              assert.ok(row.collectedData.verificationOperations);
              assert.equal(
                await prisma.auditLog.count({
                  where: {
                    entityId: scope.conversationId,
                    action: "conversation.verification_reserved",
                  },
                }),
                1,
              );
              notify();
              if (block) await gate;
              return {
                sid,
                accountSid: binding.accountSid,
                serviceSid: binding.serviceSid,
                to,
                channel: "sms",
                status: "pending",
              };
            },
          },
          verificationChecks: {
            create: async ({ verificationSid }) => {
              checks++;
              return {
                sid: verificationSid,
                accountSid: binding.accountSid,
                serviceSid: binding.serviceSid,
                to: "+12025550170",
                channel: "sms",
                status: "approved",
              };
            },
          },
        }),
      },
    },
  }));
  const make = (client = prisma) =>
    new Durable(client, cipher, credentials, Buffer.alloc(32, 8), provider);
  const session = await fixture(() => responses.start());
  scope = credentials.verifySession(session.sessionToken);
  const start = {
    sessionToken: session.sessionToken,
    operationId: randomUUID(),
    kind: "START",
    phone: "+12025550170",
    code: "",
    startOperationId: "",
  };
  const pending = make().execute(start);
  let first;
  try {
    await Promise.race([
      entered,
      pending.then(() => {
        throw Error("Mock was not entered");
      }),
    ]);
    const replay = await make().execute(start);
    assert.equal(replay.state, "UNCONFIRMED");
    assert.equal(replay.usage.sdkInvocations, null);
    assert.equal(starts, 1);
  } finally {
    release();
  }
  first = await pending;
  block = false;
  assert.equal(first.outcome, "PENDING");
  const row = await prisma.conversation.findUnique({
    where: { id: scope.conversationId },
  });
  assert.deepEqual(await make().execute(start), first);
  assert.deepEqual(
    await prisma.conversation.findUnique({
      where: { id: scope.conversationId },
    }),
    row,
  );
  const check = {
    ...start,
    operationId: randomUUID(),
    kind: "CHECK",
    code: "123456",
    startOperationId: start.operationId,
  };
  const verified = await make().execute(check);
  assert.equal(verified.outcome, "APPROVED");
  assert.equal(verified.phoneAccessAuthorized, false);
  assert.deepEqual(await make().execute(check), verified);
  assert.equal(checks, 1);
  await assert.rejects(make().execute({ ...check, code: "000000" }));
  await assert.rejects(make().execute({ ...start, operationId: randomUUID() }));
  const saved = await prisma.conversation.findUnique({
    where: { id: scope.conversationId },
  });
  const ledger = cipher.decrypt(saved.collectedData.verificationOperations);
  assert.ok(!ledger.includes("123456") && !ledger.includes(start.phone));
  const audits = await prisma.auditLog.findMany({
    where: {
      entityId: scope.conversationId,
      action: { startsWith: "conversation.verification_" },
    },
  });
  assert.equal(audits.length, 4);
  assert.ok(!JSON.stringify(audits).includes(start.phone));
  assert.ok(!JSON.stringify(audits).includes("123456"));
  const failing = (action) =>
    new Proxy(prisma, {
      get(target, key) {
        if (key === "$transaction")
          return (fn) =>
            target.$transaction((tx) =>
              fn(
                new Proxy(tx, {
                  get(t, k) {
                    if (k === "auditLog")
                      return new Proxy(t.auditLog, {
                        get(a, p) {
                          if (p === "create")
                            return (args) => {
                              if (args.data.action === action)
                                throw Error("injected audit failure");
                              return a.create(args);
                            };
                          return Reflect.get(a, p);
                        },
                      });
                    return Reflect.get(t, k);
                  },
                }),
              ),
            );
        return Reflect.get(target, key);
      },
    });
  const another = await fixture(() => responses.start());
  scope = credentials.verifySession(another.sessionToken);
  const request = {
    ...start,
    sessionToken: another.sessionToken,
    operationId: randomUUID(),
  };
  const before = await prisma.conversation.findUnique({
    where: { id: scope.conversationId },
  });
  await assert.rejects(
    make(failing("conversation.verification_reserved")).execute(request),
  );
  assert.equal(starts, 1);
  assert.deepEqual(
    await prisma.conversation.findUnique({
      where: { id: scope.conversationId },
    }),
    before,
  );
  const uncertain = await make(
    failing("conversation.verification_observed"),
  ).execute(request);
  assert.equal(uncertain.state, "UNCONFIRMED");
  assert.equal(uncertain.usage.billing, "UNRECONCILED");
  assert.equal(starts, 2);
  assert.deepEqual(await make().execute(request), uncertain);
  assert.equal(starts, 2);
  await assert.rejects(
    make().execute({ ...request, operationId: randomUUID() }),
  );
  const forged = credentials.issueSession({
    tenantId,
    conversationId: scope.conversationId,
    sessionId: randomUUID(),
  });
  await assert.rejects(make().execute({ ...request, sessionToken: forged }));
  return {
    checks: [
      "reservation and audit visible before mocked SDK call outside transaction",
      "concurrent replay while call pending does not invoke again",
      "new service instance replays finalized receipt without writes",
      "check derives stored SID, saved approval does not grant application authority",
      "changed retry and new operation after approval refuse",
      "encrypted ledger and private audit omit phone/code",
      "reservation audit failure rolls back before invocation",
      "finalization audit failure preserves unresolved cost and prevents replay",
      "forged session scope refuses",
    ],
    mockedStartCalls: starts,
    mockedCheckCalls: checks,
    liveProviderCalls: 0,
    productionRegistered: false,
  };
}
