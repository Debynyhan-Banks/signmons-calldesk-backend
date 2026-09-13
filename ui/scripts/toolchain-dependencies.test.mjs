import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const consumer = (name) => createRequire(require.resolve(name));
const eslintRequire = consumer("eslint");
const estreeRequire = consumer("@typescript-eslint/typescript-estree");
const minimatch3Require = createRequire(eslintRequire.resolve("minimatch"));
const minimatch9Require = createRequire(estreeRequire.resolve("minimatch"));
const cacheRequire = consumer("flat-cache");
const globRequire = consumer("tinyglobby");
const lock = JSON.parse(
  await readFile(new URL("../package-lock.json", import.meta.url), "utf8"),
);
const copies = [
  [eslintRequire, "ajv", "6.15.0", "node_modules/ajv"],
  [eslintRequire, "js-yaml", "4.3.2", "node_modules/js-yaml"],
  [eslintRequire, "minimatch", "3.1.5", "node_modules/minimatch"],
  [
    estreeRequire,
    "minimatch",
    "9.0.9",
    "node_modules/@typescript-eslint/typescript-estree/node_modules/minimatch",
  ],
  [
    minimatch3Require,
    "brace-expansion",
    "1.1.18",
    "node_modules/brace-expansion",
  ],
  [
    minimatch9Require,
    "brace-expansion",
    "2.1.4",
    "node_modules/@typescript-eslint/typescript-estree/node_modules/brace-expansion",
  ],
  [cacheRequire, "flatted", "3.4.4", "node_modules/flatted"],
  [globRequire, "picomatch", "4.0.7", "node_modules/picomatch"],
];

for (const [resolve, name, version, path] of copies) {
  test(`${path} resolves the reviewed patch through its toolchain consumer`, () => {
    assert.equal(resolve(`${name}/package.json`).version, version);
    assert.equal(lock.packages[path].version, version);
    assert.equal(lock.packages[path].dev, true);
  });
}

test("Ajv still accepts valid configuration and rejects invalid fields", () => {
  const Ajv = eslintRequire("ajv");
  const validate = new Ajv().compile({
    type: "object",
    properties: { enabled: { type: "boolean" } },
    required: ["enabled"],
    additionalProperties: false,
  });
  assert.equal(validate({ enabled: true }), true);
  assert.equal(validate({ enabled: "yes" }), false);
  assert.equal(validate({ enabled: true, unexpected: 1 }), false);
});

test("YAML configuration round-trip and bounded aliases remain supported", () => {
  const yaml = eslintRequire("js-yaml");
  const data = yaml.load(
    "defaults: &defaults\n  enabled: true\ncopy:\n  <<: *defaults\n  count: 2\n",
  );
  assert.deepEqual(data.copy, { enabled: true, count: 2 });
  assert.deepEqual(yaml.load(yaml.dump(data)), data);
});

test("flatted preserves cyclic cache data", () => {
  const flatted = cacheRequire("flatted");
  const data = { label: "synthetic" };
  data.self = data;
  const restored = flatted.parse(flatted.stringify(data));
  assert.equal(restored.label, "synthetic");
  assert.equal(restored.self, restored);
});

test("flatted does not expose a prototype via an untrusted reference", () => {
  const result = cacheRequire("flatted").parse('[{"value":"__proto__"}]');
  assert.notEqual(result.value, Array.prototype);
  assert.notEqual(result.value, Object.prototype);
});

test("both brace-expansion copies preserve ordinary file patterns", () => {
  for (const resolve of [minimatch3Require, minimatch9Require]) {
    assert.deepEqual(
      resolve("brace-expansion")("src/{app,lib}/file{1..2}.ts"),
      [
        "src/app/file1.ts",
        "src/app/file2.ts",
        "src/lib/file1.ts",
        "src/lib/file2.ts",
      ],
    );
  }
});

test("both minimatch copies preserve include/exclude behavior", () => {
  for (const resolve of [eslintRequire, estreeRequire]) {
    const api = resolve("minimatch");
    const match = typeof api === "function" ? api : api.minimatch;
    assert.equal(match("src/app/page.tsx", "src/**/*.{ts,tsx}"), true);
    assert.equal(match("src/app/page.css", "src/**/*.{ts,tsx}"), false);
    assert.equal(match("src/.hidden.ts", "src/**/*.ts"), false);
  }
});

test("picomatch preserves file discovery behavior", () => {
  const match = globRequire("picomatch")("src/**/*.{ts,tsx}");
  assert.equal(match("src/lib/api.ts"), true);
  assert.equal(match("src/app/page.tsx"), true);
  assert.equal(match("node_modules/example/index.ts"), false);
});

test("ESLint still detects a deliberately invalid synthetic source", async () => {
  const { ESLint } = require("eslint");
  const eslint = new ESLint({
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    useEslintrc: false,
    overrideConfig: {
      env: { es2022: true },
      rules: { "no-unused-vars": "error" },
    },
  });
  const [result] = await eslint.lintText("const unused = 1;", {
    filePath: "toolchain-fixture.js",
  });
  assert.equal(result.errorCount, 1);
  assert.equal(result.messages[0].ruleId, "no-unused-vars");
});
