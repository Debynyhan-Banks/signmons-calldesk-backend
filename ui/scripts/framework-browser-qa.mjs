// Local static export only. No credentials, external requests or mutations.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? "playwright"
);
const root = resolve(fileURLToPath(new URL("../out/", import.meta.url)));
const evidence =
  process.env.QA_EVIDENCE_DIR ??
  fileURLToPath(new URL("../../evidence/APP-013/", import.meta.url));
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".txt": "text/plain",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  const path = resolve(
    root,
    `.${pathname === "/" ? "/index.html" : extname(pathname) ? pathname : `${pathname}.html`}`,
  );
  if (!path.startsWith(`${root}/`)) return res.writeHead(403).end();
  try {
    const body = await readFile(path);
    res
      .writeHead(200, {
        "Content-Type": types[extname(path)] ?? "application/octet-stream",
      })
      .end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const cases = [
  ["/", "Dispatch sandbox"],
  ["/app/dispatch", "Assignment board"],
  ["/app/intake-review", "Booking readiness"],
  ["/app/routing", "Routing control center"],
  ["/app/urgency-review", "Escalation review"],
  ["/app/notifications", "Notification center"],
  ["/app/technician", "Your jobs"],
  ["/appointment/manage", "We could not open this booking"],
  ["/payment/status", "Check your booking for payment status"],
  ["/payment/status?payment=success", "Your payment was submitted"],
  ["/payment/status?payment=cancel", "Payment was not completed"],
];
let browser;
const errors = [],
  unexpected = [],
  failedResources = [];
let routeChecks = 0,
  homeNavigations = 0;
try {
  await mkdir(evidence, { recursive: true });
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH ??
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  for (const [name, width] of [
    ["desktop", 1440],
    ["mobile", 390],
  ]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("response", (response) => {
      if (response.status() >= 400) failedResources.push(response.url());
    });
    await page.route("**/*", async (route) => {
      if (
        new URL(route.request().url()).origin === origin &&
        route.request().method() === "GET"
      )
        return route.continue();
      unexpected.push({
        url: route.request().url(),
        method: route.request().method(),
      });
      await route.abort();
    });
    for (const [path, heading] of cases) {
      const response = await page.goto(`${origin}${path}`, {
        waitUntil: "load",
      });
      assert.equal(response.status(), 200, path);
      await page.getByRole("heading", { name: heading, exact: true }).waitFor();
      routeChecks++;
      if (path === "/app/technician") {
        await page
          .getByRole("alert")
          .filter({ hasText: "This technician link is missing" })
          .waitFor();
        assert.equal(
          await page
            .getByRole("button", { name: "Refresh", exact: true })
            .isDisabled(),
          true,
        );
      }
      if (path === "/payment/status?payment=success") {
        await page
          .getByText("Stripe is confirming the payment.", { exact: false })
          .waitFor();
      }
      if (path === "/appointment/manage") {
        await page.screenshot({
          path: resolve(evidence, `framework-missing-link-${name}.png`),
          fullPage: true,
        });
      }
      const home = page.locator('a[href="/"]');
      if (await home.count()) {
        await home.first().click();
        await page
          .getByRole("heading", { name: "Dispatch sandbox", exact: true })
          .waitFor();
        assert.equal(new URL(page.url()).pathname, "/");
        homeNavigations++;
      }
    }
    await page.close();
  }
  const manifestResponse = await fetch(`${origin}/manifest.webmanifest`);
  assert.equal(manifestResponse.status, 200);
  const manifest = await manifestResponse.json();
  assert.equal(manifest.start_url, "/app/technician");
  assert.equal(manifest.display, "standalone");
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  assert.deepEqual(failedResources, []);
  assert.equal(routeChecks, 22);
  assert.equal(homeNavigations, 12);
  console.log(
    JSON.stringify({
      result: "PASS",
      routeChecks,
      homeNavigations,
      staticManifest: true,
      externalRequests: unexpected.length,
      errors: errors.length,
      failedResources: failedResources.length,
    }),
  );
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}
