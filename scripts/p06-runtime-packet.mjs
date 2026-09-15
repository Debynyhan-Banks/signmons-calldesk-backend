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
async function guardDatabase(tx, db) {
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

/** Parameterized row locks/CAS/audit in one transaction. Revocation and readback
 * remain possible after the run expires, with fresh cleanup/read authority.
 * Any error is unconfirmed; never automatically retry a database operation. */
export async function operate(packet, approval, handle, expected) {
  return safe(async () => {
    const r = reviewPacket(packet),
      a = structuredClone(approval),
      e = structuredClone(expected);
    assert.ok(["activate", "revoke", "readback"].includes(a.action));
    authorization(a, r, a.action, Date.now());
    const db = databases.get(handle);
    assert.ok(db);
    return db.prisma.$transaction(
      async (tx) => {
        await guardDatabase(tx, db);
        const rows = await tx.$queryRaw(
          Prisma.sql`SELECT id,status,settings,"updatedAt",floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS "nowMs" FROM "TenantOrganization" WHERE id=${r.config.activation.tenantId}::uuid FOR UPDATE`,
        );
        assert.equal(rows.length, 1);
        const row = rows[0];
        assert.ok(plain(row.settings));
        authorization(a, r, a.action, Number(row.nowMs));
        if (a.action === "readback") {
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
        assert.equal(
          await tx.auditLog.count({
            where: { tenantId: row.id, traceId: a.operationId },
          }),
          0,
        );
        if (a.action === "activate") {
          exact(e, "updatedAt,approvals");
          instant(e.updatedAt);
          assert.equal(row.updatedAt.toISOString(), e.updatedAt);
          assert.deepEqual(approvalPair(row.settings), e.approvals);
          // Never replace an active or partially active approval.
          for (const old of Object.values(e.approvals))
            assert.ok(
              old === null ||
                (plain(old) && old.enabled === false && digest(old.digest)),
            );
          assert.equal(row.status, "ACTIVE");
          parseControlledRuntimeConfig(
            r.p.envelope,
            r.p.facts,
            Number(row.nowMs),
          );
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
          exact(e, "runtimeDigest,phoneDigest");
          assert.equal(e.runtimeDigest, r.runtimeDigest);
          assert.equal(e.phoneDigest, r.phoneDigest);
          assert.equal(statePair(row.settings, r), "ACTIVE");
        }
        const [clock] = await tx.$queryRawUnsafe(
          "SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS ms",
        );
        const now = Number(clock.ms);
        authorization(a, r, a.action, now);
        if (a.action === "activate")
          parseControlledRuntimeConfig(r.p.envelope, r.p.facts, now);
        const enabled = a.action === "activate";
        const next = {
          ...row.settings,
          controlledRuntimeApproval: { enabled, digest: r.runtimeDigest },
          controlledPhoneApproval: { enabled, digest: r.phoneDigest },
        };
        const updatedAt = new Date(Math.max(now, row.updatedAt.getTime() + 1));
        const updated = await tx.tenantOrganization.updateMany({
          where: { id: row.id, updatedAt: row.updatedAt },
          data: { settings: next, updatedAt },
        });
        assert.equal(updated.count, 1);
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
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.stderr.write(
    "P06 operator interface requires a separately reviewed invocation; no action performed.\n",
  );
  process.exitCode = 1;
}
