// Local qualification only: a real restricted login in the disposable org DB.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { Pool } = require("pg"),
  { PrismaClient } = require("@prisma/client"),
  { PrismaPg } = require("@prisma/adapter-pg");

export async function qualifyRuntimeRole(admin) {
  const [db] = await admin.$queryRawUnsafe(
    "SELECT current_database() AS name, current_user AS owner, inet_server_addr() AS address, current_setting('server_version_num')::int AS version, current_setting('unix_socket_directories') AS socket",
  );
  assert.match(db.name, /^calldesk_org_[0-9a-f]{12}$/);
  assert.equal(db.address, null);
  assert.ok(db.version >= 180000 && db.version < 190000);
  assert.ok(
    db.socket === "/tmp" ||
      /^\/private\/tmp\/signmons-runtime-role-[A-Za-z0-9]+\/socket$/.test(
        db.socket,
      ),
  );
  assert.equal(
    (
      await admin.$queryRawUnsafe(
        "SELECT 1 FROM pg_roles WHERE rolname='p06_intake_runtime'",
      )
    ).length,
    0,
  );
  const sql = await readFile(
    new URL("./fixtures/p06-runtime-role-review.sql", import.meta.url),
    "utf8",
  );
  await admin.$transaction(async (tx) => {
    for (const statement of sql
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean))
      await tx.$executeRawUnsafe(statement);
    // ONLY this disposable local proof permits a passwordless Unix-socket login.
    await tx.$executeRawUnsafe("ALTER ROLE p06_intake_runtime LOGIN");
    await tx.$executeRawUnsafe(
      `GRANT CONNECT ON DATABASE "${db.name}" TO p06_intake_runtime`,
    );
  });
  const pool = new Pool({
    host: db.socket,
    port: 5432,
    database: db.name,
    user: "p06_intake_runtime",
    max: 2,
    connectionTimeoutMillis: 5000,
  });
  const runtime = new PrismaClient({ adapter: new PrismaPg(pool), log: [] });
  let closed = false;
  const close = async () => {
    if (closed) return;
    await runtime.$disconnect();
    if (!pool.ended) await pool.end();
    await admin.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("DROP OWNED BY p06_intake_runtime");
      await tx.$executeRawUnsafe("DROP ROLE p06_intake_runtime");
    });
    closed = true;
  };
  try {
    const [identity] = await runtime.$queryRawUnsafe(
      "SELECT current_user AS role, session_user AS session",
    );
    assert.deepEqual(identity, {
      role: "p06_intake_runtime",
      session: "p06_intake_runtime",
    });
    const [role] = await runtime.$queryRawUnsafe(
      "SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=current_user",
    );
    assert.ok(Object.values(role).every((v) => v === false));
    assert.equal(
      (
        await runtime.$queryRawUnsafe(
          "SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user)",
        )
      ).length,
      0,
    );
    for (const query of [
      'UPDATE "TenantOrganization" SET settings=settings WHERE false',
      'UPDATE "TenantOrganization" SET status=status WHERE false',
      'UPDATE "ServiceCategory" SET "basePriceCents"="basePriceCents" WHERE false',
      'UPDATE "Job" SET status=status WHERE false',
      'DELETE FROM "AuditLog" WHERE false',
      'UPDATE "AuditLog" SET action=action WHERE false',
      'DELETE FROM "AddressVerificationOperation" WHERE false',
      'SELECT * FROM "Payment" LIMIT 0',
      'SELECT * FROM "CalendarOperation" LIMIT 0',
      "SELECT * FROM pg_authid LIMIT 0",
      `SET ROLE "${db.owner.replaceAll('"', '""')}"`,
      "CREATE TABLE public.u02_forbidden (id int)",
      "CREATE ROLE p06_forbidden_role",
    ])
      await assert.rejects(
        runtime.$executeRawUnsafe(query),
        /permission denied/i,
      );
    // No sequences or user SECURITY DEFINER functions are needed by the reviewed schema.
    assert.equal(
      (
        await admin.$queryRawUnsafe(
          "SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='S'",
        )
      ).length,
      0,
    );
    assert.equal(
      (
        await admin.$queryRawUnsafe(
          "SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prosecdef",
        )
      ).length,
      0,
    );
    console.log(
      JSON.stringify({
        runtimeRole: {
          realRestrictedSession: true,
          negativePermissionCases: 13,
          liveActions: 0,
        },
      }),
    );
    return { prisma: runtime, close };
  } catch (error) {
    await close();
    throw error;
  }
}
