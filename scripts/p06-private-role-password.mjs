// Explicitly approved one-role handoff only. Imports never connect or read secrets.
import { randomBytes, createHash } from "node:crypto";
import { constants, fstatSync } from "node:fs";
import { open, lstat, unlink } from "node:fs/promises";
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
    if (process.argv.length !== 3 || process.argv[2] !== RUN + "/approval.json")
      throw fail("APPROVAL_PACKET_REQUIRED");
    const packet = JSON.parse((await privateFile(process.argv[2], 8192)).data);
    await runAdmin(packet);
    process.stdout.write("HANDOFF_READY\n");
  } catch (e) {
    process.stdout.write("HANDOFF_REFUSED\n");
    process.exitCode = 1;
  }
}
