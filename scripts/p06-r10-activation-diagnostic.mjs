// Read-only APP-013/P06/R10 activation diagnostic. Importing never connects.
// Live use requires a separately approved private-password wrapper.
import assert from "node:assert/strict";
import { createHash, timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { TARGET } from "./p06-backup-once.mjs";
import { manifest } from "./p06-migrate-once.mjs";
import { reviewPacket } from "./p06-runtime-packet.mjs";

const require = createRequire(import.meta.url);
const { Client } = require("pg");
const {
  ORGANIZATION_PROFILE,
  object,
  profile: organizationProfile,
} = require("../dist/tenants/organization-profile.js");
const {
  ORGANIZATION_PAYMENT_POLICY,
  profile: paymentProfile,
} = require("../dist/tenants/organization-payment-policy.js");

const uuid = (value) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
const digest = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const sameDigest = (left, right) => {
  if (!digest(left) || !digest(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
};
const result = (outcome, stage) =>
  Object.freeze({ status: "ACTIVATION_DIAGNOSTIC", outcome, stage });
const fail = (stage) => result("FAIL", stage);

function inactiveApproval(value) {
  return (
    value === null ||
    (object(value) &&
      value.enabled === false &&
      digest(value.digest) &&
      Object.keys(value).sort().join() === "digest,enabled")
  );
}

/** Pure classifier. It emits only a bounded stage and never returns row data. */
export async function classifyActivationSnapshot(
  packet,
  operationId,
  attemptedAt,
  snapshot,
) {
  let reviewed;
  try {
    reviewed = reviewPacket(packet);
  } catch {
    return fail("PACKET");
  }
  const attemptedMs = Date.parse(attemptedAt);
  if (
    !uuid(operationId) ||
    !Number.isSafeInteger(attemptedMs) ||
    new Date(attemptedMs).toISOString() !== attemptedAt
  )
    return fail("ATTEMPT_BINDING");
  if (!object(snapshot)) return fail("SNAPSHOT");
  const identity = object(snapshot.identity);
  if (
    !identity ||
    identity.name !== TARGET.database ||
    identity.role !== "neondb_owner" ||
    !Number.isInteger(identity.version) ||
    identity.version < 180000 ||
    identity.version >= 190000
  )
    return fail("DATABASE_IDENTITY");

  let files;
  try {
    files = await manifest();
  } catch {
    return fail("LOCAL_MIGRATION_MANIFEST");
  }
  if (
    !Array.isArray(snapshot.migrations) ||
    snapshot.migrations.length !== files.length
  )
    return fail("MIGRATION_HISTORY");
  for (let index = 0; index < files.length; index++) {
    const row = object(snapshot.migrations[index]);
    if (
      !row ||
      row.migration_name !== files[index].name ||
      !sameDigest(row.checksum, files[index].sha256) ||
      !row.finished_at ||
      row.rolled_back_at !== null
    )
      return fail("MIGRATION_HISTORY");
  }

  if (!object(snapshot.tenant)) return fail("TENANT_PRESENT");
  const tenant = snapshot.tenant;
  if (tenant.id !== reviewed.config.activation.tenantId)
    return fail("TENANT_BINDING");
  if (tenant.status !== "ACTIVE") return fail("TENANT_STATUS");
  const settings = object(tenant.settings);
  if (!settings) return fail("TENANT_SETTINGS");
  if (
    !inactiveApproval(settings.controlledRuntimeApproval ?? null) ||
    !inactiveApproval(settings.controlledPhoneApproval ?? null)
  )
    return fail("PRIOR_APPROVAL_STATE");
  if (snapshot.matchingOperationAudits !== 0)
    return fail("OPERATION_ALREADY_RECORDED");
  if (
    attemptedMs < Date.parse(reviewed.config.activation.validFrom) ||
    attemptedMs >= Date.parse(reviewed.config.activation.validUntil)
  )
    return fail("ACTIVATION_WINDOW_AT_ATTEMPT");

  const categoryIds = reviewed.config.activation.allowedServiceCategoryIds;
  if (
    !Array.isArray(snapshot.categoryIds) ||
    snapshot.categoryIds.length !== categoryIds.length ||
    categoryIds.some((id) => !snapshot.categoryIds.includes(id))
  )
    return fail("SERVICE_CATEGORY_BINDING");

  let organization;
  try {
    organization = organizationProfile(
      settings[ORGANIZATION_PROFILE],
    )?.approved;
  } catch {
    return fail("ORGANIZATION_PROFILE_FORMAT");
  }
  if (!organization) return fail("ORGANIZATION_APPROVAL_MISSING");
  if (
    organization.approvedAt !==
      reviewed.config.activation.organizationApprovedAt ||
    !sameDigest(
      sha(JSON.stringify(organization)),
      reviewed.config.activation.organizationDigest,
    )
  )
    return fail("ORGANIZATION_APPROVAL_BINDING");

  let payment;
  try {
    payment = paymentProfile(settings[ORGANIZATION_PAYMENT_POLICY])?.approved;
  } catch {
    return fail("PAYMENT_POLICY_FORMAT");
  }
  if (!payment) return fail("PAYMENT_APPROVAL_MISSING");
  if (
    payment.approvedAt !== reviewed.config.activation.paymentApprovedAt ||
    !sameDigest(
      sha(JSON.stringify(payment)),
      reviewed.config.activation.paymentDigest,
    )
  )
    return fail("PAYMENT_APPROVAL_BINDING");
  if (
    attemptedMs < Date.parse(organization.approvedAt) ||
    attemptedMs < Date.parse(payment.approvedAt)
  )
    return fail("APPROVAL_TIME_AT_ATTEMPT");
  return result("PASS", "ACTIVATION_PREREQUISITES_MATCHED");
}

async function readSnapshot(client, reviewed, operationId) {
  const identity = (
    await client.query(
      "SELECT current_database() AS name,current_user AS role,current_setting('server_version_num')::int AS version",
    )
  ).rows[0];
  const migrations = (
    await client.query(
      "SELECT migration_name,checksum,finished_at,rolled_back_at FROM public._prisma_migrations ORDER BY migration_name",
    )
  ).rows;
  const tenant = (
    await client.query(
      'SELECT id::text,status,settings FROM "TenantOrganization" WHERE id=$1::uuid',
      [reviewed.config.activation.tenantId],
    )
  ).rows[0];
  const categoryIds = (
    await client.query(
      'SELECT id::text FROM "ServiceCategory" WHERE "tenantId"=$1::uuid AND id=ANY($2::uuid[]) ORDER BY id',
      [
        reviewed.config.activation.tenantId,
        reviewed.config.activation.allowedServiceCategoryIds,
      ],
    )
  ).rows.map((row) => row.id);
  const matchingOperationAudits = Number(
    (
      await client.query(
        'SELECT count(*)::int AS count FROM "AuditLog" WHERE "tenantId"=$1::uuid AND "traceId"=$2',
        [reviewed.config.activation.tenantId, operationId],
      )
    ).rows[0]?.count,
  );
  return { identity, migrations, tenant, categoryIds, matchingOperationAudits };
}

/** Fixed-target, read-only transaction. Password must arrive through the private
 * anonymous-pipe helper and is never accepted from argv or environment. */
export async function diagnoseFixedChildActivation(
  password,
  packet,
  operationId,
  attemptedAt,
) {
  assert.equal(typeof password, "string");
  assert.match(password, /^[\x20-\x7e]{1,512}$/);
  let reviewed;
  try {
    reviewed = reviewPacket(packet);
  } catch {
    return fail("PACKET");
  }
  const client = new Client({
    host: TARGET.host,
    port: 5432,
    database: TARGET.database,
    user: "neondb_owner",
    password,
    ssl: { rejectUnauthorized: true },
    connectionTimeoutMillis: 5000,
    query_timeout: 12000,
    application_name: "signmons_p06_r10_activation_diagnostic",
    options: "-c statement_timeout=10s -c default_transaction_read_only=on",
  });
  try {
    await client.connect();
    await client.query(
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    const snapshot = await readSnapshot(client, reviewed, operationId);
    await client.query("COMMIT");
    return await classifyActivationSnapshot(
      packet,
      operationId,
      attemptedAt,
      snapshot,
    );
  } catch {
    try {
      await client.query("ROLLBACK");
    } catch {}
    return result("UNCONFIRMED", "DATABASE_READ");
  } finally {
    password = undefined;
    await client.end().catch(() => {});
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.stderr.write(
    "R10 activation diagnostic requires a separately reviewed private invocation; no action performed.\n",
  );
  process.exitCode = 1;
}
