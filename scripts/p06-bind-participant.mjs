// R08 private preparation only. No bundle upload, database, Twilio or verification request.
import assert from "node:assert/strict";
import { readFile, lstat, realpath, stat, open } from "node:fs/promises";
import { createHash, createHmac } from "node:crypto";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";

const repo = "/Users/debynyhanbanks/Web Projects/signmons-backend-r08-recovery";
const root = "/Volumes/Signmons-P06/r08-bundle-preparation-20260918";
const keyRef =
  "projects/signmons/secrets/signmons-staging-customer-digest-key/versions/1";
const accountRef =
  "projects/signmons/secrets/signmons-staging-twilio-account-sid/versions/1";
const mode = process.argv[2];
let key,
  phone,
  auth,
  stage = "LOCAL_PREFLIGHT";

try {
  process.chdir(repo);
  assert.ok(process.argv.length === 3 && ["--check", "--bind"].includes(mode));
  assert.equal(await realpath(root), root);
  const dir = await lstat(root);
  assert.equal(dir.uid, process.getuid());
  assert.equal(dir.mode & 0o777, 0o700);
  const binding = JSON.parse(
    await readFile(root + "/build-binding.json", "utf8"),
  );
  assert.equal(
    execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    binding.sourceRevision,
  );
  assert.equal(
    execFileSync("/usr/bin/git", ["status", "--porcelain"], {
      encoding: "utf8",
    }).trim(),
    "",
  );
  for (const [name, sha] of Object.entries(binding.builtFiles)) {
    assert.ok(name.startsWith("dist/") && !name.includes(".."));
    assert.equal(
      createHash("sha256")
        .update(await readFile(repo + "/" + name))
        .digest("hex"),
      sha,
    );
  }
  const { inspectStorage } = await import(
    repo + "/scripts/p06-backup-once.mjs"
  );
  await inspectStorage();
  try {
    await lstat(root + "/participant-binding.json");
    throw Error("already bound");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (mode === "--check") {
    process.stdout.write("LOCAL_CHECK_PASSED_NO_ACCESS\n");
  } else {
    assert.ok((await stat("/dev/stdin")).isFIFO());
    const { readPipe } = await import(repo + "/scripts/p06_backup_guards.mjs");
    let timer;
    const budget = {
      race: async (promise) => {
        try {
          return await Promise.race([
            promise,
            new Promise((_, reject) => {
              // Parent prompt is bounded at 60 seconds. Keep a cleanup margin so
              // the child never wins the deadline race while a valid line is sent.
              timer = setTimeout(() => reject(Error("timeout")), 65000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      },
    };
    stage = "INPUT_READY";
    process.stdout.write("READY\n");
    stage = "INPUT_PIPE";
    phone = await readPipe(process.stdin, budget);
    if (phone === "ABORT") {
      phone = undefined;
      process.stdout.write("PARTICIPANT_BINDING_ABORTED_NO_SMS\n");
    } else {
      // US SMS scope only; exact E.164 string is hashed as in DurableVerificationService.
      stage = "INPUT_FORMAT";
      assert.match(phone, /^\+1[2-9][0-9]{9}$/);
      const require = createRequire(repo + "/package.json");
      const { OAuth2Client } = require("google-auth-library");
      const { googleSecretPorts } = await import(
        repo + "/scripts/p06-runtime-packet.mjs"
      );
      stage = "GOOGLE_AUTH";
      const access = await promisify(execFile)(
        "/opt/homebrew/bin/gcloud",
        ["auth", "print-access-token", "--account=debynyhan@signmons.com"],
        { encoding: "utf8", timeout: 15000, maxBuffer: 16384 },
      );
      auth = new OAuth2Client();
      auth.setCredentials({ access_token: access.stdout.trim() });
      access.stdout = "";
      const ports = googleSecretPorts(auth, async () => {
        throw Error("No upload reservation authorized");
      });
      stage = "DIGEST_ACCESS";
      let material = await ports.readVersion(keyRef);
      stage = "DIGEST_FORMAT";
      assert.match(material.value, /^[a-f0-9]{64}$/i);
      key = Buffer.from(material.value, "hex");
      material = undefined;
      const participantHmac = createHmac("sha256", key)
        .update(phone)
        .digest("hex");
      phone = undefined;
      key.fill(0);
      key = undefined;
      stage = "ACCOUNT_ACCESS";
      const account = await ports.readVersion(accountRef);
      stage = "ACCOUNT_FORMAT";
      assert.match(account.value, /^AC[a-f0-9]{32}$/i);
      assert.ok(account.value.endsWith("c417"));
      const result = {
        sourceRevision: binding.sourceRevision,
        participant: "Debynyhan Banks",
        purpose: "R08 preparation only; no SMS or R10 authorization",
        digestKeyVersion: keyRef,
        participantHmac,
        accountSid: account.value,
        accountSidVersion: accountRef,
        boundAt: new Date().toISOString(),
      };
      stage = "SAVE_BINDING";
      const file = await open(root + "/participant-binding.json", "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(result, null, 2) + "\n");
        await file.sync();
      } finally {
        await file.close();
      }
      process.stdout.write("PARTICIPANT_BOUND_NO_SMS\n");
    }
  }
} catch (error) {
  const status = [400, 401, 403, 404, 429].includes(error?.response?.status)
    ? error.response.status
    : null;
  if (mode === "--bind") {
    const diagnostic = {
      recordKind: "participant-attempt",
      stage,
      httpStatus: status,
      noSms: true,
      checkedAt: new Date().toISOString(),
    };
    try {
      const file = await open(
        root + "/binding-diagnostic-" + Date.now() + ".json",
        "wx",
        0o600,
      );
      try {
        await file.writeFile(JSON.stringify(diagnostic) + "\n");
        await file.sync();
      } finally {
        await file.close();
      }
    } catch {}
  }
  process.stderr.write("PARTICIPANT_BINDING_REFUSED_NO_SMS:" + stage + "\n");
  process.exitCode = 1;
} finally {
  phone = undefined;
  if (key) key.fill(0);
  if (auth) auth.setCredentials({});
}
