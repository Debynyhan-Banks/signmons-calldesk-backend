// Synthetic in-memory protocol fixtures only: no sockets, credentials or DB server.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { deflateSync } from "node:zlib";

const require = createRequire(import.meta.url);
const prismaRequire = createRequire(require.resolve("prisma/package.json"));
const mysqlRoot = dirname(prismaRequire.resolve("mysql2/package.json"));
const mysql = prismaRequire("mysql2");
const internal = (path) => require(join(mysqlRoot, "lib", path));
const { enableCompression } = internal("compressed_protocol.js");
const { authSwitchRequest } = internal("commands/auth_switch.js");
const AuthSwitchRequest = internal("packets/auth_switch_request.js");
const ConnectionConfig = internal("connection_config.js");

test("Prisma resolves the reviewed scoped override and unchanged PostgreSQL contract", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url)),
  );
  const lock = JSON.parse(
    readFileSync(new URL("../package-lock.json", import.meta.url)),
  );
  assert.equal(manifest.overrides["prisma@^7.10.0"].mysql2, "3.24.4");
  assert.equal(prismaRequire("prisma/package.json").version, "7.10.0");
  assert.equal(prismaRequire("mysql2/package.json").version, "3.24.4");
  assert.equal(lock.packages["node_modules/mysql2"].version, "3.24.4");
  assert.equal(lock.packages["node_modules/prisma"].version, "7.10.0");
  assert.equal(
    typeof prismaRequire("mysql2/promise").createConnection,
    "function",
  );
  assert.match(
    readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8"),
    /provider\s*=\s*"postgresql"/,
  );
});

function authFixture(options = {}, pluginName = "mysql_clear_password") {
  const writes = [];
  const connection = {
    config: new ConnectionConfig({
      password: "fictional-fixture-only",
      ...options,
    }),
    writePacket: (packet) => writes.push(packet),
  };
  const command = new EventEmitter();
  const errors = [];
  command.on("error", (error) => errors.push(error));
  const packet = new AuthSwitchRequest({
    pluginName,
    pluginData: Buffer.alloc(20, 1),
  }).toPacket();
  packet.offset = 4;
  return { connection, command, packet, writes, errors };
}

test("server-requested cleartext authentication is disabled by default before any write", async () => {
  const f = authFixture();
  assert.throws(() => authSwitchRequest(f.packet, f.connection, f.command), {
    code: "MYSQL_CLEAR_PASSWORD_NOT_ENABLED",
    fatal: true,
  });
  await new Promise(setImmediate);
  assert.equal(f.writes.length, 0);
  assert.equal(f.connection._authPlugin, undefined);
});

test("explicit cleartext opt-in remains a deliberate compatibility escape hatch", async () => {
  // In-memory only. This option is NOT added to CallDesk configuration.
  const f = authFixture({ enableCleartextPlugin: true });
  authSwitchRequest(f.packet, f.connection, f.command);
  await new Promise(setImmediate);
  assert.equal(f.errors.length, 0);
  assert.equal(f.writes.length, 1);
  assert.equal(
    f.writes[0].buffer.subarray(4).toString(),
    "fictional-fixture-only\0",
  );
});

test("prototype property names cannot select a standard auth plugin", () => {
  for (const name of ["toString", "__proto__", "constructor"]) {
    const f = authFixture({}, name);
    assert.throws(
      () => authSwitchRequest(f.packet, f.connection, f.command),
      /unknown plugin/,
    );
    assert.equal(f.writes.length, 0);
  }
});

function compressedFrame(
  payload,
  declaredLength = payload.length,
  sequence = 0,
) {
  const body = declaredLength === 0 ? payload : deflateSync(payload);
  const header = Buffer.alloc(7);
  header.writeUIntLE(body.length, 0, 3);
  header[3] = sequence;
  header.writeUIntLE(declaredLength, 4, 3);
  return Buffer.concat([header, body]);
}

function mysqlPacket(text) {
  const body = Buffer.from(text);
  const header = Buffer.alloc(4);
  header.writeUIntLE(body.length, 0, 3);
  return Buffer.concat([header, body]);
}

function compressionFixture(expected = 1) {
  const received = [],
    errors = [],
    bumps = [];
  let finish;
  const done = new Promise((resolve) => {
    finish = resolve;
  });
  const connection = {
    write: () => assert.fail("fixture must never write to a socket"),
    handlePacket: (packet) => {
      received.push(packet.readBuffer().toString());
      if (received.length === expected) finish();
    },
    _handleNetworkError: (error) => {
      errors.push(error);
      finish();
    },
    _bumpCompressedSequenceId: (count) => bumps.push(count),
  };
  enableCompression(connection);
  return { connection, received, errors, bumps, done };
}

test(
  "valid small compressed frame is decoded through the actual packet parser",
  { timeout: 2000 },
  async () => {
    const f = compressionFixture();
    f.connection.packetParser.execute(
      compressedFrame(mysqlPacket("synthetic row")),
    );
    await f.done;
    assert.deepEqual(f.received, ["synthetic row"]);
    assert.deepEqual(f.errors, []);
  },
);

for (const [name, declared, actual] of [
  ["synchronous", 16, 64],
  ["asynchronous", 17000, 18000],
]) {
  test(
    `${name} inflate rejects output beyond the advertised size before parsing`,
    { timeout: 2000 },
    async () => {
      const f = compressionFixture();
      // At most 18 KB, not a resource-exhausting payload.
      f.connection.packetParser.execute(
        compressedFrame(Buffer.alloc(actual, 65), declared),
      );
      await f.done;
      assert.equal(f.errors.length, 1);
      assert.equal(f.errors[0].code, "ERR_BUFFER_TOO_LARGE");
      assert.deepEqual(f.received, []);
      assert.deepEqual(f.bumps, []);
    },
  );
}

test(
  "asynchronous inflate preserves ordering before a queued uncompressed frame",
  { timeout: 2000 },
  async () => {
    const f = compressionFixture(2);
    const first = "A".repeat(17000);
    f.connection.packetParser.execute(compressedFrame(mysqlPacket(first)));
    f.connection.packetParser.execute(
      compressedFrame(mysqlPacket("second"), 0, 1),
    );
    await f.done;
    assert.deepEqual(f.received, [first, "second"]);
    assert.deepEqual(f.errors, []);
    assert.deepEqual(f.bumps, [1, 1]);
  },
);

test(
  "malformed compressed stream takes the error path without delivering a packet",
  { timeout: 2000 },
  async () => {
    const f = compressionFixture();
    const frame = Buffer.alloc(10);
    frame.writeUIntLE(3, 0, 3);
    frame.writeUIntLE(10, 4, 3);
    frame.fill(255, 7);
    f.connection.packetParser.execute(frame);
    await f.done;
    assert.equal(f.errors.length, 1);
    assert.deepEqual(f.received, []);
  },
);

test("replacement SQL escaping preserves bounded public formatting compatibility", () => {
  assert.equal(mysql.escape("O'Reilly"), "'O\\'Reilly'");
  assert.equal(mysql.escapeId("tenant.jobs"), "`tenant`.`jobs`");
  assert.equal(
    mysql.format("SELECT ? AS value, ? AS absent", [42, null]),
    "SELECT 42 AS value, NULL AS absent",
  );
  assert.equal(mysql.escape(Buffer.from([0, 255])), "X'00ff'");
});
