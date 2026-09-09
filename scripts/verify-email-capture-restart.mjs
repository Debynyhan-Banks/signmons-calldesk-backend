// Fresh-process proof against only the parent's named disposable Unix-socket DB.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { userInfo } from "node:os";
const require = createRequire(import.meta.url);
const [database, tenantId, conversationId, sessionId] = process.argv.slice(2);
assert.match(database, /^calldesk_app013_intents_[0-9a-f]{12}$/);
for (const value of [tenantId, conversationId])
  assert.match(value, /^[0-9a-f-]{36}$/);
assert.match(sessionId, /^email-[0-9a-f-]{36}$/);
const { Pool } = require("pg"),
  { PrismaPg } = require("@prisma/adapter-pg"),
  { PrismaClient } = require("@prisma/client");
const pool = new Pool({
  host: "/tmp",
  port: 5432,
  user: userInfo().username,
  database,
});
const prisma = new PrismaClient({
  adapter: new PrismaPg(pool, { schema: "public" }),
});
try {
  const [db] = await prisma.$queryRawUnsafe(
    "SELECT current_database() AS name, inet_server_addr() AS address",
  );
  assert.equal(db.name, database);
  assert.equal(db.address, null);
  const {
      ConversationEmailService,
    } = require("../dist/conversations/conversation-email.service.js"),
    {
      ConversationMemoryCipher,
    } = require("../dist/logging/conversation-memory-cipher.service.js");
  const service = new ConversationEmailService(
    prisma,
    new ConversationMemoryCipher({
      conversationDataEncryptionKey: "2".repeat(64),
    }),
  );
  const scope = { tenantId, conversationId, sessionId };
  assert.equal((await service.observe(scope, "Continue")).status, "captured");
  assert.equal(await service.requestOnce(scope), false);
  console.log("Fresh process retained capture without another email question.");
} finally {
  await prisma.$disconnect();
  if (!pool.ended) await pool.end();
}
