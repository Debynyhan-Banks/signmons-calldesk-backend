// Isolated Node runner for the ESM filesystem dependency; synthetic files only.
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  lstat,
  readlink,
  symlink,
  rm,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { NodeHfs } from "@humanfs/node";

const require = createRequire(import.meta.url);
const eslintRequire = createRequire(require.resolve("eslint"));
const minimatchRequire = createRequire(eslintRequire.resolve("minimatch"));
const json = async (path) =>
  JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));

test("backend toolchain uses reviewed humanfs and brace-expansion releases", async () => {
  const lock = await json("../package-lock.json");
  assert.equal(
    import.meta.resolve("@humanfs/node"),
    new URL("../node_modules/@humanfs/node/src/index.js", import.meta.url).href,
  );
  assert.equal(
    (await json("../node_modules/@humanfs/node/package.json")).version,
    "0.16.8",
  );
  assert.equal(
    minimatchRequire("brace-expansion/package.json").version,
    "1.1.18",
  );
  for (const [name, version] of [
    ["@humanfs/node", "0.16.8"],
    ["@humanfs/core", "0.19.2"],
    ["@humanfs/types", "0.15.0"],
    ["brace-expansion", "1.1.18"],
  ]) {
    assert.equal(lock.packages[`node_modules/${name}`].version, version);
    assert.equal(lock.packages[`node_modules/${name}`].dev, true);
  }
});

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "calldesk-humanfs-fixture-"));
  try {
    await mkdir(join(root, "source"));
    await mkdir(join(root, "outside"));
    await writeFile(
      join(root, "outside", "synthetic.txt"),
      "fictional data only",
    );
    await writeFile(join(root, "source", "ordinary.txt"), "ordinary fixture");
    await symlink(
      join(root, "outside", "synthetic.txt"),
      join(root, "source", "file-link"),
    );
    await symlink(
      join(root, "outside"),
      join(root, "source", "directory-link"),
    );
    await run(root, new NodeHfs());
  } finally {
    // Only this test's uniquely created directory; never a repository or user data.
    await rm(root, { recursive: true, force: true });
  }
}

test("direct file copy preserves the symlink instead of materializing its target", async () => {
  await fixture(async (root, hfs) => {
    const destination = join(root, "copied-link");
    await hfs.copy(join(root, "source", "file-link"), destination);
    assert.equal((await lstat(destination)).isSymbolicLink(), true);
    assert.equal(
      await readlink(destination),
      join(root, "outside", "synthetic.txt"),
    );
  });
});

test("recursive copy preserves contained file and directory symlinks", async () => {
  await fixture(async (root, hfs) => {
    const destination = join(root, "copied-tree");
    await hfs.copyAll(join(root, "source"), destination);
    assert.equal(
      await readFile(join(destination, "ordinary.txt"), "utf8"),
      "ordinary fixture",
    );
    for (const link of ["file-link", "directory-link"]) {
      assert.equal(
        (await lstat(join(destination, link))).isSymbolicLink(),
        true,
      );
      assert.equal(
        await readlink(join(destination, link)),
        await readlink(join(root, "source", link)),
      );
    }
  });
});

test("ordinary direct copy remains supported", async () => {
  await fixture(async (root, hfs) => {
    await hfs.copy(
      join(root, "source", "ordinary.txt"),
      join(root, "copy.txt"),
    );
    assert.equal(
      await readFile(join(root, "copy.txt"), "utf8"),
      "ordinary fixture",
    );
  });
});

test("ESLint's brace expansion preserves bounded ordinary matching", () => {
  const expand = minimatchRequire("brace-expansion");
  assert.deepEqual(expand("src/{jobs,scheduling}/file{1..2}.ts"), [
    "src/jobs/file1.ts",
    "src/jobs/file2.ts",
    "src/scheduling/file1.ts",
    "src/scheduling/file2.ts",
  ]);
  const match = eslintRequire("minimatch");
  assert.equal(
    match("src/jobs/file1.ts", "src/{jobs,scheduling}/**/*.ts"),
    true,
  );
  assert.equal(
    match("src/payments/file1.ts", "src/{jobs,scheduling}/**/*.ts"),
    false,
  );
});
