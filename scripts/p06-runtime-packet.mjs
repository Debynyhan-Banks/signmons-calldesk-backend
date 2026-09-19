// Owner-operated U01 interface. Importing/CLI never fetches secrets or opens a DB.
// Run npm run build first; use reviewed injected ports, never request/HTTP input.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { TARGET, inspectStorage, reserveAttempt } from "./p06-backup-once.mjs";
import { mkdir } from "node:fs/promises";
import { realpathSync, statSync } from "node:fs";
import { manifest } from "./p06-migrate-once.mjs";
const require = createRequire(import.meta.url);
const {
  parseControlledRuntimeConfig,
} = require("../dist/communications/controlled-intake-runtime-config.js");
const {
  controlledCustomerAdmissionDigest,
} = require("../dist/communications/controlled-customer-admission.js");
const {
  ControlledIntakeAuthority,
} = require("../dist/communications/controlled-intake-authority.js");
const {
  CustomerIntakeContinuationService,
} = require("../dist/communications/customer-intake-continuation.service.js");
const { Prisma } = require("@prisma/client");
const sha = (v) => createHash("sha256").update(v).digest("hex");
const plain = (v) => v && Object.getPrototypeOf(v) === Object.prototype;
const uuid = (v) =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    v,
  );
const digest = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const resource = /^projects\/signmons\/secrets\/[A-Za-z0-9_-]+$/;
const refPattern =
  /^projects\/signmons\/secrets\/[A-Za-z0-9_-]+\/versions\/[1-9][0-9]*$/;
const exact = (v, keys) => {
  assert.ok(plain(v));
  assert.equal(Object.keys(v).sort().join(), keys.split(",").sort().join());
};
const instant = (v) => {
  assert.equal(new Date(v).toISOString(), v);
  return Date.parse(v);
};
const safeError = (code) => Object.assign(new Error(code), { code });
const safe = async (fn) => {
  try {
    return await fn();
  } catch {
    throw safeError("P06_PACKET_REFUSED_OR_UNCONFIRMED");
  }
};

/** No material in this packet. Values are copied before any asynchronous work. */
export function reviewPacket(input) {
  try {
    const p = structuredClone(input);
    exact(
      p,
      "version,sourceRevision,target,envelope,facts,bundleResource,forbiddenResources",
    );
    assert.equal(p.version, 1);
    assert.match(p.sourceRevision, /^[a-f0-9]{40}$/);
    exact(p.target, "project,branch,host,database,role");
    for (const key of ["project", "branch", "host", "database"])
      assert.equal(p.target[key], TARGET[key]);
    assert.equal(p.target.role, "neondb_owner");
    assert.ok(resource.test(p.bundleResource));
    assert.ok(
      Array.isArray(p.forbiddenResources) && p.forbiddenResources.length >= 1,
    );
    assert.ok(p.forbiddenResources.every((v) => resource.test(v)));
    const start = instant(p.envelope.activation.validFrom);
    assert.ok(JSON.stringify(p.envelope).length <= 32768);
    const config = parseControlledRuntimeConfig(p.envelope, p.facts, start);
    assert.ok(config && config.project === "signmons");
    assert.equal(config.service, "signmons-calldesk-staging");
    assert.equal(config.configuration, "signmons-calldesk-staging");
    assert.ok(config.revision.startsWith("signmons-calldesk-staging-"));
    const refs = [
      ...Object.values(config.secrets.sessionKeys),
      config.secrets.digestKey,
      config.secrets.fingerprintKey,
      config.secrets.twilioToken,
    ];
    const resources = refs.map((v) => v.split("/versions/")[0]);
    assert.equal(new Set(resources).size, resources.length);
    assert.ok(!resources.includes(p.bundleResource));
    assert.ok(resources.every((v) => !p.forbiddenResources.includes(v)));
    assert.ok(!p.forbiddenResources.includes(p.bundleResource));
    return {
      p,
      config,
      refs,
      packetDigest: sha(JSON.stringify(p)),
      runtimeDigest: config.digest,
      phoneDigest: controlledCustomerAdmissionDigest(config.phone),
    };
  } catch {
    throw safeError("P06_PACKET_INVALID");
  }
}

function authorization(a, r, action, now) {
  exact(
    a,
    "owner,action,operationId,packetDigest,sourceRevision,startUtc,endUtc",
  );
  assert.equal(a.owner, "Debynyhan Banks");
  assert.equal(a.action, action);
  assert.ok(uuid(a.operationId));
  assert.equal(a.packetDigest, r.packetDigest);
  assert.equal(a.sourceRevision, r.p.sourceRevision);
  const start = instant(a.startUtc),
    end = instant(a.endUtc);
  assert.ok(
    Number.isSafeInteger(now) &&
      end > start &&
      end - start <= 900000 &&
      now >= start &&
      now < end,
  );
}

/** ports.reserve must be exclusive/durable before a possible upload; a consumed
 * operation is never retried, even on an unknown upload/readback outcome. */
export async function prepareBundle(packet, approval, ports) {
  return safe(async () => {
    const r = reviewPacket(packet),
      a = structuredClone(approval);
    authorization(a, r, "prepare", Date.now());
    await ports.reserve(a.operationId, r.packetDigest);
    const values = {};
    for (const ref of r.refs) {
      authorization(a, r, "prepare", Date.now());
      const got = await ports.readVersion(ref);
      exact(got, "name,value");
      assert.equal(got.name, ref);
      assert.equal(typeof got.value, "string");
      assert.ok(
        (ref === r.config.secrets.twilioToken
          ? /^[a-f0-9]{32}$/i
          : /^[a-f0-9]{64}$/i
        ).test(got.value),
      );
      values[ref] = got.value;
    }
    const keys = r.refs
      .filter((v) => v !== r.config.secrets.twilioToken)
      .map((v) => values[v].toLowerCase());
    assert.equal(new Set(keys).size, keys.length);
    const payload = Buffer.from(JSON.stringify(values));
    assert.ok(payload.length <= 8192);
    let readback;
    try {
      authorization(a, r, "prepare", Date.now());
      const name = await ports.addVersion(r.p.bundleResource, payload);
      assert.ok(
        refPattern.test(name) &&
          name.startsWith(r.p.bundleResource + "/versions/"),
      );
      readback = await ports.readVersion(name);
      assert.equal(readback.name, name);
      const bytes = Buffer.from(readback.value);
      try {
        assert.equal(bytes.length, payload.length);
        assert.ok(timingSafeEqual(bytes, payload));
      } finally {
        bytes.fill(0);
      }
      authorization(a, r, "prepare", Date.now());
      return Object.freeze({
        status: "BUNDLE_VERIFIED",
        operationId: a.operationId,
        packetId: r.config.activation.packetId,
        packetDigest: r.packetDigest,
        sourceRevision: r.p.sourceRevision,
        sourceVersions: Object.freeze([...r.refs]),
        bundleVersion: name,
      });
    } finally {
      payload.fill(0);
      for (const k of Object.keys(values)) delete values[k];
      readback = undefined;
    }
  });
}

/** Fresh encrypted directory per operation. Existing directory is a stop,
 * including after a process crash; never remove it to enable a retry. */
export function encryptedReservation(approval) {
  const a = structuredClone(approval);
  return async (operationId, packetDigest) => {
    assert.ok(uuid(operationId));
    assert.equal(operationId, a.operationId);
    assert.equal(packetDigest, a.packetDigest);
    await inspectStorage();
    const dir = `/Volumes/Signmons-P06/u01-${operationId}`;
    await mkdir(dir, { mode: 0o700 });
    await reserveAttempt(dir, {
      approvalId: operationId,
      sourceRevision: a.sourceRevision,
      startUtc: a.startUtc,
      endUtc: a.endUtc,
    });
  };
}

/** Authenticated API adapter, explicit construction only. Auth port is an
 * existing GoogleAuth client. No CLI/shell interpolation or automatic retry. */
export function googleSecretPorts(auth, reserve) {
  // Read-only project metadata verified 2026-09-15. Accept only this project's
  // numeric canonical name, never an arbitrary project-number substitution.
  const canonical = (name) => {
    assert.equal(typeof name, "string");
    const ref = name.replace(/^projects\/845074063310\//, "projects/signmons/");
    assert.ok(refPattern.test(ref));
    return ref;
  };
  const request = async (url, method, data) =>
    auth.request({ url, method, data, retry: false, timeout: 10000 });
  return {
    reserve,
    readVersion: async (name) => {
      assert.ok(refPattern.test(name));
      const result = await request(
        `https://secretmanager.googleapis.com/v1/${name}:access`,
        "GET",
      );
      assert.equal(canonical(result.data.name), name);
      assert.equal(typeof result.data.payload?.data, "string");
      const bytes = Buffer.from(result.data.payload.data, "base64");
      try {
        assert.ok(bytes.length <= 8192);
        return { name, value: bytes.toString("utf8") };
      } finally {
        bytes.fill(0);
      }
    },
    addVersion: async (name, bytes) => {
      assert.ok(
        resource.test(name) && Buffer.isBuffer(bytes) && bytes.length <= 8192,
      );
      const result = await request(
        `https://secretmanager.googleapis.com/v1/${name}:addVersion`,
        "POST",
        { payload: { data: bytes.toString("base64") } },
      );
      const version = canonical(result.data.name);
      assert.ok(version.startsWith(name + "/versions/"));
      return version;
    },
  };
}

const databases = new WeakMap();

const bootstrapTenant = "a1adcfd4-15be-404b-9ac3-5edb1fda20f0";
const bootstrapPayment = Object.freeze({
  currency: "usd",
  serviceFeeRequired: false,
  serviceFeeCents: null,
  depositRequired: true,
  depositPolicy: { kind: "fixed", amountCents: 9900 },
  emergencyFeePolicy: { kind: "none" },
  paymentGateMode: "fail_closed",
  webhookValidationRequired: true,
});
// Stable JSON digest: PostgreSQL jsonb does not preserve object key order.
const canonical = (value) =>
  JSON.stringify(value, function (_key, item) {
    return plain(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item;
  });
export const bootstrapSettingsDigest = (settings) => sha(canonical(settings));

/** Nonsecret review only. No CLI, connection, credential or external action. */
export function reviewBootstrap(packet) {
  try {
    const p = structuredClone(packet);
    exact(
      p,
      "version,sourceRevision,tenantId,expectedUpdatedAt,expectedSettingsDigest,categoryId,profile,payment",
    );
    assert.equal(p.version, 1);
    assert.match(p.sourceRevision, /^[a-f0-9]{40}$/);
    assert.equal(p.tenantId, bootstrapTenant);
    instant(p.expectedUpdatedAt);
    assert.ok(digest(p.expectedSettingsDigest) && uuid(p.categoryId));
    const { draft } = require("../dist/tenants/organization-profile.js");
    assert.deepEqual(draft(p.profile), p.profile);
    assert.equal(p.profile.companyName, "Eternity Mechanical Services LLC");
    assert.equal(p.profile.timezone, "America/New_York");
    assert.deepEqual(p.payment, bootstrapPayment);
    return { p, packetDigest: sha(canonical(p)) };
  } catch {
    throw safeError("P06_BOOTSTRAP_INVALID");
  }
}

/** Separate owner-reviewed bootstrap; shares U01 target/schema guards only.
 * Services run inside ONE outer transaction, including their own audit writes.
 * Any thrown result is unconfirmed. Read back; never automatically replay. */
export async function bootstrap(packet, approval, handle) {
  return safe(async () => {
    const r = reviewBootstrap(packet),
      a = structuredClone(approval);
    assert.ok(
      ["bootstrap", "bootstrap-readback", "bootstrap-suspend"].includes(
        a.action,
      ),
    );
    authorization(a, r, a.action, Date.now());
    const db = databases.get(handle);
    assert.ok(db);
    return db.prisma.$transaction(
      async (tx) => {
        await guardDatabase(tx, db);
        const [row] = await tx.$queryRaw(
          Prisma.sql`SELECT id,status,settings,"updatedAt" FROM "TenantOrganization" WHERE id=${bootstrapTenant}::uuid FOR UPDATE`,
        );
        assert.ok(row && plain(row.settings));
        const clock = async () => {
          const [time] = await tx.$queryRawUnsafe(
            "SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS ms",
          );
          authorization(a, r, a.action, Number(time.ms));
        };
        await clock();
        const receipt = await tx.auditLog.findFirst({
          where: {
            tenantId: bootstrapTenant,
            action: "controlled_intake.bootstrap",
            metadata: { path: ["packetDigest"], equals: r.packetDigest },
          },
        });
        const categories = await tx.serviceCategory.findMany({
          where: { tenantId: bootstrapTenant },
        });
        const categoryMatches =
          categories.length === 1 &&
          categories[0].id === r.p.categoryId &&
          categories[0].name === "Regular initial visit / diagnosis" &&
          categories[0].basePriceCents === 0 &&
          categories[0].emergencySurchargeCents === 0 &&
          categories[0].estimatedDurationMinutes === 60;
        const matches =
          categoryMatches &&
          receipt &&
          row.updatedAt.toISOString() === receipt.metadata.updatedAt &&
          bootstrapSettingsDigest(row.settings) ===
            receipt.metadata.settingsDigest;
        if (a.action === "bootstrap-readback") {
          return {
            status: "READBACK",
            tenantStatus: row.status,
            matchingBootstrapAudit: Boolean(receipt),
            unchangedSetup: Boolean(matches),
            updatedAt: row.updatedAt.toISOString(),
            settingsDigest: bootstrapSettingsDigest(row.settings),
          };
        }
        for (const value of Object.values(approvalPair(row.settings))) {
          if (value !== null) {
            exact(value, "enabled,digest");
            assert.equal(value.enabled, false);
            assert.ok(digest(value.digest));
          }
        }
        assert.equal(
          await tx.auditLog.count({
            where: { tenantId: bootstrapTenant, traceId: a.operationId },
          }),
          0,
        );
        if (a.action === "bootstrap-suspend") {
          assert.ok(matches);
          assert.equal(row.status, "ACTIVE");
          assert.equal(
            await tx.job.count({ where: { tenantId: bootstrapTenant } }),
            0,
          );
          const changed = await tx.tenantOrganization.updateMany({
            where: {
              id: bootstrapTenant,
              status: "ACTIVE",
              updatedAt: row.updatedAt,
            },
            data: {
              status: "SUSPENDED",
              updatedAt: new Date(
                Math.max(Date.now(), row.updatedAt.getTime() + 1),
              ),
            },
          });
          assert.equal(changed.count, 1);
        } else {
          assert.equal(receipt, null);
          assert.equal(row.status, "SUSPENDED");
          assert.equal(row.updatedAt.toISOString(), r.p.expectedUpdatedAt);
          assert.equal(
            bootstrapSettingsDigest(row.settings),
            r.p.expectedSettingsDigest,
          );
          assert.equal(row.settings.organizationProfileV1, undefined);
          assert.equal(row.settings.organizationPaymentPolicyV1, undefined);
          assert.equal(
            await tx.serviceCategory.count({
              where: { tenantId: bootstrapTenant },
            }),
            0,
          );
          assert.equal(
            await tx.job.count({ where: { tenantId: bootstrapTenant } }),
            0,
          );
          const updatedAt = new Date(
            Math.max(Date.now(), row.updatedAt.getTime() + 1),
          );
          const changed = await tx.tenantOrganization.updateMany({
            where: {
              id: bootstrapTenant,
              status: "SUSPENDED",
              updatedAt: row.updatedAt,
            },
            data: {
              status: "ACTIVE",
              timezone: r.p.profile.timezone,
              updatedAt,
            },
          });
          assert.equal(changed.count, 1);
          const {
            requestContextMiddleware,
            setAuthContext,
          } = require("../dist/common/context/request-context.js");
          const {
            OrganizationProfileService,
          } = require("../dist/tenants/organization-profile.service.js");
          const {
            OrganizationPaymentPolicyService,
          } = require("../dist/tenants/organization-payment-policy.service.js");
          // Do not let service-level transaction callbacks commit independently.
          const adapter = { $transaction: (callback) => callback(tx) };
          await new Promise((resolve, reject) => {
            requestContextMiddleware({ headers: {} }, {}, () => {
              setAuthContext({
                userId: a.owner,
                tenantId: bootstrapTenant,
                role: "owner",
              });
              (async () => {
                let expectedUpdatedAt = updatedAt.toISOString();
                for (const [Service, draft] of [
                  [OrganizationProfileService, r.p.profile],
                  [OrganizationPaymentPolicyService, r.p.payment],
                ]) {
                  const service = new Service(adapter);
                  const saved = await service.write({
                    expectedUpdatedAt,
                    draft,
                  });
                  const approved = await service.write(
                    { expectedUpdatedAt: saved.updatedAt, acknowledged: true },
                    true,
                  );
                  expectedUpdatedAt = approved.updatedAt;
                }
              })().then(resolve, reject);
            });
          });
          await tx.serviceCategory.create({
            data: {
              id: r.p.categoryId,
              tenantId: bootstrapTenant,
              name: "Regular initial visit / diagnosis",
              basePriceCents: 0,
              emergencySurchargeCents: 0,
              estimatedDurationMinutes: 60,
            },
          });
        }
        const final = await tx.tenantOrganization.findUniqueOrThrow({
          where: { id: bootstrapTenant },
        });
        const metadata = {
          packetDigest: r.packetDigest,
          sourceRevision: r.p.sourceRevision,
          categoryId: r.p.categoryId,
          updatedAt: final.updatedAt.toISOString(),
          settingsDigest: bootstrapSettingsDigest(final.settings),
        };
        await tx.auditLog.create({
          data: {
            tenantId: bootstrapTenant,
            actorType: "USER",
            actorId: a.owner,
            entityType: "TenantOrganization",
            entityId: bootstrapTenant,
            traceId: a.operationId,
            action:
              a.action === "bootstrap"
                ? "controlled_intake.bootstrap"
                : "controlled_intake.bootstrap_suspended",
            metadata,
          },
        });
        await clock();
        return {
          status: a.action === "bootstrap" ? "BOOTSTRAPPED" : "SUSPENDED",
          ...metadata,
        };
      },
      { maxWait: 5000, timeout: 15000 },
    );
  });
}
/** Explicit construction; password must arrive privately from the existing
 * hidden-input/anonymous-pipe mechanism. Never from an argument or env dump. */
export function fixedChildDatabase(password) {
  assert.equal(typeof password, "string");
  assert.match(password, /^[\x20-\x7e]{1,512}$/);
  return database(
    {
      host: TARGET.host,
      port: 5432,
      database: TARGET.database,
      user: "neondb_owner",
      password,
      ssl: { rejectUnauthorized: true },
    },
    false,
  );
}
/** Local tests only: private Unix socket and disposable name; no external URL. */
export function syntheticDatabase(connection) {
  assert.match(
    connection.host,
    /^\/private\/tmp\/signmons-u01-[A-Za-z0-9]+\/socket$/,
  );
  assert.match(connection.database, /^calldesk_u01_[a-f0-9]{12}$/);
  assert.equal(
    Object.keys(connection).sort().join(),
    "database,host,port,user",
  );
  assert.equal(connection.port, 5432);
  assert.equal(realpathSync(connection.host), connection.host);
  const directory = statSync(connection.host);
  assert.ok(
    directory.isDirectory() &&
      directory.uid === process.getuid() &&
      (directory.mode & 0o777) === 0o700,
  );
  return database({ ...connection }, true);
}
function database(connection, synthetic) {
  const { Pool } = require("pg"),
    { PrismaClient } = require("@prisma/client"),
    { PrismaPg } = require("@prisma/adapter-pg");
  const pool = new Pool({
    ...connection,
    max: 2,
    connectionTimeoutMillis: 5000,
    options: "-c lock_timeout=5s -c statement_timeout=10s",
  });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool), log: [] });
  const handle = Object.freeze({
    close: async () => {
      await prisma.$disconnect();
      await pool.end();
    },
  });
  databases.set(handle, { prisma, connection, synthetic });
  return handle;
}
async function guardDatabase(tx, db, stage = () => {}) {
  stage("DATABASE_IDENTITY");
  const [actual] = await tx.$queryRawUnsafe(
    "SELECT current_database() AS name,current_user AS role,inet_server_addr()::text AS address,current_setting('server_version_num')::int AS version",
  );
  assert.equal(actual.name, db.connection.database);
  assert.equal(actual.role, db.connection.user);
  assert.ok(actual.version >= 180000 && actual.version < 190000);
  if (db.synthetic) assert.equal(actual.address, null);
  else {
    assert.equal(db.connection.host, TARGET.host);
    assert.equal(actual.name, TARGET.database);
    assert.equal(actual.role, "neondb_owner");
  }
  stage("MIGRATION_HISTORY");
  const history = await tx.$queryRawUnsafe(
    "SELECT migration_name,checksum,finished_at,rolled_back_at FROM public._prisma_migrations ORDER BY migration_name",
  );
  const files = await manifest();
  assert.equal(history.length, files.length);
  history.forEach((row, i) => {
    assert.equal(row.migration_name, files[i].name);
    assert.equal(row.checksum, files[i].sha256);
    assert.ok(row.finished_at && !row.rolled_back_at);
  });
}
const approvalPair = (settings) => ({
  runtime: settings.controlledRuntimeApproval ?? null,
  phone: settings.controlledPhoneApproval ?? null,
});
function statePair(settings, r) {
  const pair = approvalPair(settings);
  for (const [key, hash] of [
    ["runtime", r.runtimeDigest],
    ["phone", r.phoneDigest],
  ]) {
    exact(pair[key], "enabled,digest");
    assert.equal(pair[key].digest, hash);
    assert.equal(typeof pair[key].enabled, "boolean");
  }
  assert.equal(pair.runtime.enabled, pair.phone.enabled);
  return pair.runtime.enabled ? "ACTIVE" : "REVOKED";
}

const operationEvidence = new WeakMap();
const OPERATION_STAGES = new Set([
  "CREATED",
  "REVIEW_PACKET",
  "LOCAL_AUTHORIZATION",
  "DATABASE_HANDLE",
  "DATABASE_TRANSACTION",
  "DATABASE_IDENTITY",
  "MIGRATION_HISTORY",
  "TENANT_ROW",
  "DATABASE_AUTHORIZATION",
  "READBACK",
  "OPERATION_UNUSED",
  "ACTIVATION_EXPECTED",
  "ACTIVATION_SNAPSHOT",
  "PRIOR_APPROVAL_STATE",
  "TENANT_STATUS",
  "RUNTIME_CONFIG_INITIAL",
  "CURRENT_STATE_AUTHORITY",
  "REVOCATION_EXPECTED",
  "FINAL_CLOCK",
  "FINAL_AUTHORIZATION",
  "RUNTIME_CONFIG_FINAL",
  "UPDATE_CAS",
  "AUDIT_WRITE",
  "COMPLETE",
]);

/** Opaque, single-use collector. Only fixed stage names can be read back. */
export function createOperationStageEvidence() {
  const evidence = Object.freeze({});
  operationEvidence.set(evidence, { stage: "CREATED", used: false });
  return evidence;
}

export function readOperationStageEvidence(evidence) {
  const state = operationEvidence.get(evidence);
  assert.ok(state && OPERATION_STAGES.has(state.stage));
  return Object.freeze({
    status: state.used ? "USED" : "UNUSED",
    stage: state.stage,
  });
}

async function operateInternal(packet, approval, handle, expected, note) {
  note("REVIEW_PACKET");
  const r = reviewPacket(packet),
    a = structuredClone(approval),
    e = structuredClone(expected);
  assert.ok(["activate", "revoke", "readback"].includes(a.action));
  note("LOCAL_AUTHORIZATION");
  authorization(a, r, a.action, Date.now());
  note("DATABASE_HANDLE");
  const db = databases.get(handle);
  assert.ok(db);
  note("DATABASE_TRANSACTION");
  const answer = await db.prisma.$transaction(
    async (tx) => {
      await guardDatabase(tx, db, note);
      note("TENANT_ROW");
      const rows = await tx.$queryRaw(
        Prisma.sql`SELECT id,status,settings,"updatedAt",floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS "nowMs" FROM "TenantOrganization" WHERE id=${r.config.activation.tenantId}::uuid FOR UPDATE`,
      );
      assert.equal(rows.length, 1);
      const row = rows[0];
      assert.ok(plain(row.settings));
      note("DATABASE_AUTHORIZATION");
      authorization(a, r, a.action, Number(row.nowMs));
      if (a.action === "readback") {
        note("READBACK");
        exact(e, "operationId");
        assert.ok(uuid(e.operationId));
        let state = "OTHER";
        try {
          state = statePair(row.settings, r);
        } catch {
          /* mismatch remains explicit */
        }
        const count = await tx.auditLog.count({
          where: {
            tenantId: row.id,
            traceId: e.operationId,
            metadata: { path: ["packetDigest"], equals: r.packetDigest },
            action: {
              in: ["controlled_intake.activate", "controlled_intake.revoke"],
            },
          },
        });
        return {
          status: "READBACK",
          storedApprovalState: state,
          tenantStatus: row.status,
          windowCurrent:
            Number(row.nowMs) >= Date.parse(r.config.activation.validFrom) &&
            Number(row.nowMs) < Date.parse(r.config.activation.validUntil),
          updatedAt: row.updatedAt.toISOString(),
          matchingOperationAudits: count,
        };
      }
      note("OPERATION_UNUSED");
      assert.equal(
        await tx.auditLog.count({
          where: { tenantId: row.id, traceId: a.operationId },
        }),
        0,
      );
      if (a.action === "activate") {
        note("ACTIVATION_EXPECTED");
        exact(e, "updatedAt,approvals");
        instant(e.updatedAt);
        note("ACTIVATION_SNAPSHOT");
        assert.equal(row.updatedAt.toISOString(), e.updatedAt);
        assert.deepEqual(approvalPair(row.settings), e.approvals);
        // Never replace an active or partially active approval.
        note("PRIOR_APPROVAL_STATE");
        for (const old of Object.values(e.approvals))
          assert.ok(
            old === null ||
              (plain(old) && old.enabled === false && digest(old.digest)),
          );
        note("TENANT_STATUS");
        assert.equal(row.status, "ACTIVE");
        note("RUNTIME_CONFIG_INITIAL");
        parseControlledRuntimeConfig(
          r.p.envelope,
          r.p.facts,
          Number(row.nowMs),
        );
        note("CURRENT_STATE_AUTHORITY");
        const reader = new CustomerIntakeContinuationService(
          undefined,
          undefined,
          undefined,
        );
        const authority = new ControlledIntakeAuthority(
          () => r.config.activation,
          (t, scope) => reader.readControlledCurrentState(t, scope),
        );
        const capability = authority.issue();
        for (const serviceCategoryId of r.config.activation
          .allowedServiceCategoryIds)
          await authority.check(capability, tx, {
            tenantId: row.id,
            integrationId: r.config.activation.integrationId,
            origin: r.config.origin,
            serviceCategoryId,
          });
      } else {
        note("REVOCATION_EXPECTED");
        exact(e, "runtimeDigest,phoneDigest");
        assert.equal(e.runtimeDigest, r.runtimeDigest);
        assert.equal(e.phoneDigest, r.phoneDigest);
        assert.equal(statePair(row.settings, r), "ACTIVE");
      }
      note("FINAL_CLOCK");
      const [clock] = await tx.$queryRawUnsafe(
        "SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS ms",
      );
      const now = Number(clock.ms);
      note("FINAL_AUTHORIZATION");
      authorization(a, r, a.action, now);
      if (a.action === "activate") {
        note("RUNTIME_CONFIG_FINAL");
        parseControlledRuntimeConfig(r.p.envelope, r.p.facts, now);
      }
      const enabled = a.action === "activate";
      const next = {
        ...row.settings,
        controlledRuntimeApproval: { enabled, digest: r.runtimeDigest },
        controlledPhoneApproval: { enabled, digest: r.phoneDigest },
      };
      const updatedAt = new Date(Math.max(now, row.updatedAt.getTime() + 1));
      note("UPDATE_CAS");
      const updated = await tx.tenantOrganization.updateMany({
        where: { id: row.id, updatedAt: row.updatedAt },
        data: { settings: next, updatedAt },
      });
      assert.equal(updated.count, 1);
      note("AUDIT_WRITE");
      await tx.auditLog.create({
        data: {
          tenantId: row.id,
          action: `controlled_intake.${a.action}`,
          actorType: "USER",
          actorId: "owner:Debynyhan-Banks",
          entityType: "TenantOrganization",
          entityId: row.id,
          traceId: a.operationId,
          metadata: {
            version: 1,
            packetId: r.config.activation.packetId,
            packetDigest: r.packetDigest,
            runtimeDigest: r.runtimeDigest,
            phoneDigest: r.phoneDigest,
            sourceRevision: r.p.sourceRevision,
          },
        },
      });
      return {
        status: enabled ? "ACTIVE" : "REVOKED",
        operationId: a.operationId,
        updatedAt: updatedAt.toISOString(),
      };
    },
    { maxWait: 5000, timeout: 20000 },
  );
  note("COMPLETE");
  return answer;
}

/** Parameterized row locks/CAS/audit in one transaction. Revocation and readback
 * remain possible after the run expires, with fresh cleanup/read authority.
 * Any error is unconfirmed; never automatically retry a database operation. */
export async function operate(packet, approval, handle, expected) {
  return safe(() =>
    operateInternal(packet, approval, handle, expected, () => {}),
  );
}

/** Same operation with an opaque fixed-code stage collector for the reviewed
 * private controller. Raw exceptions and database values remain suppressed. */
export async function operateWithStageEvidence(
  packet,
  approval,
  handle,
  expected,
  evidence,
) {
  const state = operationEvidence.get(evidence);
  assert.ok(state && state.used === false);
  state.used = true;
  const note = (stage) => {
    assert.ok(OPERATION_STAGES.has(stage));
    state.stage = stage;
  };
  return safe(() => operateInternal(packet, approval, handle, expected, note));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.stderr.write(
    "P06 operator interface requires a separately reviewed invocation; no action performed.\n",
  );
  process.exitCode = 1;
}
