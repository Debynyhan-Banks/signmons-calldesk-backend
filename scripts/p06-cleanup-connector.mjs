// No top-level connection, credentials or executable CLI. The private reviewed entry supplies target/binding.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const hash = (v) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
const bounded = (rows) => {
  assert.ok(rows.length <= 1000);
  return rows;
};
export async function createCleanupConnection({
  prisma,
  binding,
  target,
  close,
}) {
  const {
    VerificationCleanupService,
  } = require("../dist/communications/verification-cleanup.service.js");
  const service = new VerificationCleanupService(
    prisma,
    {
      verifySession() {
        throw Error("CUSTOMER_TOKEN_DISABLED");
      },
    },
    binding,
  );
  const conversations = binding.targets.map((t) => t.conversationId),
    sessions = binding.targets.map((t) => t.sessionId),
    operations = binding.targets.flatMap((t) => t.operations.map((o) => o.id));
  const preflight = async () =>
    prisma.$transaction(async (tx) => {
      const q = (s, ...v) => tx.$queryRawUnsafe(s, ...v);
      const [identity] = await q(
        "SELECT current_database() AS db,current_user AS role,current_setting('server_version_num')::int AS version",
      );
      assert.equal(identity.db, target.database);
      assert.equal(identity.role, target.user);
      assert.ok(identity.version >= 180000 && identity.version < 190000);
      const approvals = await q(
        `SELECT settings#>'{controlledPhoneApproval,enabled}' AS "phoneEnabled",settings#>'{controlledRuntimeApproval,enabled}' AS "runtimeEnabled" FROM "TenantOrganization" WHERE id=$1::uuid`,
        binding.tenantId,
      );
      const role = await q(
        `SELECT rolcanlogin AS "canLogin",rolconnlimit AS "connectionLimit",COALESCE(rolvaliduntil<now(),true) AS expired FROM pg_roles WHERE rolname='p06_intake_runtime'`,
      );
      const active = await q(
        `SELECT count(*)::int AS "sessionCount" FROM pg_stat_activity WHERE usename='p06_intake_runtime'`,
      );
      assert.deepEqual(approvals, [
        { phoneEnabled: false, runtimeEnabled: false },
      ]);
      assert.deepEqual(role, [
        { canLogin: false, connectionLimit: 0, expired: true },
      ]);
      assert.deepEqual(active, [{ sessionCount: 0 }]);
      return {
        targetHash: hash(target),
        postgresMajor: 18,
        ...approvals[0],
        ...role[0],
        ...active[0],
      };
    });
  const snapshot = async () =>
    prisma.$transaction(
      async (tx) => {
        const q = async (s, ...v) => bounded(await tx.$queryRawUnsafe(s, ...v));
        const ops = await q(
          `SELECT id::text,md5(to_jsonb(o)::text) AS hash FROM "AddressVerificationOperation" o WHERE "accountId"=$1::uuid ORDER BY id LIMIT 1001`,
          binding.accountId,
        );
        const aliases = await q(
          `SELECT id::text,md5(to_jsonb(r)::text) AS hash FROM "AddressVerificationRequest" r WHERE "operationId"=ANY($1::uuid[]) ORDER BY id LIMIT 1001`,
          operations,
        );
        const holds = await q(
          `SELECT id::text,md5(to_jsonb(a)::text) AS hash FROM "AuditLog" a WHERE action IN ('conversation.staging_phone_held','conversation.controlled_phone_held') AND metadata->>'accountSid'=$1 ORDER BY id LIMIT 1001`,
          target.phoneAccountSid,
        );
        const jobs = await q(
          `SELECT j.id::text,md5(to_jsonb(j)::text) AS hash FROM "Job" j WHERE j."tenantId"=$1::uuid AND (j."intakeSessionId"=ANY($2::text[]) OR EXISTS(SELECT 1 FROM "ConversationJobLink" l WHERE l."tenantId"=$1::uuid AND l."conversationId"=ANY($3::uuid[]) AND l."jobId"=j.id AND l."jobTenantId"=$1::uuid)) ORDER BY j.id LIMIT 1001`,
          binding.tenantId,
          sessions,
          conversations,
        );
        const links = await q(
          `SELECT id::text,md5(to_jsonb(l)::text) AS hash FROM "ConversationJobLink" l WHERE "tenantId"=$1::uuid AND "conversationId"=ANY($2::uuid[]) ORDER BY id LIMIT 1001`,
          binding.tenantId,
          conversations,
        );
        const events = await q(
          `SELECT id::text,md5(to_jsonb(e)::text) AS hash FROM "CommunicationEvent" e WHERE "tenantId"=$1::uuid AND "conversationTenantId"=$1::uuid AND "conversationId"=ANY($2::uuid[]) ORDER BY id LIMIT 1001`,
          binding.tenantId,
          conversations,
        );
        const content = await q(
          `SELECT cc.id::text,md5(to_jsonb(cc)::text) AS hash,(cc.payload->>'type'='protected_intake_turn_v1' AND cc.payload->'version' IN ('1'::jsonb,'2'::jsonb) AND cc.payload->>'sessionId'=s.sid::text AND NOT EXISTS(SELECT 1 FROM "CommunicationContent" rc JOIN "CommunicationEvent" re ON re.id=rc."communicationEventId" AND re."tenantId"=rc."communicationEventTenantId" WHERE rc."tenantId"=$1::uuid AND re."conversationId"=e."conversationId" AND re."conversationTenantId"=$1::uuid AND rc.payload->>'type'='protected_intake_review_v1') AND NOT EXISTS(SELECT 1 FROM "ConversationJobLink" l WHERE l."tenantId"=$1::uuid AND l."conversationId"=e."conversationId")) IS TRUE AS eligible FROM "CommunicationContent" cc JOIN "CommunicationEvent" e ON e.id=cc."communicationEventId" AND e."tenantId"=cc."communicationEventTenantId" JOIN unnest($2::uuid[],$3::uuid[]) s(cid,sid) ON e."conversationId"=s.cid WHERE cc."tenantId"=$1::uuid AND e."tenantId"=$1::uuid AND e."conversationTenantId"=$1::uuid ORDER BY cc.id LIMIT 1001`,
          binding.tenantId,
          conversations,
          sessions,
        );
        const untouched = await q(
          `SELECT c.id::text,md5(((to_jsonb(c)-'updatedAt'-'collectedData')||jsonb_build_object('collectedData',c."collectedData"-ARRAY['verificationOperations','localPhone','localAddress','verificationLifecycle']))::text) AS hash FROM "Conversation" c WHERE "tenantId"=$1::uuid AND id=ANY($2::uuid[]) ORDER BY id LIMIT 1001`,
          binding.tenantId,
          conversations,
        );
        const audits = await q(
          `SELECT id::text,md5(to_jsonb(a)::text) AS hash FROM "AuditLog" a WHERE "tenantId"=$1::uuid AND "entityId" IN (SELECT unnest($2::text[])) AND (metadata->>'maintenanceOperationId' IS DISTINCT FROM $3) ORDER BY id LIMIT 1001`,
          binding.tenantId,
          [...conversations, ...operations],
          binding.operationId,
        );
        const maintenance = await q(
          `SELECT "entityId",action,"actorType","actorId",metadata->>'sessionId' AS "sessionId",metadata->>'maintenanceApprovalId' AS "approvalId" FROM "AuditLog" WHERE "tenantId"=$1::uuid AND metadata->>'maintenanceOperationId'=$2 ORDER BY "entityId",action LIMIT 7`,
          binding.tenantId,
          binding.operationId,
        );
        const states = await q(
          `SELECT id::text,"collectedData"#>>'{verificationLifecycle,expiresAt}' AS expiry,jsonb_typeof("collectedData"#>'{verificationLifecycle,closedAt}')='number' AS closed,jsonb_typeof("collectedData"#>'{verificationLifecycle,purgedAt}')='number' AS purged,("collectedData" ?| ARRAY['verificationOperations','localPhone','localAddress']) AS "hasVerification" FROM "Conversation" WHERE "tenantId"=$1::uuid AND id=ANY($2::uuid[]) ORDER BY id LIMIT 4`,
          binding.tenantId,
          conversations,
        );
        const retention = await q(
          `SELECT c.id::text,(SELECT count(*)::int FROM "CommunicationContent" cc JOIN "CommunicationEvent" e ON e.id=cc."communicationEventId" AND e."tenantId"=cc."communicationEventTenantId" WHERE cc."tenantId"=$1::uuid AND e."conversationTenantId"=$1::uuid AND e."conversationId"=c.id AND cc.payload->>'type'='protected_intake_review_v1') AS reviews,(SELECT count(*)::int FROM "ConversationJobLink" l WHERE l."tenantId"=$1::uuid AND l."conversationId"=c.id) AS jobs FROM "Conversation" c WHERE c."tenantId"=$1::uuid AND c.id=ANY($2::uuid[]) ORDER BY c.id LIMIT 4`,
          binding.tenantId,
          conversations,
        );
        return {
          ops,
          aliases,
          holds,
          jobs,
          links,
          events,
          content,
          untouched,
          audits,
          maintenance,
          states,
          retention,
        };
      },
      { isolationLevel: "RepeatableRead", timeout: 30000 },
    );
  let before;
  try {
    await preflight();
    await service.inspectMaintenance();
    before = await snapshot();
    assert.equal(before.maintenance.length, 0);
    assert.equal(before.states.length, 3);
    assert.ok(
      before.states.every((s) => s.closed === false && s.purged === false),
    );
    assert.deepEqual(before.retention, target.expectedRetention);
  } catch {
    await close();
    throw Error("CLEANUP_PREFLIGHT_REFUSED");
  }
  const verifyUnchangedAndClosed = async () => {
    const after = await snapshot();
    for (const key of [
      "ops",
      "aliases",
      "holds",
      "jobs",
      "links",
      "events",
      "untouched",
      "audits",
      "retention",
    ])
      assert.deepEqual(after[key], before[key]);
    assert.deepEqual(
      after.content,
      before.content.filter((c) => !c.eligible),
    );
    assert.equal(after.states.length, 3);
    for (const s of after.states) {
      const t = binding.targets.find((t) => t.conversationId === s.id);
      assert.ok(t);
      assert.equal(s.expiry, String(t.expiresAt));
      assert.equal(s.closed, true);
      assert.equal(s.purged, true);
      assert.equal(s.hasVerification, false);
    }
    const expected = binding.targets
      .flatMap((t) =>
        ["closed", "purged"].map((state) => ({
          entityId: t.conversationId,
          action: "conversation.verification_session_" + state,
          actorType: "SYSTEM_AI",
          actorId: "controlled-session-maintenance",
          sessionId: t.sessionId,
          approvalId: binding.approvalId,
        })),
      )
      .sort(
        (a, b) =>
          a.entityId.localeCompare(b.entityId) ||
          a.action.localeCompare(b.action),
      );
    assert.deepEqual(after.maintenance, expected);
    return {
      closed: 3,
      purged: 3,
      jobsUnchanged: true,
      holdsUnchanged: true,
      operationsUnchanged: true,
      aliasesUnchanged: true,
      businessRecordsPreserved: true,
    };
  };
  return { service, preflight, verifyUnchangedAndClosed, close };
}
export async function connectCleanup({ password, target, binding }) {
  assert.equal(target.port, 5432);
  assert.equal(target.user, "neondb_owner");
  assert.equal(typeof target.host, "string");
  assert.ok(!target.host.startsWith("/"));
  const { Pool } = require("pg");
  const { PrismaClient } = require("@prisma/client");
  const { PrismaPg } = require("@prisma/adapter-pg");
  const pool = new Pool({
    host: target.host,
    port: target.port,
    database: target.database,
    user: target.user,
    password,
    ssl: { rejectUnauthorized: true },
    max: 1,
    connectionTimeoutMillis: 5000,
    query_timeout: 12000,
    options: "-c statement_timeout=10s -c lock_timeout=5s",
    application_name: "signmons_exact_session_cleanup",
  });
  pool.on("error", () => {});
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool), log: [] });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await prisma.$disconnect();
    } finally {
      await pool.end();
    }
  };
  try {
    return await createCleanupConnection({ prisma, binding, target, close });
  } catch {
    await close();
    throw Error("CLEANUP_CONNECTION_REFUSED");
  }
}
