// Explicitly approved, source-specific backup only. No live action on import.
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  lstat,
  open,
  readFile,
  readdir,
  realpath,
  mkdir,
  unlink,
  statfs,
} from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import {
  BackupBudget,
  BackupFailure,
  compareTables,
  sameMetadata,
} from "./p06_backup_guards.mjs";

const exec = promisify(execFile);
const REPO = fileURLToPath(new URL("../", import.meta.url));
export const TARGET = Object.freeze({
  project: "soft-smoke-54063480",
  branch: "br-sparkling-sun-ay6gr5e8",
  host: "ep-jolly-flower-ayc6w9hv.c-5.us-east-2.aws.neon.tech",
  database: "neondb",
  role: "p06_migration_runner",
});
export const MOUNT = "/Volumes/Signmons-P06";
export const RUN = MOUNT + "/r02-backup-v2";
const IMAGE =
  "/Users/debynyhanbanks/Library/Application Support/Signmons/P06/signmons-p06.dmg.sparsebundle";
const UUID = "A0020084-32EC-412A-B96B-1AA68A2CE61F";
const BIN = "/opt/homebrew/opt/postgresql@18/bin/";
const bad = (code) => new BackupFailure(code);
const publicTables = [
  "AuditLog",
  "CommunicationContent",
  "CommunicationEvent",
  "Conversation",
  "ConversationJobLink",
  "Customer",
  "CustomerCoverageCheck",
  "Job",
  "JobOffer",
  "LedgerEntry",
  "Payment",
  "PropertyAddress",
  "RoutingRule",
  "ServiceArea",
  "ServiceCategory",
  "SmsConsentRecord",
  "StripeEvent",
  "TenantOrganization",
  "TenantSubscription",
  "User",
  "UserAvailabilityBlock",
  "UserServiceCapability",
  "_prisma_migrations",
];
export const TABLES = [
  ...["CallLog", "Job", "Tenant"].map((tablename) => ({
    schemaname: "legacy_2025",
    tablename,
  })),
  ...publicTables.map((tablename) => ({ schemaname: "public", tablename })),
];
const schemaFilter = "n.nspname IN ('public','legacy_2025')";
export const CATALOG = [
  "SELECT nspname,pg_get_userbyid(nspowner) AS owner,nspacl::text FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname<>'information_schema' ORDER BY nspname",
  `SELECT n.nspname,c.relname,c.relkind,pg_get_userbyid(c.relowner) AS owner,c.relacl::text,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${schemaFilter} ORDER BY n.nspname,c.relname`,
  `SELECT n.nspname,c.relname,a.attnum,a.attname,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull,a.attidentity,a.attgenerated,pg_get_expr(d.adbin,d.adrelid) AS default_expr FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum WHERE ${schemaFilter} AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped ORDER BY n.nspname,c.relname,a.attnum`,
  `SELECT n.nspname,c.relname,k.conname,k.contype,k.convalidated,pg_get_constraintdef(k.oid) AS definition FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${schemaFilter} ORDER BY n.nspname,c.relname,k.conname`,
  "SELECT schemaname,tablename,indexname,indexdef FROM pg_indexes WHERE schemaname IN ('public','legacy_2025') ORDER BY schemaname,tablename,indexname",
  `SELECT n.nspname,t.typname,pg_get_userbyid(t.typowner) AS owner,t.typacl::text,e.enumlabel,e.enumsortorder FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace JOIN pg_enum e ON e.enumtypid=t.oid WHERE ${schemaFilter} ORDER BY n.nspname,t.typname,e.enumsortorder`,
  `SELECT n.nspname,c.relname,t.tgname,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${schemaFilter} AND NOT t.tgisinternal ORDER BY n.nspname,c.relname,t.tgname`,
  `SELECT n.nspname,p.proname,pg_get_functiondef(p.oid) AS definition,pg_get_userbyid(p.proowner) AS owner,p.proacl::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE ${schemaFilter} AND p.prokind='f' ORDER BY n.nspname,p.proname,definition`,
  "SELECT extname,extversion,pg_get_userbyid(extowner) AS owner FROM pg_extension ORDER BY extname",
  "SELECT pg_get_userbyid(defaclrole) AS owner,defaclnamespace::regnamespace::text AS schema,defaclobjtype,defaclacl::text FROM pg_default_acl ORDER BY owner,schema,defaclobjtype",
];
export function validatePacket(p, revision, now = Date.now()) {
  if (
    !p ||
    p.owner !== "Debynyhan Banks" ||
    !/^P06-R02-[A-Za-z0-9-]{1,64}$/.test(p.approvalId ?? "") ||
    p.sourceRevision !== revision ||
    !/^[a-f0-9]{40}$/.test(revision ?? "") ||
    Object.keys(TARGET).some((k) => p[k] !== TARGET[k]) ||
    p.runDirectory !== RUN ||
    p.retentionDays !== 7 ||
    p.administratorCloseoutAcknowledged !== true
  )
    throw bad("PACKET_REFUSED");
  const dates = [p.startUtc, p.endUtc, p.verifiedAtUtc];
  if (
    dates.some(
      (x) =>
        typeof x !== "string" ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x) ||
        !Number.isFinite(Date.parse(x)) ||
        new Date(x).toISOString() !== x,
    )
  )
    throw bad("WINDOW_REFUSED");
  const [start, end, verified] = dates.map(Date.parse);
  if (
    end <= start ||
    end - start > 1200000 ||
    now < start ||
    now >= end ||
    verified > now ||
    now - verified > 300000 ||
    !Number.isFinite(p.remainingCUh) ||
    !(p.remainingCUh >= 1) ||
    !Number.isFinite(p.remainingTransferBytes) ||
    !(p.remainingTransferBytes >= 134217728) ||
    p.noOtherConsumersConfirmed !== true
  )
    throw bad("WINDOW_OR_QUOTA_REFUSED");
  return Math.floor(end - now);
}
export async function privateFile(filename, maxBytes) {
  const parent = path.dirname(filename);
  if ((await realpath(parent)) !== parent) throw bad("PRIVATE_PATH_REFUSED");
  const dir = await lstat(parent);
  if (
    !dir.isDirectory() ||
    dir.uid !== process.getuid() ||
    (dir.mode & 0o777) !== 0o700
  )
    throw bad("PRIVATE_PATH_REFUSED");
  const fd = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await fd.stat();
    if (
      !s.isFile() ||
      s.uid !== process.getuid() ||
      (s.mode & 0o777) !== 0o600 ||
      s.nlink !== 1 ||
      s.size > maxBytes
    )
      throw bad("PRIVATE_FILE_REFUSED");
    return { data: await fd.readFile("utf8"), dev: s.dev, ino: s.ino };
  } finally {
    await fd.close();
  }
}
export function parsePassfile(text) {
  if (
    !text.endsWith("\n") ||
    text.slice(0, -1).includes("\n") ||
    text.includes("\r")
  )
    throw bad("PASSFILE_REFUSED");
  const fields = [""];
  let escaped = false;
  for (const c of text.slice(0, -1)) {
    if (escaped) {
      if (c !== ":" && c !== "\\") throw bad("PASSFILE_REFUSED");
      fields[fields.length - 1] += c;
      escaped = false;
    } else if (c === "\\") escaped = true;
    else if (c === ":") fields.push("");
    else fields[fields.length - 1] += c;
  }
  if (
    escaped ||
    fields.length !== 5 ||
    fields.slice(0, 4).join(":") !==
      [TARGET.host, "5432", TARGET.database, TARGET.role].join(":") ||
    !/^[\x20-\x7e]{1,512}$/.test(fields[4])
  )
    throw bad("PASSFILE_REFUSED");
  return fields[4];
}
export async function reserveAttempt(root, packet) {
  const fd = await open(
    path.join(root, "attempt.json"),
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await fd.writeFile(
      JSON.stringify({
        approvalId: packet.approvalId,
        sourceRevision: packet.sourceRevision,
        startUtc: packet.startUtc,
        endUtc: packet.endUtc,
        partialRetentionExpiresUtc: new Date(
          Date.parse(packet.startUtc) + 7 * 86400000,
        ).toISOString(),
      }),
    );
    await fd.sync();
  } finally {
    await fd.close();
  }
}
export async function expectedHistory() {
  const base = path.join(REPO, "prisma/migrations");
  const names = (await readdir(base, { withFileTypes: true }))
    .filter((x) => x.isDirectory())
    .map((x) => x.name)
    .sort();
  if (names.length !== 26) throw bad("LOCAL_MANIFEST_REFUSED");
  return Promise.all(
    names.slice(0, 13).map(async (migration_name) => ({
      migration_name,
      checksum: createHash("sha256")
        .update(
          await readFile(path.join(base, migration_name, "migration.sql")),
        )
        .digest("hex"),
      finished: true,
      rolled_back: false,
    })),
  );
}
const historySQL =
  "SELECT migration_name,checksum,finished_at IS NOT NULL AS finished,rolled_back_at IS NOT NULL AS rolled_back FROM public._prisma_migrations ORDER BY migration_name";
async function catalog(budget, c) {
  const result = [];
  for (const sql of CATALOG) result.push((await budget.query(c, sql)).rows);
  return result;
}
// Shared by fixed live adapter and local integration. Source is NEVER mutated.
export async function backupCore({
  budget,
  source,
  target,
  database,
  role,
  history,
  archive,
  dump,
  restore,
}) {
  await budget.query(source, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const identity = (
    await budget.query(
      source,
      "SELECT current_database() AS database,current_user AS role,current_setting('server_version_num')::int AS version,pg_database_size(current_database())::float8 AS bytes",
    )
  ).rows[0];
  if (
    identity.database !== database ||
    identity.role !== role ||
    identity.version < 180000 ||
    identity.version >= 190000 ||
    identity.bytes > 33554432
  )
    throw bad("SOURCE_IDENTITY_REFUSED");
  const flags = (
    await budget.query(
      source,
      "SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=current_user",
    )
  ).rows[0];
  if (!flags || Object.values(flags).some((x) => x !== false))
    throw bad("SOURCE_ROLE_REFUSED");
  const tables = (
    await budget.query(
      source,
      "SELECT schemaname,tablename FROM pg_tables WHERE schemaname NOT LIKE 'pg_%' AND schemaname<>'information_schema' ORDER BY schemaname,tablename",
    )
  ).rows;
  sameMetadata(tables, TABLES);
  sameMetadata((await budget.query(source, historySQL)).rows, history);
  for (const { schemaname, tablename } of TABLES)
    await budget.query(
      source,
      `LOCK TABLE "${schemaname}"."${tablename}" IN ACCESS SHARE MODE`,
    );
  const before = await catalog(budget, source);
  sameMetadata(
    before[0].map((x) => x.nspname),
    ["legacy_2025", "public"],
  );
  const snapshot = (
    await budget.query(source, "SELECT pg_export_snapshot() AS id")
  ).rows[0].id;
  if (!/^[0-9A-Fa-f-]+$/.test(snapshot)) throw bad("SNAPSHOT_REFUSED");
  await dump(snapshot, archive);
  const dumpCompletedUtc = new Date().toISOString();
  await restore(archive);
  await budget.query(target, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  sameMetadata((await budget.query(target, historySQL)).rows, history);
  sameMetadata(await catalog(budget, target), before);
  const result = await compareTables(budget, source, target, TABLES);
  await budget.query(target, "ROLLBACK");
  await budget.query(source, "ROLLBACK");
  await budget.check();
  return { ...result, dumpCompletedUtc };
}
async function commandText(executable, args) {
  try {
    return (
      await exec(executable, args, {
        env: { PATH: "/usr/bin:/bin:/usr/sbin" },
        timeout: 10000,
        maxBuffer: 1024 * 1024,
      })
    ).stdout;
  } catch {
    throw bad("LOCAL_INSPECTION_FAILED");
  }
}
export async function inspectStorage(admission = true) {
  const disk = await commandText("/usr/sbin/diskutil", [
    "info",
    "-plist",
    MOUNT,
  ]);
  const stringValue = (key) =>
    new RegExp("<key>" + key + "</key>\\s*<string>([^<]+)</string>").exec(
      disk,
    )?.[1];
  const free = Number(
    /<key>APFSContainerFree<\/key>\s*<integer>(\d+)<\/integer>/.exec(disk)?.[1],
  );
  if (
    stringValue("VolumeUUID") !== UUID ||
    stringValue("MountPoint") !== MOUNT ||
    !/<key>GlobalPermissionsEnabled<\/key>\s*<true\/>/.test(disk) ||
    (admission && !(free >= 1073741824))
  )
    throw bad("MOUNT_REFUSED");
  const info = await commandText("/usr/bin/hdiutil", ["info"]);
  const blocks = info.split(/=+\n/);
  const block = blocks.find((x) =>
    x.split("\n").some((line) => line.trim() === "image-path      : " + IMAGE),
  );
  const device =
    block && /^(\/dev\/disk\d+)\s+GUID_partition_scheme/m.exec(block)?.[1];
  if (
    !device ||
    !/image-encrypted\s*:\s*TRUE/.test(block) ||
    !block.includes("\t" + MOUNT)
  )
    throw bad("IMAGE_REFUSED");
  const exclusion = await commandText("/usr/bin/tmutil", ["isexcluded", IMAGE]);
  if (admission && !exclusion.startsWith("[Excluded]"))
    throw bad("BACKUP_EXCLUSION_REFUSED");
  const space = await statfs(REPO);
  if (admission && space.bavail * space.bsize < 2147483648)
    throw bad("HOST_SPACE_REFUSED");
  return device;
}
async function localStop(root) {
  // Independent bounded cleanup survives an exhausted work budget; no SQL/data output.
  const pid = path.join(root, "data/postmaster.pid");
  try {
    await lstat(pid);
  } catch (e) {
    if (e.code === "ENOENT") return;
    throw bad("CLEANUP_FAILED");
  }
  await new Promise((resolve, reject) => {
    const child = spawn(
      BIN + "pg_ctl",
      ["-D", path.join(root, "data"), "-m", "fast", "-w", "-t", "15", "stop"],
      { env: { PATH: BIN }, stdio: "ignore" },
    );
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(bad("CLEANUP_FAILED"));
    }, 20000);
    child.on("error", () => {
      clearTimeout(timer);
      reject(bad("CLEANUP_FAILED"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(bad("CLEANUP_FAILED"));
    });
  });
}
export async function cleanupOwned({ clients, stop, removePassfile, eject }) {
  const failed = [];
  for (const c of clients) {
    let timer;
    try {
      await Promise.race([
        c.end(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            c.connection?.stream?.destroy();
            reject(bad("CLEANUP_FAILED"));
          }, 5000);
        }),
      ]);
    } catch {
      failed.push("connection");
    } finally {
      clearTimeout(timer);
    }
  }
  for (const [name, action] of [
    ["server", stop],
    ["passfile", removePassfile],
    ["image", eject],
  ]) {
    // Do not eject a still-running local server.
    if (name === "image" && failed.includes("server")) {
      failed.push("image");
      continue;
    }
    try {
      await action();
    } catch {
      failed.push(name);
    }
  }
  if (failed.length) throw bad("CLEANUP_FAILED");
}
export async function runLive(packet) {
  // Packet is an operator record, not a cryptographic substitute for user approval.
  const revision = (
    await commandText("/usr/bin/git", ["-C", REPO, "rev-parse", "HEAD"])
  ).trim();
  validatePacket(packet, revision);
  if (
    (
      await commandText("/usr/bin/git", ["-C", REPO, "status", "--porcelain"])
    ).trim()
  )
    throw bad("SOURCE_CHECKOUT_DIRTY");
  await inspectStorage();
  const handoff = JSON.parse(
    (await privateFile(RUN + "/handoff.json", 8192)).data,
  );
  validateHandoff(handoff, packet);
  const pass = await privateFile(RUN + "/pgpass", 2048);
  let password = parsePassfile(pass.data);
  pass.data = undefined;
  // All later filesystem operations are confined to this verified private root.
  const dir = await lstat(RUN);
  if (
    dir.uid !== process.getuid() ||
    (dir.mode & 0o777) !== 0o700 ||
    (await realpath(RUN)) !== RUN
  )
    throw bad("PRIVATE_PATH_REFUSED");
  for (const name of ["data", "socket", "source.dump", "result.json"]) {
    try {
      await lstat(RUN + "/" + name);
      throw bad("EXISTING_ARTIFACT_REFUSED");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  await reserveAttempt(RUN, packet);
  const clients = [];
  let budget;
  let result;
  let failure;
  const passIdentity = { dev: pass.dev, ino: pass.ino };
  try {
    budget = await BackupBudget.create({
      roots: [RUN],
      milliseconds: validatePacket(packet, revision),
    });
    const source = new pg.Client({
      host: TARGET.host,
      port: 5432,
      database: TARGET.database,
      user: TARGET.role,
      password,
      ssl: { rejectUnauthorized: true },
      connectionTimeoutMillis: 5000,
      application_name: "signmons-p06-r02-backup",
    });
    password = undefined;
    clients.push(source);
    source.on("error", () => budget.abort("CONNECTION_FAILED"));
    await budget.race(source.connect());
    const expiry = (
      await budget.query(
        source,
        "SELECT rolvaliduntil::text AS expiry FROM pg_roles WHERE rolname=current_user",
      )
    ).rows[0].expiry;
    if (Date.parse(expiry) !== Date.parse(packet.endUtc))
      throw bad("ROLE_EXPIRY_REFUSED");
    const sessions = (
      await budget.query(
        source,
        "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()",
      )
    ).rows[0].count;
    if (sessions !== 0) throw bad("SOURCE_BUSY");
    await mkdir(RUN + "/socket", { mode: 0o700 });
    const env = { PATH: BIN, TMPDIR: RUN, LC_ALL: "C" };
    await budget.command(
      BIN + "initdb",
      [
        "-D",
        RUN + "/data",
        "--username=p06_local_admin",
        "--encoding=UTF8",
        "--locale=C.UTF-8",
        "-A",
        "trust",
      ],
      { env },
    );
    await budget.command(
      BIN + "pg_ctl",
      [
        "-D",
        RUN + "/data",
        "-l",
        RUN + "/server.log",
        "-o",
        "-c listen_addresses='' -k " +
          RUN +
          "/socket -c log_min_messages=panic -c log_min_error_statement=panic -c log_statement=none -c log_error_verbosity=terse",
        "-w",
        "-t",
        "10",
        "start",
      ],
      { env },
    );
    const local = {
      host: RUN + "/socket",
      port: 5432,
      user: "p06_local_admin",
      connectionTimeoutMillis: 5000,
    };
    const admin = new pg.Client({ ...local, database: "postgres" });
    clients.push(admin);
    admin.on("error", () => budget.abort("CONNECTION_FAILED"));
    await budget.race(admin.connect());
    for (const role of [
      "neondb_owner",
      "cloud_admin",
      "neon_superuser",
      "p06_migration_owner",
      "p06_migration_runner",
    ])
      await budget.query(
        admin,
        `CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
      );
    await budget.query(admin, "CREATE DATABASE p06_restore OWNER neondb_owner");
    const target = new pg.Client({ ...local, database: "p06_restore" });
    clients.push(target);
    target.on("error", () => budget.abort("CONNECTION_FAILED"));
    await budget.race(target.connect());
    await budget.query(
      target,
      "GRANT CREATE ON DATABASE p06_restore TO cloud_admin",
    );
    await budget.query(
      target,
      "DROP EXTENSION plpgsql; SET ROLE cloud_admin; CREATE EXTENSION plpgsql; RESET ROLE",
    );
    await budget.query(
      target,
      "REVOKE CREATE ON DATABASE p06_restore FROM cloud_admin",
    );
    const archive = RUN + "/source.dump";
    const remoteEnv = {
      ...env,
      PGPASSFILE: RUN + "/pgpass",
      PGSSLMODE: "verify-full",
      PGSSLROOTCERT: "system",
    };
    result = await backupCore({
      budget,
      source,
      target,
      database: TARGET.database,
      role: TARGET.role,
      history: await expectedHistory(),
      archive,
      dump: (snapshot, file) =>
        budget.command(
          BIN + "pg_dump",
          [
            "-h",
            TARGET.host,
            "-p",
            "5432",
            "-U",
            TARGET.role,
            "--no-password",
            "--snapshot=" + snapshot,
            "-Fc",
            TARGET.database,
          ],
          { env: remoteEnv, archive: file },
        ),
      restore: (file) =>
        budget.command(
          BIN + "pg_restore",
          [
            "-h",
            local.host,
            "-p",
            "5432",
            "-U",
            local.user,
            "--no-password",
            "--exit-on-error",
            "--single-transaction",
            "-d",
            "p06_restore",
            file,
          ],
          { env },
        ),
    });
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(archive)) {
      budget.assertActive();
      hash.update(chunk);
    }
    result = {
      ...result,
      sha256: hash.digest("hex"),
      retentionExpiresUtc: new Date(
        Date.parse(result.dumpCompletedUtc) + 7 * 86400000,
      ).toISOString(),
      localCleanup: "PENDING",
      administratorRevocation: "REQUIRED",
      approvalId: packet.approvalId,
      sourceRevision: revision,
    };
    const output = await open(RUN + "/result.json", "wx", 0o600);
    try {
      await output.writeFile(JSON.stringify(result));
      await output.sync();
    } finally {
      await output.close();
    }
  } catch (e) {
    failure = e instanceof BackupFailure ? e : bad("BACKUP_FAILED");
  } finally {
    budget?.close();
    try {
      await cleanupOwned({
        clients,
        stop: () => localStop(RUN),
        removePassfile: async () => {
          const s = await lstat(RUN + "/pgpass");
          if (
            s.dev !== passIdentity.dev ||
            s.ino !== passIdentity.ino ||
            s.isSymbolicLink()
          )
            throw bad("PASSFILE_CHANGED");
          await unlink(RUN + "/pgpass");
        },
        eject: async () => {
          const device = await inspectStorage(false);
          await commandText("/usr/bin/hdiutil", ["detach", device]);
          try {
            await lstat(MOUNT);
            throw bad("EJECT_FAILED");
          } catch (e) {
            if (e.code !== "ENOENT") throw e;
          }
        },
      });
    } catch {
      failure = bad("CLEANUP_FAILED");
    }
  }
  if (failure) throw failure;
  return {
    ...result,
    localCleanup: "PASSED",
    administratorRevocation: "REQUIRED",
  };
}

export function validateHandoff(handoff, packet) {
  if (
    handoff?.status !== "ASSIGNED_NOLOGIN" ||
    handoff.approvalId !== packet.approvalId ||
    handoff.sourceRevision !== packet.sourceRevision ||
    handoff.endUtc !== packet.endUtc ||
    handoff.role !== TARGET.role ||
    handoff.administratorClosed !== true
  )
    throw bad("HANDOFF_REFUSED");
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.umask(0o077);
  try {
    if (process.argv.length !== 3 || process.argv[2] !== RUN + "/approval.json")
      throw bad("APPROVAL_PACKET_REQUIRED");
    const packet = JSON.parse((await privateFile(process.argv[2], 8192)).data);
    console.log(JSON.stringify(await runLive(packet)));
  } catch (e) {
    console.error(
      JSON.stringify({
        passed: false,
        code: e instanceof BackupFailure ? e.message : "PREFLIGHT_FAILED",
      }),
    );
    process.exitCode = 1;
  }
}
