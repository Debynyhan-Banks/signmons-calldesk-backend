// Owner-authorized identity preparation only. No token issuance, messages, or deployment.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { Client } = require("pg");
const tenantId = "a1adcfd4-15be-404b-9ac3-5edb1fda20f0";
const uid = "staging-phone-owner-20260912";
const name = "Signmons Phone Test - Isolated 2026-09-12";
const claims = { tenantId, role: "owner", stagingOnly: true };
const settings = {
  stagingOnly: true,
  purpose: "owner-approved-phone-test",
  stagingPhoneTestApproval: { enabled: false },
};
if (process.argv[2] !== "--prepare-approved-disabled-identity")
  throw Error("Explicit identity-preparation argument required.");
const secret = (args) =>
  execFileSync("gcloud", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
let db;
try {
  const connectionString = secret([
    "secrets",
    "versions",
    "access",
    "latest",
    "--secret=signmons-staging-database-url",
    "--project=signmons",
  ]);
  const url = new URL(connectionString);
  assert.equal(
    url.hostname,
    "ep-nameless-frog-ayk5gr5y-pooler.c-5.us-east-2.aws.neon.tech",
  );
  assert.equal(url.pathname, "/neondb");
  db = new Client({ connectionString, connectionTimeoutMillis: 10000 });
  await db.connect();
  const prior = await db.query(
    'SELECT name, status, settings FROM "TenantOrganization" WHERE id=$1::uuid',
    [tenantId],
  );
  if (prior.rows.length) {
    assert.equal(prior.rows[0].name, name);
    assert.equal(prior.rows[0].status, "SUSPENDED");
    assert.deepEqual(prior.rows[0].settings, settings);
  }
  const token = secret(["auth", "print-access-token"]);
  const identity = async (action, body) => {
    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/projects/signmons/accounts:${action}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "x-goog-user-project": "signmons",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      },
    );
    const result = await response.json();
    if (!response.ok || result.error)
      throw Error(`Identity operation refused: HTTP ${response.status}`);
    return result;
  };
  let result = await identity("lookup", { localId: [uid] });
  if (!result.users?.length) {
    result = await identity("batchCreate", {
      hashAlgorithm: "BCRYPT",
      allowOverwrite: false,
      sanityCheck: true,
      users: [
        {
          localId: uid,
          displayName: name,
          disabled: true,
          customAttributes: JSON.stringify(claims),
        },
      ],
    });
    assert.equal((result.error || []).length, 0);
  }
  const verified = await identity("lookup", { localId: [uid] });
  assert.equal(verified.users?.length, 1);
  const user = verified.users[0];
  assert.equal(user.disabled, true);
  assert.equal(user.displayName, name);
  assert.deepEqual(JSON.parse(user.customAttributes), claims);
  assert.ok(!user.email && !user.phoneNumber && !user.passwordHash);
  await db.query("BEGIN");
  try {
    await db.query(
      'INSERT INTO "TenantOrganization" (id,name,status,timezone,settings,"createdAt","updatedAt") VALUES ($1::uuid,$2,\'SUSPENDED\',\'America/New_York\',$3::jsonb,now(),now()) ON CONFLICT (id) DO NOTHING',
      [tenantId, name, JSON.stringify(settings)],
    );
    const row = (
      await db.query(
        'SELECT name,status,settings,"chargesEnabled","payoutsEnabled" FROM "TenantOrganization" WHERE id=$1::uuid FOR UPDATE',
        [tenantId],
      )
    ).rows[0];
    assert.equal(row.name, name);
    assert.equal(row.status, "SUSPENDED");
    assert.deepEqual(row.settings, settings);
    assert.equal(row.chargesEnabled, false);
    assert.equal(row.payoutsEnabled, false);
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
  const counts = (
    await db.query(
      'SELECT (SELECT count(*) FROM "Customer" WHERE "tenantId"=$1::uuid) AS customers, (SELECT count(*) FROM "Conversation" WHERE "tenantId"=$1::uuid) AS conversations, (SELECT count(*) FROM "Job" WHERE "tenantId"=$1::uuid) AS jobs',
      [tenantId],
    )
  ).rows[0];
  assert.deepEqual(counts, { customers: "0", conversations: "0", jobs: "0" });
  console.log(
    JSON.stringify(
      {
        project: "signmons",
        tenantId,
        tenantStatus: "SUSPENDED",
        operatorUid: uid,
        operatorDisabled: true,
        claims,
        counts,
        sendingEnabled: false,
        sessionIssued: false,
        credentialsCreated: false,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    "Identity preparation did not fully complete. Any created operator remains disabled; inspect exact dedicated IDs before retry. No credential output.",
  );
  console.error(
    error?.code
      ? `Error code: ${error.code}`
      : "Validation or provider operation failed.",
  );
  process.exitCode = 1;
} finally {
  await db?.end();
}
