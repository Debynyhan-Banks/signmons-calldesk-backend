// Isolated multipart fixtures: synthetic streams and one uniquely owned temp directory.
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { test } from "node:test";
import { once } from "node:events";
const require = createRequire(import.meta.url);
const nestRequire = createRequire(
  require.resolve("@nestjs/platform-express/package.json"),
);
const multer = nestRequire("multer");
const { FileInterceptor } = require("@nestjs/platform-express");
const boundary = "calldesk-synthetic-boundary";
function body(parts) {
  return Buffer.from(
    parts
      .map(
        ({ name, value, filename }) =>
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"${filename ? `; filename="${filename}"` : ""}\r\n\r\n${value}\r\n`,
      )
      .join("") + `--${boundary}--\r\n`,
  );
}
function request(bytes) {
  const req = Readable.from([bytes]);
  req.headers = {
    "content-type": `multipart/form-data; boundary=${boundary}`,
    "content-length": String(bytes.length),
  };
  return req;
}
function parse(middleware, parts) {
  const req = request(body(parts));
  return new Promise((resolve) =>
    middleware(req, {}, (error) => resolve({ req, error })),
  );
}
const file = (value = "12345678") => ({
  name: "file",
  filename: "fictional.txt",
  value,
});
const delayed = (_req, _file, cb) => setImmediate(() => cb(null, true));

test("Nest resolves the scoped Multer patch without a framework upgrade", () => {
  const manifest = JSON.parse(
    fs.readFileSync(new URL("../package.json", import.meta.url)),
  );
  const lock = JSON.parse(
    fs.readFileSync(new URL("../package-lock.json", import.meta.url)),
  );
  assert.equal(
    manifest.overrides["@nestjs/platform-express@^11.2.3"].multer,
    "2.3.0",
  );
  assert.equal(
    nestRequire("@nestjs/platform-express/package.json").version,
    "11.2.3",
  );
  assert.equal(nestRequire("multer/package.json").version, "2.3.0");
  assert.equal(lock.packages["node_modules/multer"].version, "2.3.0");
});

test("bounded ordinary fields, arrays and literal brackets retain their shape", async () => {
  const { req, error } = await parse(
    multer({ limits: { fieldArrayIndexLimit: 2 } }).none(),
    [
      { name: "job[reference]", value: "synthetic" },
      { name: "tags[]", value: "one" },
      { name: "tags[]", value: "two" },
      { name: "slots[2]", value: "third" },
      { name: "literal[3]suffix", value: "literal" },
    ],
  );
  assert.equal(error, undefined);
  assert.equal(req.body.job.reference, "synthetic");
  assert.deepEqual(req.body.tags, ["one", "two"]);
  assert.equal(req.body.slots.length, 3);
  assert.equal(req.body["literal[3]suffix"], "literal");
});

test("configured array-index boundary rejects before constructing an oversized array", async () => {
  const { req, error } = await parse(
    multer({ limits: { fieldArrayIndexLimit: 2 } }).none(),
    [{ name: "items[3]", value: "synthetic" }],
  );
  assert.equal(error.code, "LIMIT_FIELD_ARRAY_INDEX");
  assert.equal(req.body.items, undefined);
});

test(
  "invalid append is returned to the error callback rather than escaping the process",
  { timeout: 2000 },
  async () => {
    // Two tiny fields create only sparse length metadata then an invalid push.
    // Never iterate or serialize the sparse array, and never send a conversion field.
    const { error } = await parse(multer().none(), [
      { name: "items[4294967294]", value: "synthetic" },
      { name: "items[]", value: "second" },
    ]);
    assert.equal(error.code, "INVALID_FIELD_NAME");
  },
);

for (const method of ["single", "array", "fields", "any"]) {
  test(`async file filter cannot bypass the size limit through ${method}`, async () => {
    const upload = multer({ limits: { fileSize: 8 }, fileFilter: delayed });
    const middleware =
      method === "fields"
        ? upload.fields([{ name: "file", maxCount: 1 }])
        : method === "any"
          ? upload.any()
          : upload[method]("file");
    const { error } = await parse(middleware, [file("123456789")]);
    assert.equal(error.code, "LIMIT_FILE_SIZE");
  });
}

test("Nest's new array-index error requires an explicit HTTP mapping before future upload routes", async () => {
  const Interceptor = FileInterceptor("file", {
    limits: { fieldArrayIndexLimit: 2 },
  });
  const req = request(body([{ name: "items[3]", value: "synthetic" }]));
  await assert.rejects(
    new Interceptor().intercept(
      {
        switchToHttp: () => ({
          getRequest: () => req,
          getResponse: () => ({}),
        }),
      },
      {
        handle: () =>
          assert.fail("rejected multipart input must not reach a handler"),
      },
    ),
    (error) =>
      error.code === "LIMIT_FIELD_ARRAY_INDEX" &&
      typeof error.getStatus === "undefined",
  );
});

test("an exactly-at-limit file passes an asynchronous filter unchanged", async () => {
  const { req, error } = await parse(
    multer({ limits: { fileSize: 8 }, fileFilter: delayed }).single("file"),
    [file()],
  );
  assert.equal(error, undefined);
  assert.equal(req.file.size, 8);
  assert.equal(req.file.buffer.toString(), "12345678");
});

test(
  "aborted disk stream releases the descriptor and removes its synthetic partial file",
  { timeout: 2000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "calldesk-multer-fixture-"));
    const original = fs.createWriteStream;
    let output;
    const input = new PassThrough();
    try {
      // Observe the real write stream in this isolated runner; restore immediately.
      fs.createWriteStream = (...args) => {
        output = original(...args);
        return output;
      };
      const storage = multer.diskStorage({
        destination: root,
        filename: (_req, _file, cb) => cb(null, "partial.txt"),
      });
      const fixtureFile = { stream: input };
      const result = new Promise((resolve) =>
        storage._handleFile({}, fixtureFile, (error) => resolve(error)),
      );
      fs.createWriteStream = original;
      await once(output, "open");
      input.write("fictional partial data");
      input.destroy(new Error("synthetic aborted upload"));
      assert.match((await result).message, /synthetic aborted/);
      assert.equal(output.closed, true);
      assert.equal(output.fd, null);
      await new Promise((resolve, reject) =>
        storage._removeFile({}, fixtureFile, (error) =>
          error ? reject(error) : resolve(),
        ),
      );
      assert.deepEqual(await readdir(root), []);
    } finally {
      fs.createWriteStream = original;
      input.destroy();
      output?.destroy();
      // This exact test-owned directory only, never a checkout or user files.
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("Nest FileInterceptor preserves success, 413 and malformed-multipart 400 behavior", async () => {
  const Interceptor = FileInterceptor("file", {
    limits: { fileSize: 8 },
    fileFilter: delayed,
  });
  const invoke = (req) =>
    new Interceptor().intercept(
      {
        switchToHttp: () => ({
          getRequest: () => req,
          getResponse: () => ({}),
        }),
      },
      { handle: () => "synthetic-success" },
    );
  const good = request(body([file()]));
  assert.equal(await invoke(good), "synthetic-success");
  assert.equal(good.file.size, 8);
  await assert.rejects(
    invoke(request(body([file("123456789")]))),
    (error) => error.getStatus() === 413,
  );
  const malformed = request(Buffer.from("synthetic"));
  malformed.headers["content-type"] = "multipart/form-data";
  await assert.rejects(invoke(malformed), (error) => error.getStatus() === 400);
});
