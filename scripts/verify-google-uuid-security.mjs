// Synthetic dependency fixtures only. No credentials, provider calls or sockets.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Socket } from "node:net";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { after, mock, test } from "node:test";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const manifest = require("../package.json");
const lock = require("../package-lock.json");
const consumers = [
  ["gaxios", "6.7.1"],
  ["google-gax", "4.6.1"],
  ["teeny-request", "9.0.0"],
];
// Fail closed if a fixture accidentally reaches a real transport.
let socketAttempts = 0;
mock.method(Socket.prototype, "connect", () => {
  socketAttempts++;
  throw new Error("Network forbidden in UUID dependency fixtures");
});
mock.method(globalThis, "fetch", () => {
  throw new Error("Global fetch forbidden in UUID dependency fixtures");
});
after(() => {
  mock.restoreAll();
  assert.equal(socketAttempts, 0);
});

for (const [name, version] of consumers) {
  test(`${name} keeps its reviewed version and resolves patched CJS and ESM UUID`, async () => {
    const consumerRequire = createRequire(require.resolve(name));
    const pkg = consumerRequire("uuid/package.json");
    assert.equal(require(`${name}/package.json`).version, version);
    assert.equal(manifest.overrides[`${name}@${version}`].uuid, "11.1.1");
    assert.equal(pkg.version, "11.1.1");
    assert.equal(lock.packages["node_modules/uuid"].version, "11.1.1");
    const cjs = consumerRequire("uuid");
    const esm = await import(
      pathToFileURL(
        join(
          dirname(consumerRequire.resolve("uuid/package.json")),
          pkg.exports["."].node.import,
        ),
      ).href
    );
    for (const api of [cjs, esm]) {
      const ids = Array.from({ length: 32 }, () => api.v4());
      assert.equal(new Set(ids).size, ids.length);
      for (const id of ids) {
        assert.equal(api.validate(id), true);
        assert.equal(api.version(id), 4);
        assert.equal(api.stringify(api.parse(id)), id);
      }
    }
  });
}

const uuid = require("uuid");
function generate(name, buffer, offset) {
  return name === "v6"
    ? uuid.v6(
        { msecs: 0, nsecs: 0, clockseq: 1, node: [1, 2, 3, 4, 5, 6] },
        buffer,
        offset,
      )
    : uuid[name]("synthetic-fixture", uuid[name].DNS, buffer, offset);
}
for (const name of ["v3", "v5", "v6"]) {
  test(`${name} rejects short buffers and invalid integer ranges before any write`, () => {
    for (const BufferType of [Uint8Array, Buffer]) {
      for (const [length, offset] of [
        [0, 0],
        [8, 4],
        [16, -1],
        [16, 1],
        [32, 17],
      ]) {
        const buffer =
          BufferType === Buffer
            ? Buffer.alloc(length, 170)
            : new Uint8Array(length).fill(170);
        const before = Array.from(buffer);
        assert.throws(() => generate(name, buffer, offset), RangeError);
        assert.deepEqual(Array.from(buffer), before);
      }
    }
  });
  test(`${name} retains deterministic IDs and exact-boundary buffer writes`, () => {
    const id = generate(name);
    assert.equal(uuid.validate(id), true);
    assert.equal(uuid.version(id), Number(name.slice(1)));
    assert.equal(generate(name), id);
    for (const offset of [0, 8]) {
      const buffer = new Uint8Array(offset + 16).fill(170);
      assert.equal(generate(name, buffer, offset), buffer);
      assert.deepEqual(
        Array.from(buffer.slice(0, offset)),
        Array(offset).fill(170),
      );
      assert.equal(uuid.stringify(buffer, offset), id);
    }
  });
}

test("inspected Google consumers use only zero-argument v4, not affected buffer APIs", () => {
  for (const [file, pattern] of [
    ["gaxios/build/src/gaxios.js", /\(0, uuid_1\.v4\)\(\)/],
    ["google-gax/build/src/util.js", /\(0, uuid_1\.v4\)\(\)/],
    ["teeny-request/build/src/index.js", /uuid\.v4\(\)/],
  ]) {
    const source = readFileSync(require.resolve(file), "utf8");
    assert.match(source, pattern);
    assert.doesNotMatch(source, /uuid(?:_1)?\.(?:v1|v3|v5|v6|v7)\b/);
  }
});

test("real google-gax request ID helper still returns ordinary v4 IDs", () => {
  const { makeUUID } = require("google-gax/build/src/util.js");
  const first = makeUUID(),
    second = makeUUID();
  assert.equal(uuid.version(first), 4);
  assert.equal(uuid.version(second), 4);
  assert.notEqual(first, second);
});

function assertMultipart(headers, body) {
  const header = headers["Content-Type"];
  const boundary = header.replace("multipart/related; boundary=", "");
  assert.equal(uuid.version(boundary), 4);
  assert.ok(body.includes(`--${boundary}\r\n`));
  assert.ok(body.includes(`--${boundary}--`));
  assert.ok(body.includes('{"fixture":true}'));
  assert.ok(body.includes("synthetic-payload"));
}
const multipart = () => [
  { "Content-Type": "application/json", body: '{"fixture":true}' },
  { "Content-Type": "text/plain", body: Readable.from(["synthetic-payload"]) },
];

test("real gaxios multipart preparation retains UUID boundary and payload via an isolated adapter", async () => {
  const { Gaxios } = require("gaxios");
  let calls = 0;
  const response = await new Gaxios().request({
    url: "https://fixture.invalid/upload",
    method: "POST",
    multipart: multipart().map((part) => ({
      headers: { "Content-Type": part["Content-Type"] },
      content: part.body,
    })),
    adapter: async (config) => {
      calls++;
      let body = "";
      for await (const chunk of config.body) body += chunk.toString();
      assertMultipart(config.headers, body);
      return {
        config,
        data: { fixture: true },
        status: 200,
        statusText: "OK",
        headers: {},
      };
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(response.data, { fixture: true });
});

test("real teeny-request multipart preparation retains UUID boundary and callback contract", async () => {
  const teenyRequire = createRequire(require.resolve("teeny-request"));
  const fetchPath = teenyRequire.resolve("node-fetch");
  const originalFetch = teenyRequire("node-fetch");
  let calls = 0;
  require.cache[fetchPath].exports = Object.assign(async (_url, options) => {
    calls++;
    let body = "";
    for await (const chunk of options.body) body += chunk.toString();
    assertMultipart(options.headers, body);
    return new originalFetch.Response('{"fixture":true}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }, originalFetch);
  // TS's compiled default import reads .default; make that the fake too.
  require.cache[fetchPath].exports.default = require.cache[fetchPath].exports;
  const teenyPath = require.resolve("teeny-request");
  delete require.cache[teenyPath];
  try {
    const { teenyRequest } = require("teeny-request");
    const result = await new Promise((resolve, reject) => {
      teenyRequest(
        {
          uri: "https://fixture.invalid/upload",
          method: "POST",
          headers: {},
          multipart: multipart(),
        },
        (error, response, body) =>
          error ? reject(error) : resolve({ response, body }),
      );
    });
    assert.equal(calls, 1);
    assert.equal(result.response.statusCode, 200);
    assert.deepEqual(result.body, { fixture: true });
  } finally {
    require.cache[fetchPath].exports = originalFetch;
    delete require.cache[teenyPath];
  }
});

test("unchanged Firebase auth entrypoint initializes locally and rejects malformed tokens without credentials", async () => {
  const { initializeApp, deleteApp } = require("firebase-admin/app");
  const { getAuth } = require("firebase-admin/auth");
  const app = initializeApp(
    {
      projectId: "synthetic-uuid-fixture",
      credential: {
        getAccessToken: async () => {
          throw new Error("Credentials forbidden");
        },
      },
    },
    "uuid-security-fixture",
  );
  try {
    assert.equal(require("firebase-admin").SDK_VERSION, "13.10.0");
    await assert.rejects(getAuth(app).verifyIdToken("not-a-token"), {
      code: "auth/argument-error",
    });
  } finally {
    await deleteApp(app);
  }
});
