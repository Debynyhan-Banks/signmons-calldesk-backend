// Isolated local-only preview; never writes source, routes, hosting or credentials.
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const webpack = require("webpack");
const root = fileURLToPath(new URL("../", import.meta.url));
const httpSession = process.argv.includes("--http-session");
const output = await mkdtemp(
  join(tmpdir(), "signmons-calendar-review-preview-"),
);
await new Promise((resolve, reject) => {
  const compiler = webpack({
    mode: "development",
    devtool: false,
    entry: join(
      root,
      httpSession
        ? "scripts/calendar-review-session-preview.tsx"
        : "scripts/calendar-review-preview.tsx",
    ),
    output: { path: output, filename: "preview.js" },
    resolve: {
      extensions: [".tsx", ".ts", ".js"],
      modules: [join(root, "node_modules"), "node_modules"],
    },
    module: {
      rules: [
        {
          test: /\.(tsx?|css)$/,
          exclude: /node_modules/,
          use: join(root, "scripts/calendar-review-preview-loader.cjs"),
        },
      ],
    },
  });
  compiler.run((error, stats) =>
    compiler.close(() => {
      if (error || stats.hasErrors())
        reject(
          error ?? new Error(stats.toString({ all: false, errors: true })),
        );
      else resolve();
    }),
  );
});
const fixture = httpSession
  ? await (
      await import("../../scripts/calendar-review-browser-fixture.mjs")
    ).createCalendarReviewBrowserFixture()
  : null;
const html =
  '<!doctype html><html lang="en"><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Calendar review · Local synthetic preview</title><link rel="stylesheet" href="/review.css"><body style="margin:0;background:#f4f7fb"><div id="root"></div><script src="/fixture-config.js"></script><script defer src="/preview.js"></script></body></html>';
const server = createServer(async (request, response) => {
  if (request.method !== "GET") return response.writeHead(405).end();
  const path = new URL(request.url, "http://localhost").pathname;
  try {
    if (path === "/fixture-config.js")
      return response
        .writeHead(200, {
          "Content-Type": "application/javascript",
          "Cache-Control": "no-store",
        })
        .end(
          "window.calendarReviewFixtureOrigin=" +
            JSON.stringify(fixture?.origin ?? null),
        );
    if (path === "/fixture-metrics.json" && fixture)
      return response
        .writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        })
        .end(JSON.stringify(fixture.metrics()));
    if (path === "/")
      return response
        .writeHead(200, {
          "Content-Type": "text/html",
          "Cache-Control": "no-store",
          ...(fixture
            ? {
                "Content-Security-Policy": `default-src 'self'; connect-src ${fixture.origin}; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'none'`,
              }
            : {}),
        })
        .end(html);
    if (path === "/preview.js")
      return response
        .writeHead(200, { "Content-Type": "application/javascript" })
        .end(await readFile(join(output, "preview.js")));
    if (path === "/review.css")
      return response
        .writeHead(200, { "Content-Type": "text/css" })
        .end(
          await readFile(
            join(root, "src/calendar-review/review-panel.module.css"),
          ),
        );
    if (path === "/favicon.ico") return response.writeHead(204).end();
    response.writeHead(404).end();
  } catch {
    response.writeHead(500).end();
  }
});
server.listen(0, "127.0.0.1", () => {
  fixture?.setBrowserOrigin(`http://127.0.0.1:${server.address().port}`);
  console.log(
    JSON.stringify({
      url: `http://127.0.0.1:${server.address().port}`,
      output,
      syntheticOnly: true,
      apiOrigin: fixture?.origin,
    }),
  );
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () =>
    server.close(async () => {
      await fixture?.close();
      process.exit(0);
    }),
  );
