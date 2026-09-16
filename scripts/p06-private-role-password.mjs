// Explicitly approved one-role handoff only. Imports never connect or read secrets.
import { randomBytes, createHash } from "node:crypto";
import { constants, fstatSync } from "node:fs";
import {
  open,
  lstat,
  unlink,
  readFile,
  readdir,
  realpath,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import {
  TARGET,
  RUN,
  TABLES,
  CATALOG,
  validatePacket,
  privateFile,
  inspectStorage,
  cleanupOwned,
} from "./p06-backup-once.mjs";
import {
  BackupBudget,
  BackupFailure,
  sameMetadata,
  readPipe,
} from "./p06_backup_guards.mjs";
export { readPipe } from "./p06_backup_guards.mjs";

const exec = promisify(execFile);
const REPO = fileURLToPath(new URL("../", import.meta.url));
const fail = (code) => new BackupFailure(code);
export const RUNTIME_ROLE = "p06_intake_runtime";
export const RUNTIME_RUN = "/Volumes/Signmons-P06/r08-runtime-password-v1";
export const runtimeHash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const RUNTIME_ROLE_SQL = `SELECT oid::text,rolname,rolcanlogin,rolinherit,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolconnlimit,rolvaliduntil::text,
(SELECT count(*)::int FROM pg_auth_members WHERE member=r.oid) AS memberships
FROM pg_roles r WHERE rolname='p06_intake_runtime'`;
export const RUNTIME_MIGRATIONS_SQL =
  'SELECT migration_name,checksum,finished_at IS NOT NULL AND rolled_back_at IS NULL AS complete FROM "_prisma_migrations" ORDER BY migration_name';
export const RUNTIME_EXTRA_CATALOG = [
  "SELECT datname,datacl::text,pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=current_database()",
  "SELECT n.nspname,c.relname,a.attname,a.attacl::text FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','legacy_2025') AND a.attnum>0 AND NOT a.attisdropped ORDER BY n.nspname,c.relname,a.attnum",
];
export function validateRuntimePacket(p, revision, manifest, now = Date.now()) {
  if (
    !p ||
    p.sourceRevision !== revision ||
    !/^[a-f0-9]{40}$/.test(revision) ||
    p.owner !== "Debynyhan Banks" ||
    !/^P06-R08-[A-Za-z0-9-]{1,64}$/.test(p.approvalId ?? "") ||
    Object.entries(TARGET).some(
      ([k, v]) => p[k] !== (k === "role" ? RUNTIME_ROLE : v),
    ) ||
    p.runDirectory !== RUNTIME_RUN ||
    p.initialPasswordAssignmentApproved !== true ||
    p.inheritedCredentialRiskAcknowledged !== true ||
    p.providerLoggingReviewApproved !== true ||
    p.noOtherConsumersConfirmed !== true ||
    !/^[A-Za-z0-9-]{1,100}$/.test(p.providerLoggingReviewId ?? "") ||
    !/^[1-9][0-9]*$/.test(p.roleOid ?? "") ||
    [p.loggingFingerprint, p.stateFingerprint, p.manifestHash].some(
      (x) => !/^[a-f0-9]{64}$/.test(x ?? ""),
    ) ||
    p.manifestHash !== manifest
  )
    throw fail("RUNTIME_PACKET_REFUSED");
  const dates = [p.startUtc, p.endUtc, p.verifiedAtUtc];
  if (
    dates.some(
      (x) =>
        typeof x !== "string" ||
        !Number.isFinite(Date.parse(x)) ||
        new Date(x).toISOString() !== x,
    )
  )
    throw fail("WINDOW_REFUSED");
  const [start, end, verified] = dates.map(Date.parse);
  if (
    now < start ||
    now >= end ||
    end - start > 900000 ||
    end <= start ||
    verified > now ||
    now - verified > 300000
  )
    throw fail("WINDOW_REFUSED");
  return Math.min(120000, end - now);
}
export async function runtimeManifest() {
  const root = path.join(REPO, "prisma/migrations");
  const names = (await readdir(root)).filter((x) => /^[0-9]/.test(x)).sort();
  if (names.length !== 26) throw fail("MIGRATION_MANIFEST_REFUSED");
  return Promise.all(
    names.map(async (migration_name) => ({
      migration_name,
      checksum: createHash("sha256")
        .update(
          await readFile(path.join(root, migration_name, "migration.sql")),
        )
        .digest("hex"),
      complete: true,
    })),
  );
}
export async function runtimeState(client, budget) {
  const role = (await budget.query(client, RUNTIME_ROLE_SQL)).rows;
  if (
    role.length !== 1 ||
    role[0].rolname !== RUNTIME_ROLE ||
    role[0].rolconnlimit !== 10 ||
    role[0].memberships !== 0 ||
    [
      "rolcanlogin",
      "rolinherit",
      "rolsuper",
      "rolcreatedb",
      "rolcreaterole",
      "rolreplication",
      "rolbypassrls",
    ].some((k) => role[0][k] !== false)
  )
    throw fail("ROLE_STATE_REFUSED");
  const objects = await catalog(budget, client);
  for (const query of RUNTIME_EXTRA_CATALOG)
    objects.push((await budget.query(client, query)).rows);
  return { role, objects };
}
export async function assignRuntimeCore({
  client,
  budget,
  packet,
  root,
  manifest,
}) {
  let sent = false;
  try {
    validateRuntimePacket(packet, packet.sourceRevision, runtimeHash(manifest));
    await exclusiveJson(root + "/attempt.json", {
      approvalId: packet.approvalId,
      sourceRevision: packet.sourceRevision,
    });
    const identity = (
      await budget.query(
        client,
        "SELECT current_database() AS database,current_user AS role,current_setting('server_version_num')::int AS version",
      )
    ).rows[0];
    if (
      identity?.database !== TARGET.database ||
      identity.role !== "neondb_owner" ||
      identity.version < 180000 ||
      identity.version >= 190000
    )
      throw fail("ADMIN_IDENTITY_REFUSED");
    const inspect = async () => {
      validateRuntimePacket(
        packet,
        packet.sourceRevision,
        runtimeHash(manifest),
      );
      const sessions = (
        await budget.query(
          client,
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'",
        )
      ).rows[0];
      if (sessions?.n !== 0) throw fail("OTHER_SESSIONS_REFUSED");
      sameMetadata(
        (await budget.query(client, RUNTIME_MIGRATIONS_SQL)).rows,
        manifest,
      );
      const state = await runtimeState(client, budget);
      if (
        state.role[0].oid !== packet.roleOid ||
        runtimeHash(state) !== packet.stateFingerprint
      )
        throw fail("RUNTIME_STATE_REFUSED");
      assertLogging(
        (await budget.query(client, LOGGING_SQL)).rows,
        (
          await budget.query(
            client,
            "SELECT extname,extversion FROM pg_extension ORDER BY extname",
          )
        ).rows,
        packet.loggingFingerprint,
      );
      return state;
    };
    await inspect();
    await budget.query(client, "BEGIN");
    const before = await inspect();
    let secret = randomBytes(32).toString("hex");
    await exclusiveJson(root + "/runtime-credential.json", {
      host: TARGET.host,
      database: TARGET.database,
      role: RUNTIME_ROLE,
      password: secret,
    });
    budget.assertActive();
    validateRuntimePacket(packet, packet.sourceRevision, runtimeHash(manifest));
    sent = true;
    await budget.query(
      client,
      `ALTER ROLE p06_intake_runtime PASSWORD '${secret}'`,
    );
    secret = undefined;
    sameMetadata(await runtimeState(client, budget), before);
    await budget.query(client, "COMMIT");
    sameMetadata(await runtimeState(client, budget), before);
    return { status: "RUNTIME_ASSIGNED_NOLOGIN", role: RUNTIME_ROLE };
  } catch {
    // Preserve the only encrypted credential copy even on an uncertain commit.
    throw fail(
      sent ? "RUNTIME_ASSIGNMENT_INDETERMINATE" : "RUNTIME_ASSIGNMENT_REFUSED",
    );
  }
}
export async function runRuntimeAdmin(packet) {
  const revision = (
    await exec("/usr/bin/git", ["-C", REPO, "rev-parse", "HEAD"])
  ).stdout.trim();
  const manifest = await runtimeManifest();
  validateRuntimePacket(packet, revision, runtimeHash(manifest));
  if (
    (
      await exec("/usr/bin/git", ["-C", REPO, "status", "--porcelain"])
    ).stdout.trim()
  )
    throw fail("SOURCE_CHECKOUT_DIRTY");
  if (!fstatSync(0).isFIFO()) throw fail("PRIVATE_PIPE_REQUIRED");
  await inspectStorage();
  const dir = await lstat(RUNTIME_RUN);
  if (
    (await realpath(RUNTIME_RUN)) !== RUNTIME_RUN ||
    !dir.isDirectory() ||
    dir.uid !== process.getuid() ||
    (dir.mode & 0o777) !== 0o700 ||
    (await readdir(RUNTIME_RUN)).some((x) => x !== "approval.json")
  )
    throw fail("RUNTIME_STORAGE_REFUSED");
  // Prevent two wrappers prompting against the same approval before core's marker.
  await exclusiveJson(RUNTIME_RUN + "/handoff-attempt.json", {
    approvalId: packet.approvalId,
    sourceRevision: revision,
  });
  let client, budget, result, failure;
  try {
    budget = await BackupBudget.create({
      roots: [RUNTIME_RUN],
      milliseconds: validateRuntimePacket(
        packet,
        revision,
        runtimeHash(manifest),
      ),
    });
    process.stdout.write("READY\n");
    let password = await readPipe(process.stdin, budget);
    client = new pg.Client({
      ...adminConnection(password),
      application_name: "signmons-p06-r08-private-handoff",
      statement_timeout: 10000,
    });
    password = undefined;
    client.on("notice", () => {});
    client.on("error", () => budget.abort("CONNECTION_FAILED"));
    await connectAdmin(client, budget);
    result = await assignRuntimeCore({
      client,
      budget,
      packet,
      root: RUNTIME_RUN,
      manifest,
    });
  } catch (error) {
    failure =
      error instanceof BackupFailure
        ? error.message
        : "RUNTIME_HANDOFF_REFUSED";
  } finally {
    try {
      await cleanupOwned({
        clients: client ? [client] : [],
        stop: async () => {},
        removePassfile: async () => {},
        eject: async () => {},
      });
    } catch {
      failure = "RUNTIME_CLOSEOUT_UNCERTAIN";
    }
    budget?.close();
  }
  await exclusiveJson(RUNTIME_RUN + "/result.json", {
    status: failure ?? result.status,
    role: RUNTIME_ROLE,
    approvalId: packet.approvalId,
    automaticRetry: false,
  });
  if (failure) throw fail(failure);
  return result;
}
export const LOGGING_SQL = `SELECT name,setting FROM pg_settings WHERE name IN
('log_statement','log_min_error_statement','log_min_duration_statement',
'log_min_duration_sample','log_transaction_sample_rate','log_duration',
'log_parameter_max_length','log_parameter_max_length_on_error',
'shared_preload_libraries','session_preload_libraries','local_preload_libraries',
'pg_stat_statements.track','pg_stat_statements.track_utility','pgaudit.log',
'log_statement_stats','log_parser_stats','log_planner_stats','log_executor_stats',
'auto_explain.log_min_duration') ORDER BY name`;
export const SAFE_LOGGING = {
  log_statement: "none",
  log_min_error_statement: "panic",
  log_min_duration_statement: "-1",
  log_min_duration_sample: "-1",
  log_transaction_sample_rate: "0",
  log_duration: "off",
  log_parameter_max_length: "0",
  log_parameter_max_length_on_error: "0",
  session_preload_libraries: "",
  local_preload_libraries: "",
  log_statement_stats: "off",
  log_parser_stats: "off",
  log_planner_stats: "off",
  log_executor_stats: "off",
};
export function validateAdminPacket(p, revision, now = Date.now()) {
  const ms = validatePacket(p, revision, now);
  if (
    p.administratorPasswordAssignmentApproved !== true ||
    p.inheritedCredentialRiskAcknowledged !== true ||
    p.providerLoggingReviewApproved !== true ||
    !/^[a-f0-9]{64}$/.test(p.loggingFingerprint ?? "") ||
    !/^[A-Za-z0-9-]{1,100}$/.test(p.providerLoggingReviewId ?? "")
  )
    throw fail("ADMIN_APPROVAL_REFUSED");
  return Math.min(ms, 120000);
}
export function loggingFingerprint(settings, extensions) {
  return createHash("sha256")
    .update(JSON.stringify({ settings, extensions }))
    .digest("hex");
}
export function assertLogging(settings, extensions, approvedFingerprint) {
  const values = Object.fromEntries(settings.map((r) => [r.name, r.setting]));
  if (
    settings.length !== new Set(settings.map((r) => r.name)).size ||
    Object.entries(SAFE_LOGGING).some(([k, v]) => values[k] !== v) ||
    values.shared_preload_libraries === undefined ||
    (values["pg_stat_statements.track"] !== undefined &&
      values["pg_stat_statements.track"] !== "none" &&
      values["pg_stat_statements.track_utility"] !== "off") ||
    (values["pgaudit.log"] !== undefined && values["pgaudit.log"] !== "none") ||
    (values["auto_explain.log_min_duration"] !== undefined &&
      values["auto_explain.log_min_duration"] !== "-1") ||
    !/^[a-f0-9]{64}$/.test(approvedFingerprint ?? "") ||
    loggingFingerprint(settings, extensions) !== approvedFingerprint
  )
    throw fail("LOGGING_REFUSED");
}
export function adminConnection(password) {
  return {
    host: TARGET.host,
    port: 5432,
    database: TARGET.database,
    user: "neondb_owner",
    password,
    ssl: { rejectUnauthorized: true },
    connectionTimeoutMillis: 5000,
    application_name: "signmons-p06-r02-private-handoff",
  };
}
export async function connectAdmin(client, budget) {
  // Connection failures (including certificate verification) never carry driver diagnostics.
  try {
    await budget.race(client.connect());
  } catch {
    throw fail("ADMIN_CONNECTION_REFUSED");
  }
}
export async function exclusiveJson(filename, data) {
  const file = await open(
    filename,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(JSON.stringify(data));
    await file.sync();
  } finally {
    await file.close();
  }
}
export async function writeRunner(root, secret) {
  if (!/^[a-f0-9]{64}$/.test(secret)) throw fail("GENERATED_SECRET_REFUSED");
  const file = await open(
    root + "/pgpass",
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  const identity = await file.stat();
  try {
    await file.writeFile(
      `${TARGET.host}:5432:${TARGET.database}:${TARGET.role}:${secret}\n`,
    );
    await file.sync();
    return { dev: identity.dev, ino: identity.ino };
  } catch {
    await removeRunner(root, identity);
    throw fail("PASSFILE_WRITE_FAILED");
  } finally {
    await file.close();
  }
}
export async function removeRunner(root, identity) {
  if (!identity) return;
  const s = await lstat(root + "/pgpass");
  if (!s.isFile() || s.dev !== identity.dev || s.ino !== identity.ino)
    throw fail("PASSFILE_CHANGED");
  await unlink(root + "/pgpass");
}
const rolesSQL = `SELECT rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,
rolreplication,rolbypassrls,(SELECT count(*)::int FROM pg_auth_members WHERE member=r.oid) AS memberships
FROM pg_roles r WHERE rolname IN ('p06_migration_owner','p06_migration_runner') ORDER BY rolname`;
async function catalog(budget, client) {
  const values = [];
  for (const q of CATALOG) values.push((await budget.query(client, q)).rows);
  return values;
}
export async function assignCore({
  client,
  budget,
  packet,
  root,
  database = TARGET.database,
  persist = writeRunner,
}) {
  let secret,
    sent = false;
  try {
    const identity = (
      await budget.query(
        client,
        "SELECT current_database() AS database,current_user AS role,current_setting('server_version_num')::int AS version",
      )
    ).rows[0];
    if (
      identity?.database !== database ||
      identity.role !== "neondb_owner" ||
      identity.version < 180000 ||
      identity.version >= 190000
    )
      throw fail("ADMIN_IDENTITY_REFUSED");
    const roles = (await budget.query(client, rolesSQL)).rows;
    if (
      roles.length !== 2 ||
      roles[0].rolname !== "p06_migration_owner" ||
      roles[1].rolname !== TARGET.role ||
      roles.some(
        (r) =>
          [
            "rolcanlogin",
            "rolsuper",
            "rolcreatedb",
            "rolcreaterole",
            "rolreplication",
            "rolbypassrls",
          ].some((k) => r[k] !== false) || r.memberships !== 0,
      )
    )
      throw fail("ROLE_STATE_REFUSED");
    const permission = (
      await budget.query(
        client,
        `SELECT
      (SELECT rolcreaterole FROM pg_roles WHERE rolname=current_user) AS can_create,
      EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid
        WHERE r.rolname='p06_migration_runner' AND m.member=(SELECT oid FROM pg_roles WHERE rolname=current_user)
        AND m.admin_option) AS can_admin,
      (SELECT count(*)::int FROM pg_stat_activity WHERE usename='p06_migration_runner') AS sessions,
      (SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()) AS other_sessions`,
      )
    ).rows[0];
    if (
      !permission?.can_create ||
      !permission.can_admin ||
      permission.sessions !== 0 ||
      permission.other_sessions !== 0
    )
      throw fail("ADMIN_PERMISSION_REFUSED");
    const tables = (
      await budget.query(
        client,
        `SELECT schemaname,tablename,tableowner,
      has_table_privilege('p06_migration_runner',quote_ident(schemaname)||'.'||quote_ident(tablename),'SELECT') AS readable,
      has_table_privilege('p06_migration_runner',quote_ident(schemaname)||'.'||quote_ident(tablename),'INSERT,UPDATE,DELETE,TRUNCATE') AS writable
      FROM pg_tables WHERE schemaname NOT LIKE 'pg_%' AND schemaname<>'information_schema' ORDER BY schemaname,tablename`,
      )
    ).rows;
    sameMetadata(
      tables.map(({ schemaname, tablename }) => ({ schemaname, tablename })),
      TABLES,
    );
    if (
      tables.some(
        (t) =>
          t.tableowner !== "neondb_owner" ||
          t.readable !== true ||
          t.writable !== false,
      )
    )
      throw fail("TABLE_GRANTS_REFUSED");
    const settings = (await budget.query(client, LOGGING_SQL)).rows;
    const extensions = (
      await budget.query(
        client,
        "SELECT extname,extversion FROM pg_extension ORDER BY extname",
      )
    ).rows;
    assertLogging(settings, extensions, packet.loggingFingerprint);
    const before = await catalog(budget, client);
    await budget.query(client, "BEGIN");
    // Recheck role and logging state immediately before the one mutation.
    sameMetadata((await budget.query(client, rolesSQL)).rows, roles);
    assertLogging(
      (await budget.query(client, LOGGING_SQL)).rows,
      extensions,
      packet.loggingFingerprint,
    );
    if (
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(packet.endUtc) ||
      !Number.isFinite(Date.parse(packet.endUtc)) ||
      Date.parse(packet.endUtc) <= Date.now()
    )
      throw fail("WINDOW_REFUSED");
    secret = randomBytes(32).toString("hex");
    await persist(root, secret);
    budget.assertActive();
    sent = true;
    await budget.query(
      client,
      `ALTER ROLE p06_migration_runner PASSWORD '${secret}' VALID UNTIL '${packet.endUtc}'`,
    );
    secret = undefined;
    await budget.query(client, "COMMIT");
    sameMetadata((await budget.query(client, rolesSQL)).rows, roles);
    const expiry = (
      await budget.query(
        client,
        "SELECT rolvaliduntil::text AS expiry FROM pg_roles WHERE rolname='p06_migration_runner'",
      )
    ).rows[0]?.expiry;
    if (Date.parse(expiry) !== Date.parse(packet.endUtc))
      throw fail("EXPIRY_REFUSED");
    sameMetadata(await catalog(budget, client), before);
    return {
      status: "ASSIGNED_NOLOGIN",
      role: TARGET.role,
      endUtc: packet.endUtc,
    };
  } catch (e) {
    // Never expose even a typed driver error; after send, conservatively require readback.
    throw fail(
      sent
        ? "ASSIGNMENT_INDETERMINATE"
        : e instanceof BackupFailure
          ? e.message
          : "HANDOFF_REFUSED",
    );
  } finally {
    secret = undefined;
  }
}
export async function runAdmin(packet) {
  const command = async (bin, args) =>
    (await exec(bin, args, { timeout: 10000, maxBuffer: 1024 * 1024 })).stdout;
  const revision = (
    await command("/usr/bin/git", ["-C", REPO, "rev-parse", "HEAD"])
  ).trim();
  validateAdminPacket(packet, revision);
  if (
    (
      await command("/usr/bin/git", ["-C", REPO, "status", "--porcelain"])
    ).trim()
  )
    throw fail("SOURCE_CHECKOUT_DIRTY");
  if (!fstatSync(0).isFIFO()) throw fail("PRIVATE_PIPE_REQUIRED");
  await inspectStorage();
  for (const name of [
    "pgpass",
    "handoff.json",
    "attempt.json",
    "data",
    "source.dump",
  ])
    try {
      await lstat(RUN + "/" + name);
      throw fail("EXISTING_ARTIFACT_REFUSED");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  await exclusiveJson(RUN + "/handoff-attempt.json", {
    approvalId: packet.approvalId,
    sourceRevision: revision,
    endUtc: packet.endUtc,
  });
  let budget,
    client,
    passIdentity,
    result,
    failure,
    ready = false;
  try {
    budget = await BackupBudget.create({
      roots: [RUN],
      milliseconds: validateAdminPacket(packet, revision),
    });
    process.stdout.write("READY\n");
    let password = await readPipe(process.stdin, budget);
    client = new pg.Client(adminConnection(password));
    password = undefined;
    client.on("error", () => budget.abort("CONNECTION_FAILED"));
    client.on("notice", () => {});
    await connectAdmin(client, budget);
    result = await assignCore({
      client,
      budget,
      packet,
      root: RUN,
      persist: async (root, secret) => {
        passIdentity = await writeRunner(root, secret);
      },
    });
    await cleanupOwned({
      clients: [client],
      stop: async () => {},
      removePassfile: async () => {},
      eject: async () => {},
    });
    client = undefined;
    budget.assertActive();
    await exclusiveJson(RUN + "/handoff.json", {
      ...result,
      approvalId: packet.approvalId,
      sourceRevision: revision,
      administratorClosed: true,
    });
    ready = true;
  } catch (e) {
    failure = e instanceof BackupFailure ? e : fail("HANDOFF_REFUSED");
  } finally {
    budget?.close();
    if (failure)
      try {
        await exclusiveJson(RUN + "/handoff-failure.json", {
          status: "REFUSED",
          code: failure.message,
          approvalId: packet.approvalId,
          automaticRetry: false,
        });
      } catch {
        /* Attempt marker still prevents retry; never expose raw errors. */
      }
    try {
      await cleanupOwned({
        clients: client ? [client] : [],
        stop: async () => {},
        removePassfile: async () => {
          if (!ready) await removeRunner(RUN, passIdentity);
        },
        eject: async () => {
          if (!ready)
            await command("/usr/bin/hdiutil", [
              "detach",
              await inspectStorage(false),
            ]);
        },
      });
    } catch {
      failure = fail("CLEANUP_FAILED");
      ready = false;
    }
  }
  if (failure) {
    // Best effort non-secret status; ejection may already have made it inaccessible.
    throw failure;
  }
  // Success intentionally hands off the mounted runner file to the separately approved backup.
  return result;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.umask(0o077);
  try {
    const runtime = process.argv[2] === "--runtime-initial-password";
    if (runtime) {
      if (
        process.argv.length !== 4 ||
        process.argv[3] !== RUNTIME_RUN + "/approval.json"
      )
        throw fail("APPROVAL_PACKET_REQUIRED");
      await runRuntimeAdmin(
        JSON.parse((await privateFile(process.argv[3], 8192)).data),
      );
      process.stdout.write("RUNTIME_HANDOFF_READY\n");
    } else {
      if (
        process.argv.length !== 3 ||
        process.argv[2] !== RUN + "/approval.json"
      )
        throw fail("APPROVAL_PACKET_REQUIRED");
      const packet = JSON.parse(
        (await privateFile(process.argv[2], 8192)).data,
      );
      await runAdmin(packet);
      process.stdout.write("HANDOFF_READY\n");
    }
  } catch (e) {
    process.stdout.write("HANDOFF_REFUSED\n");
    process.exitCode = 1;
  }
}
