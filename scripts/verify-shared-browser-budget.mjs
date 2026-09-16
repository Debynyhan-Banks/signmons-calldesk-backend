// Called by disposable organization harness only; workers accept guarded local DB names.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const { SharedCustomerBrowserBudget } = require("../dist/communications/shared-customer-browser-budget.js");

if (process.argv[2] === "worker") {
  const [db, user, encoded] = process.argv.slice(3);
  assert.match(db, /^calldesk_org_[0-9a-f]{12}$/);
  const { Pool } = require("pg");
  const { PrismaPg } = require("@prisma/adapter-pg");
  const { PrismaClient } = require("@prisma/client");
  const socket = process.env.ORGANIZATION_SOCKET_DIR ?? "/tmp";
  assert.ok(socket === "/tmp" || /^\/private\/tmp\/signmons-runtime-role-[A-Za-z0-9]+\/socket$/.test(socket));
  const pool = new Pool({ host: socket, database: db, user, max: 1 });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  const lease = await new SharedCustomerBrowserBudget(prisma, JSON.parse(encoded)).acquire("not-a-client-ip", "start");
  // Deliberately never release: models loss of process after durable admission.
  process.send(Boolean(lease), () => process.exit(0));
}

export async function verifySharedBrowserBudget({ prisma, tenantId }) {
  const [db] = await prisma.$queryRawUnsafe("SELECT current_database() AS name, current_user AS username, inet_server_addr() AS address");
  assert.match(db.name, /^calldesk_org_[0-9a-f]{12}$/);
  assert.equal(db.address, null);
  const policy = { packetId: randomUUID(), tenantId, validFrom: Date.now()-1000, validUntil: Date.now()+60000, total: 8, tenant: 8, session: 1, starts: 1, inFlight: 2 };
  const work = () => new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(import.meta.url), ["worker", db.name, db.username, JSON.stringify(policy)], { stdio: ["ignore","ignore","inherit","ipc"] });
    let result;
    child.on("message", value => { result = value; });
    child.on("error", reject);
    child.on("exit", code => code === 0 && typeof result === "boolean" ? resolve(result) : reject(Error("budget worker failed")));
  });
  assert.equal((await Promise.all([work(),work(),work(),work()])).filter(Boolean).length, 1);
  const budget = new SharedCustomerBrowserBudget(prisma, policy);
  assert.equal(await budget.acquire("changed-proxy", "start"), null);
  const lease = await budget.acquire("ignored", "verify");
  assert.ok(lease);
  const session = randomUUID();
  assert.equal(await lease.bindSession(session), true);
  assert.equal(await lease.bindSession(session), true);
  assert.equal(await lease.bindSession(randomUUID()), false);
  // One crashed worker + this request exhaust shared in-flight capacity.
  assert.equal(await new SharedCustomerBrowserBudget(prisma, policy).acquire("ignored", "verify"), null);
  await lease(); await lease();
  const again = await new SharedCustomerBrowserBudget(prisma, policy).acquire("ignored", "verify");
  assert.ok(again);
  assert.equal(await again.bindSession(session), false);
  await again();
  for (let i = 0; i < 5; i++) {
    const remaining = await new SharedCustomerBrowserBudget(prisma, policy).acquire("ignored", "verify");
    assert.ok(remaining);
    await remaining();
  }
  assert.equal(await new SharedCustomerBrowserBudget(prisma, policy).acquire("ignored", "verify"), null);
  assert.equal(await new SharedCustomerBrowserBudget(prisma, { ...policy, total: 9 }).acquire("ignored", "verify"), null);
  const expired = { ...policy, packetId: randomUUID(), validFrom: Date.now()-10000, validUntil: Date.now()-1 };
  assert.equal(await new SharedCustomerBrowserBudget(prisma, expired).acquire("ignored", "verify"), null);
  const rows = await prisma.auditLog.findMany({where: {entityType:"ControlledBrowserBudgetV1", entityId:policy.packetId}});
  assert.equal(rows.filter(r=>r.action==="start").length,1);
  assert.equal(rows.filter(r=>r.action==="release").length,7);
  assert.ok(!JSON.stringify(rows).includes("changed-proxy"));
  return { independentProcesses: 4, successfulStarts: 1, restartLimitsPreserved: true, crashedSlotRetained: true, sessionLimitPreserved: true, policyChangeRefused: true, providerCalls: 0 };
}
