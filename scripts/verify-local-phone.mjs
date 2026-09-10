// Disposable local database proof only; no network provider or production identity.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  LocalCustomerPhoneService: Phone,
} = require("../dist/communications/local-customer-phone.service.js");
export async function verifyLocalPhone({
  prisma,
  cipher,
  credentials,
  responses,
  fixture,
}) {
  const [db] = await prisma.$queryRawUnsafe(
    "SELECT current_database() AS name, inet_server_addr() AS address",
  );
  assert.match(db.name, /^calldesk_org_[0-9a-f]{12}$/);
  assert.equal(db.address, null);
  let time = Date.now();
  const make = (client = prisma) =>
    new Phone(client, cipher, credentials, Buffer.alloc(32, 7), () => time);
  let service = make();
  const { sessionToken } = await fixture(() => responses.start());
  const scope = credentials.verifySession(sessionToken);
  const command = (
    action = "request",
    expectedRevision = 0,
    phone = "+12025550180",
    code = "",
  ) => ({
    sessionToken,
    action,
    expectedRevision,
    phone,
    code,
    operationId: randomUUID(),
  });
  const read = () =>
    prisma.conversation.findUnique({ where: { id: scope.conversationId } });
  const first = command();
  const race = await Promise.all([
    service.handle(first),
    service.handle(first),
  ]);
  assert.deepEqual(race[0], race[1]);
  assert.equal(
    await prisma.auditLog.count({
      where: {
        entityId: scope.conversationId,
        action: "conversation.local_phone_requested",
      },
    }),
    1,
  );
  const before = await read();
  service = make(); // new instance, no in-memory challenge state
  assert.deepEqual(await service.handle(first), race[0]);
  assert.deepEqual(await read(), before);
  await assert.rejects(service.handle({ ...first, phone: "+12025550181" }));
  const good = command("check", 1, "+12025550180", "123456");
  const verified = await service.handle(good);
  assert.equal(verified.state, "FIXTURE_VERIFIED");
  assert.equal(verified.phoneAccessAuthorized, false);
  assert.deepEqual(await service.handle(good), verified);
  const afterGood = await read();
  assert.equal(typeof afterGood.collectedData.localPhone, "string");
  assert.ok(!JSON.stringify(afterGood.collectedData).includes("+12025550180"));
  const audit = await prisma.auditLog.findMany({
    where: { entityId: scope.conversationId },
  });
  assert.ok(!JSON.stringify(audit).includes("123456"));
  assert.ok(!JSON.stringify(audit).includes("+12025550180"));
  const failing = new Proxy(prisma, {
    get(target, key) {
      if (key === "$transaction")
        return (fn) =>
          target.$transaction((tx) =>
            fn(
              new Proxy(tx, {
                get(t, k) {
                  return k === "auditLog"
                    ? {
                        ...t.auditLog,
                        create: async () => {
                          throw Error("injected audit failure");
                        },
                      }
                    : Reflect.get(t, k);
                },
              }),
            ),
          );
      return Reflect.get(target, key);
    },
  });
  await assert.rejects(make(failing).handle(command("clear", 2, "")));
  assert.deepEqual(await read(), afterGood);
  await service.handle(command("clear", 2, ""));
  await assert.rejects(service.handle(good));
  assert.equal((await service.handle(command("status", 0, ""))).state, "EMPTY");
  // Separate sessions share durable per-destination request budget.
  const otherTokens = [];
  for (let n = 0; n < 2; n++) {
    const other = await fixture(() => responses.start());
    otherTokens.push(other.sessionToken);
    await make().handle({ ...command(), sessionToken: other.sessionToken });
  }
  const third = await fixture(() => responses.start());
  await assert.rejects(
    make().handle({ ...command(), sessionToken: third.sessionToken }),
    (e) => e.getStatus() === 429,
  );
  // A credential for another session cannot adopt this conversation.
  for (let n = 1; n <= 4; n++) {
    await make().handle({
      ...command("check", n, "+12025550180", "000000"),
      sessionToken: otherTokens[0],
    });
  }
  await assert.rejects(
    make().handle({
      ...command("check", 1, "+12025550180", "123456"),
      sessionToken: otherTokens[1],
    }),
    (e) => e.getStatus() === 429,
  );
  await assert.rejects(
    make().handle(command("request", 3, "+12025550181")),
    (e) => e.getStatus() === 429,
  );
  time += 30001;
  assert.equal(
    (await make().handle(command("request", 3, "+12025550181"))).state,
    "PENDING",
  );
  time += 300001;
  await assert.rejects(
    make().handle(command("check", 4, "+12025550181", "123456")),
  );
  const forged = credentials.issueSession({
    tenantId: scope.tenantId,
    conversationId: scope.conversationId,
    sessionId: randomUUID(),
  });
  await assert.rejects(make().handle({ ...command(), sessionToken: forged }));
  return {
    checks: [
      "concurrent request/exact retry writes once",
      "new service instance restores encrypted state",
      "changed retry refused",
      "fixture success never grants phone authority",
      "real audit failure rolls back",
      "explicit correction revokes proof",
      "cross-session destination limit persists",
      "cross-session attempt budget persists",
      "cooldown then corrected-number request; expired code refused",
      "forged session scope refuses",
    ],
  };
}
