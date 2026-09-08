import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";

// Resolve through the exact Next CSS build consumer, not just the UI root.
const require = createRequire(import.meta.url);
const nextRequire = createRequire(
  require.resolve("next/dist/build/webpack/config/blocks/css/index.js"),
);
const postcss = nextRequire("postcss");
const marker = "SYNTHETIC_MAP_CONTENT_NOT_CUSTOMER_DATA";
const mapData = {
  version: 3,
  sources: ["fixture-source.css"],
  names: [],
  mappings: "AAAA",
  sourcesContent: [marker],
};

async function withMapFixture(run) {
  const dir = await mkdtemp(join(tmpdir(), "calldesk-postcss-test-"));
  try {
    await mkdir(join(dir, "css"));
    await writeFile(join(dir, "outside.map"), JSON.stringify(mapData));
    await writeFile(join(dir, "css", "local.map"), JSON.stringify(mapData));
    await run(dir);
  } finally {
    // Only the unique synthetic fixture directory owned by this test.
    await rm(dir, { recursive: true, force: true });
  }
}

async function processMap(annotation, from) {
  return postcss([
    { postcssPlugin: "calldesk-map-fixture", Once() {} },
  ]).process(`a { color: red }\n/*# sourceMappingURL=${annotation} */`, {
    ...(from ? { from } : {}),
    to: "output.css",
    map: { inline: false },
  });
}
const hasMarker = (result) =>
  JSON.stringify(result.map?.toJSON() ?? {}).includes(marker);

test("Next CSS consumer resolves the exact scoped PostCSS security override", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(manifest.overrides?.["next@15.5.25"]?.postcss, "8.5.28");
  assert.equal(nextRequire("postcss/package.json").version, "8.5.28");
  const lock = JSON.parse(
    await readFile(new URL("../package-lock.json", import.meta.url), "utf8"),
  );
  assert.equal(lock.packages["node_modules/postcss"].version, "8.5.28");
});

test("untrusted absolute source map without from does not disclose fixture content", async () => {
  await withMapFixture(async (dir) => {
    assert.equal(hasMarker(await processMap(join(dir, "outside.map"))), false);
  });
});

test("untrusted relative traversal without from does not disclose fixture content", async () => {
  await withMapFixture(async (dir) => {
    const annotation = relative(process.cwd(), join(dir, "outside.map"));
    assert.ok(annotation.startsWith(".."));
    assert.equal(hasMarker(await processMap(annotation)), false);
  });
});

test("untrusted traversal outside the CSS directory does not disclose fixture content", async () => {
  await withMapFixture(async (dir) => {
    assert.equal(
      hasMarker(
        await processMap("../outside.map", join(dir, "css", "input.css")),
      ),
      false,
    );
  });
});

test("ordinary adjacent source maps remain supported", async () => {
  await withMapFixture(async (dir) => {
    assert.equal(
      hasMarker(await processMap("local.map", join(dir, "css", "input.css"))),
      true,
    );
  });
});

test("explicit previous map and ordinary plugin transformation remain supported", async () => {
  const result = await postcss([
    {
      postcssPlugin: "calldesk-synthetic-compatibility",
      Declaration(decl) {
        if (decl.prop === "color") decl.value = "blue";
      },
    },
  ]).process("a { color: red }", {
    from: "input.css",
    to: "output.css",
    map: { prev: mapData, inline: false },
  });
  assert.equal(result.css.includes("color: blue"), true);
  assert.equal(hasMarker(result), true);
});

test("CSS serialization escapes closing style sequences, including mixed case", () => {
  for (const tag of ["</style>", "</StYlE>"]) {
    const output = postcss
      .parse(`a { content: "${tag}<b>synthetic</b>" }`)
      .toResult().css;
    assert.equal(/<\/style/i.test(output), false);
    assert.equal(output.includes("synthetic"), true);
  }
});

test("inline source maps remain supported", async () => {
  const data = Buffer.from(JSON.stringify(mapData)).toString("base64");
  const result = await processMap(
    `data:application/json;base64,${data}`,
    "input.css",
  );
  assert.equal(hasMarker(result), true);
});
