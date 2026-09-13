// Isolated, bounded dependency and Prisma configuration fixtures. No DB connections.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const configRequire = createRequire(require.resolve("@prisma/config"));
const entry = configRequire.resolve("deepmerge-ts");
const packageRoot = dirname(dirname(entry));
const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json")));
const merge = await import(
  pathToFileURL(join(packageRoot, pkg.exports.import)).href
);
const { loadConfigFromFile } = require("@prisma/config");

test("Prisma config resolves the exact reviewed override in both module modes", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url)),
  );
  const lock = JSON.parse(
    readFileSync(new URL("../package-lock.json", import.meta.url)),
  );
  assert.equal(
    manifest.overrides["@prisma/config@7.10.0"]["deepmerge-ts"],
    "8.0.2",
  );
  assert.equal(configRequire("@prisma/config/package.json").version, "7.10.0");
  assert.equal(pkg.version, "8.0.2");
  assert.equal(lock.packages["node_modules/deepmerge-ts"].version, "8.0.2");
  assert.equal(typeof merge.deepmerge, "function");
  assert.equal(typeof configRequire("deepmerge-ts").deepmerge, "function");
  // This exception is justified only for the inspected Prisma loader path.
  const loader = readFileSync(require.resolve("@prisma/config"), "utf8");
  assert.match(
    loader,
    /const \{ deepmerge \} = await import\("deepmerge-ts"\)/,
  );
  assert.match(loader, /merger: deepmerge/);
  assert.doesNotMatch(loader, /deepmergeInto|deepmergeFastUnsafe/);
});

function cycles() {
  const left = { left: 1 },
    right = { right: 2 };
  left.self = left;
  right.self = right;
  return [left, right];
}
for (const name of ["deepmerge", "deepmergeCustom"]) {
  test(`${name} preserves a two-object cycle without exhausting the stack`, () => {
    const [left, right] = cycles();
    const fn =
      name === "deepmergeCustom" ? merge.deepmergeCustom({}) : merge.deepmerge;
    const result = fn(left, right);
    assert.equal(result.self, result);
    assert.equal(result.left, 1);
    assert.equal(result.right, 2);
    assert.equal(left.self, left);
    assert.equal(left.right, undefined);
  });
}

test("deepmergeInto preserves cycles while keeping the source unmodified", () => {
  const [target, source] = cycles();
  merge.deepmergeInto(target, source);
  assert.equal(target.self, target);
  assert.equal(target.right, 2);
  assert.equal(source.left, undefined);
});

test("ordinary record precedence, array concatenation and shared subtrees remain compatible", () => {
  const shared = { value: "unchanged" };
  const left = {
    datasource: { url: "synthetic-a" },
    list: ["a"],
    one: shared,
    two: shared,
  };
  const right = {
    datasource: { url: "synthetic-b" },
    list: ["b"],
    one: { added: true },
  };
  const result = merge.deepmerge(left, right);
  assert.equal(result.datasource.url, "synthetic-b");
  assert.deepEqual(result.list, ["a", "b"]);
  assert.deepEqual(result.one, { value: "unchanged", added: true });
  assert.equal(result.two, shared);
  assert.equal(left.one.added, undefined);
  assert.deepEqual(left.list, ["a"]);
});

test("v8 deep Map behavior is explicit, not claimed to preserve v7 semantics", () => {
  const left = new Map([["key", { a: 1 }]]);
  const right = new Map([["key", { b: 2 }]]);
  assert.deepEqual(merge.deepmerge(left, right).get("key"), { a: 1, b: 2 });
  assert.deepEqual(left.get("key"), { a: 1 });
});

test("the ordinary deepmerge path does not mutate a previously shared source", () => {
  const source = { values: ["source"], nested: { a: 1 } };
  const first = merge.deepmerge({}, source);
  const target = merge.deepmerge(first, {
    values: ["later"],
    nested: { b: 2 },
  });
  assert.deepEqual(source, { values: ["source"], nested: { a: 1 } });
  assert.deepEqual(target.values, ["source", "later"]);
});

test("unused in-place API can retain source aliases and is not treated as mutation-safe", () => {
  const source = { values: ["source"], nested: { a: 1 } };
  const target = {};
  merge.deepmergeInto(target, source);
  // Explicitly document the observed limitation instead of waiving a failed
  // immutability claim. Prisma's inspected merger uses deepmerge, not this API.
  assert.equal(target.values, source.values);
  assert.equal(target.nested, source.nested);
});

async function fixture(source, run, extension = "mjs") {
  const root = await mkdtemp(join(tmpdir(), "calldesk-prisma-config-fixture-"));
  try {
    const path = join(root, `prisma.config.${extension}`);
    await writeFile(path, source);
    await run(
      await loadConfigFromFile({ configRoot: root, configFile: path }),
      root,
      path,
    );
  } finally {
    // Only this uniquely created fixture directory, never user or repo data.
    await rm(root, { recursive: true, force: true });
  }
}

for (const extension of ["mjs", "cjs"]) {
  test(`real Prisma loader retains datasource and path semantics for ${extension}`, async () => {
    const config = {
      schema: "prisma/schema.prisma",
      migrations: {
        path: "prisma/migrations",
        seed: "never-executed-fixture-command",
      },
      datasource: { url: "postgresql://fixture:fixture@127.0.0.1:1/fixture" },
    };
    await fixture(
      `${extension === "mjs" ? "export default" : "module.exports ="} ${JSON.stringify(config)};`,
      async (loaded, root, path) => {
        assert.equal(loaded.error, undefined);
        assert.equal(loaded.config.schema, resolve(root, config.schema));
        assert.equal(
          loaded.config.migrations.path,
          resolve(root, config.migrations.path),
        );
        assert.equal(loaded.config.migrations.seed, config.migrations.seed);
        assert.equal(loaded.config.datasource.url, config.datasource.url);
        assert.equal(loaded.resolvedPath, path);
      },
      extension,
    );
  });
}

test("Prisma rejects invalid config shape without accepting a datasource override", async () => {
  await fixture(
    "export default { schema: 123, datasource: { url: 456 } };",
    async (loaded) => {
      assert.equal(loaded.error._tag, "ConfigFileSyntaxError");
      assert.equal(loaded.config, undefined);
    },
  );
});

test("Prisma reports a missing explicitly selected config instead of silent fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "calldesk-prisma-config-fixture-"));
  try {
    const result = await loadConfigFromFile({
      configRoot: root,
      configFile: join(root, "missing.config.mjs"),
    });
    assert.equal(result.error._tag, "ConfigFileNotFound");
    assert.equal(result.config, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
