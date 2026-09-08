import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";
import nextConfig from "../next.config.mjs";

const require = createRequire(import.meta.url);
const readJson = async (path) =>
  JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const manifest = await readJson("../package.json");
const lock = await readJson("../package-lock.json");

for (const name of ["next", "react", "react-dom", "eslint-config-next"]) {
  test(`${name} installed version agrees with the exact manifest and lock`, () => {
    const expected =
      manifest.dependencies[name] ?? manifest.devDependencies[name];
    assert.match(expected, /^\d+\.\d+\.\d+$/);
    assert.equal(require(`${name}/package.json`).version, expected);
    assert.equal(lock.packages[`node_modules/${name}`].version, expected);
  });
}

test("framework and renderer companions stay aligned", () => {
  assert.equal(
    manifest.dependencies.next,
    manifest.devDependencies["eslint-config-next"],
  );
  assert.equal(manifest.dependencies.react, manifest.dependencies["react-dom"]);
});

test("hosting remains a static export, without a Next server rewrite", async () => {
  assert.equal(nextConfig.output, "export");
  const firebase = await readJson("../../firebase.json");
  const hosting = firebase.hosting.find((entry) => entry.target === "calldesk");
  assert.equal(hosting.public, "ui/out");
  assert.equal(hosting.cleanUrls, true);
  assert.equal(hosting.rewrites, undefined);
});
