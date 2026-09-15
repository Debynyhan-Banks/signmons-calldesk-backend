import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import {
  reviewPacket,
  prepareBundle,
  googleSecretPorts,
  syntheticDatabase,
} from "./p06-runtime-packet.mjs";
import { fixture, authorization } from "./fixtures/p06-runtime-packet.mjs";
const require = createRequire(import.meta.url);
const {
  prepareControlledIntakeStartup,
} = require("../dist/communications/controlled-intake-startup.js");
function ports(values) {
  const used = new Set(),
    versions = { ...values };
  const calls = [];
  return {
    calls,
    versions,
    reserve: async (id) => {
      assert.ok(!used.has(id));
      used.add(id);
    },
    readVersion: async (name) => {
      calls.push("read");
      return { name, value: versions[name] };
    },
    addVersion: async (resource, payload) => {
      calls.push("upload");
      const name = resource + "/versions/2";
      versions[name] = payload.toString();
      return name;
    },
  };
}
test("strict target, numeric version, purpose, runtime and envelope refusals", () => {
  for (const mutate of [
    (p) => (p.target.host = "parent.invalid"),
    (p) => (p.target.branch = "parent"),
    (p) => (p.target.role = "postgres"),
    (p) => (p.envelope.secrets.digestKey = p.envelope.secrets.sessionKeys.a),
    (p) =>
      (p.envelope.secrets.digestKey = p.envelope.secrets.sessionKeys.a.replace(
        "/1",
        "/2",
      )),
    (p) =>
      (p.envelope.secrets.digestKey = p.envelope.secrets.digestKey.replace(
        "/1",
        "/latest",
      )),
    (p) =>
      (p.envelope.secrets.digestKey = p.envelope.secrets.digestKey.replace(
        "signmons",
        "foreign",
      )),
    (p) =>
      p.forbiddenResources.push(
        p.envelope.secrets.digestKey.split("/versions/")[0],
      ),
    (p) =>
      (p.bundleResource = p.envelope.secrets.digestKey.split("/versions/")[0]),
    (p) => (p.facts.revision = "other"),
    (p) => (p.envelope.extra = true),
    (p) => (p.envelope.enabled = false),
    (p) => (p.facts.flags.SMS_DELIVERY_ENABLED = "true"),
  ]) {
    const { packet } = fixture();
    mutate(packet);
    assert.throws(() => reviewPacket(packet), /P06_PACKET_INVALID/);
  }
});
test("bundle exact numeric provenance, private readback, replay and startup acceptance seam", async () => {
  const { packet, values } = fixture(),
    r = reviewPacket(packet),
    a = authorization(r, "prepare"),
    p = ports(values);
  const receipt = await prepareBundle(packet, a, p);
  assert.equal(receipt.status, "BUNDLE_VERIFIED");
  assert.deepEqual(receipt.sourceVersions, r.refs);
  assert.deepEqual(JSON.parse(p.versions[receipt.bundleVersion]), values);
  assert.ok(!JSON.stringify(receipt).includes(values[r.refs[0]]));
  await assert.rejects(prepareBundle(packet, a, p));
  // Existing startup parses the real envelope/map, then reaches DB authorization.
  let resourceCalls = 0;
  const env = {
    CONTROLLED_INTAKE_RUNTIME_JSON: JSON.stringify(packet.envelope),
    CONTROLLED_INTAKE_SECRETS_JSON: p.versions[receipt.bundleVersion],
    NODE_ENV: "production",
    GOOGLE_CLOUD_PROJECT: "signmons",
    K_SERVICE: packet.facts.service,
    K_CONFIGURATION: packet.facts.configuration,
    K_REVISION: packet.facts.revision,
    PORT: "8080",
    ...packet.facts.flags,
  };
  await assert.rejects(
    prepareControlledIntakeStartup(
      env,
      () => {
        resourceCalls++;
        throw Error("stop at synthetic DB boundary");
      },
      async () => ({ html: "fixture", script: "fixture" }),
    ),
  );
  assert.equal(resourceCalls, 1);
});
test("missing malformed duplicate material and mismatched readback never report success", async () => {
  for (const change of [
    "missing",
    "invalid",
    "duplicate",
    "mismatch",
    "upload-error",
    "read-error",
  ]) {
    const { packet, values } = fixture(),
      r = reviewPacket(packet),
      p = ports(values);
    if (change === "missing") delete p.versions[r.refs[0]];
    if (change === "invalid") p.versions[r.refs[0]] = "secret-bad";
    if (change === "duplicate") p.versions[r.refs[1]] = p.versions[r.refs[0]];
    if (change === "mismatch") {
      const read = p.readVersion;
      p.readVersion = async (n) =>
        n.includes("bundle") ? { name: n, value: "private mismatch" } : read(n);
    }
    if (change === "upload-error")
      p.addVersion = async () => {
        throw Error("PRIVATE token");
      };
    if (change === "read-error")
      p.readVersion = async () => {
        throw Error("PRIVATE token");
      };
    await assert.rejects(
      prepareBundle(packet, authorization(r, "prepare"), p),
      (e) => e.message === "P06_PACKET_REFUSED_OR_UNCONFIRMED" && !e.cause,
    );
    if (["missing", "invalid", "duplicate"].includes(change))
      assert.ok(!p.calls.includes("upload"));
  }
});
test("foreign/expired approval refuses before any secret port", async () => {
  for (const change of [
    { owner: "other" },
    { action: "activate" },
    { packetDigest: "f".repeat(64) },
    { sourceRevision: "b".repeat(40) },
    { endUtc: "2020-01-01T00:00:00.000Z" },
  ]) {
    const { packet, values } = fixture(),
      r = reviewPacket(packet),
      p = ports(values);
    await assert.rejects(
      prepareBundle(packet, { ...authorization(r, "prepare"), ...change }, p),
    );
    assert.equal(p.calls.length, 0);
  }
});
test("API adapter only exact Google resources; disabled retries; no raw payload in receipt", async () => {
  const calls = [];
  const auth = {
    request: async (o) => {
      calls.push(o);
      return {
        data:
          o.method === "GET"
            ? {
                name: "projects/signmons/secrets/a/versions/1",
                payload: { data: Buffer.from("fictional").toString("base64") },
              }
            : { name: "projects/signmons/secrets/b/versions/1" },
      };
    },
  };
  const p = googleSecretPorts(auth, async () => {});
  assert.equal(
    (await p.readVersion("projects/signmons/secrets/a/versions/1")).value,
    "fictional",
  );
  await p.addVersion("projects/signmons/secrets/b", Buffer.from("fictional"));
  assert.ok(
    calls.every(
      (x) =>
        x.retry === false &&
        x.timeout === 10000 &&
        x.url.startsWith(
          "https://secretmanager.googleapis.com/v1/projects/signmons/",
        ),
    ),
  );
  await assert.rejects(p.readVersion("projects/other/secrets/a/versions/1"));
});
test("only verified Signmons numeric-project alias canonicalizes", async () => {
  const auth = {
    request: async () => ({
      data: {
        name: "projects/845074063310/secrets/a/versions/1",
        payload: { data: Buffer.from("fictional").toString("base64") },
      },
    }),
  };
  const p = googleSecretPorts(auth, async () => {});
  assert.equal(
    (await p.readVersion("projects/signmons/secrets/a/versions/1")).name,
    "projects/signmons/secrets/a/versions/1",
  );
  auth.request = async () => ({
    data: {
      name: "projects/999999999999/secrets/a/versions/1",
      payload: { data: "" },
    },
  });
  await assert.rejects(p.readVersion("projects/signmons/secrets/a/versions/1"));
});

test("concurrent preparation reserves once; failed upload cannot be retried", async () => {
  const { packet, values } = fixture(),
    r = reviewPacket(packet),
    a = authorization(r, "prepare"),
    p = ports(values);
  p.addVersion = async () => {
    p.calls.push("upload");
    throw Error("private unknown upload outcome");
  };
  const results = await Promise.allSettled([
    prepareBundle(packet, a, p),
    prepareBundle(packet, a, p),
  ]);
  assert.ok(results.every((x) => x.status === "rejected"));
  assert.equal(p.calls.filter((x) => x === "upload").length, 1);
  await assert.rejects(prepareBundle(packet, a, p));
  assert.equal(p.calls.filter((x) => x === "upload").length, 1);
});

test("no executable implicit CLI; synthetic constructor rejects URLs or foreign database", () => {
  assert.throws(() =>
    syntheticDatabase({
      host: "example.com",
      database: "neondb",
      port: 5432,
      user: "x",
    }),
  );
  const result = spawnSync(
    process.execPath,
    ["scripts/p06-runtime-packet.mjs"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no action performed/);
  assert.equal(result.stdout, "");
});
