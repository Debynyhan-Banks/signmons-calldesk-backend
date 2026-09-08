// Local static export + synthetic API responses only. Never connects to a provider or database.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? "playwright"
);
const root = fileURLToPath(new URL("../out/", import.meta.url));
const evidence = fileURLToPath(
  new URL("../../evidence/APP-013/", import.meta.url),
);
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  const path = resolve(
    root,
    `.${pathname === "/" ? "/index.html" : extname(pathname) ? pathname : `${pathname}.html`}`,
  );
  if (!path.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
  try {
    res.writeHead(200, {
      "Content-Type": types[extname(path)] ?? "application/octet-stream",
    });
    res.end(await readFile(path));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.CHROME_PATH ??
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const requests = [];
let mode = "ready";
let unblock;
let slowStarted;
const jobId = "10000000-0000-4000-8000-000000000001";
const records = ["DELIVERED", "SENT", "QUEUED", "FAILED", "DEAD_LETTER"].map(
  (status, index) => ({
    id: `20000000-0000-4000-8000-00000000000${index}`,
    jobId,
    direction: "OUTBOUND",
    status,
    attemptCount: status === "QUEUED" ? 0 : 1,
    lastErrorCode:
      status === "DEAD_LETTER"
        ? "stale_lifecycle_state"
        : status === "FAILED"
          ? "provider_unavailable"
          : null,
    occurredAt: "2026-09-08T14:00:00.000Z",
    terminalAt: null,
    templateId: "transactional_sms:appointment_confirmed:v1",
    templateKey:
      index === 4 ? "TECHNICIAN_ON_THE_WAY" : "APPOINTMENT_CONFIRMED",
    templateVersion: 1,
    body: "DO_NOT_RENDER_PRIVATE_BODY",
    phone: "DO_NOT_RENDER_PRIVATE_PHONE",
    providerId: "DO_NOT_RENDER_PROVIDER_ID",
  }),
);
await page.route("**/communications/sms/**", async (route) => {
  const request = route.request();
  if (request.method() === "OPTIONS") {
    await route.fulfill({
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization",
      },
    });
    return;
  }
  requests.push({ method: request.method(), url: request.url() });
  assert.equal(request.method(), "GET");
  assert.equal(new URL(request.url()).pathname, "/communications/sms/history");
  const responseMode = mode;
  if (responseMode === "slow") {
    slowStarted?.();
    await new Promise((done) => {
      unblock = done;
    });
  }
  await route.fulfill({
    status:
      responseMode === "denied" ? 403 : responseMode === "failure" ? 500 : 200,
    contentType: "application/json",
    headers: { "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify(
      responseMode === "denied" || responseMode === "failure"
        ? { message: "DO_NOT_RENDER_SERVER_PAYLOAD" }
        : responseMode === "empty"
          ? []
          : records,
    ),
  });
});

try {
  await page.goto(`${origin}/app/notifications`);
  await page
    .getByRole("heading", { name: "Notification center", exact: true })
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Load history" }).isDisabled(),
    true,
  );
  await page.getByLabel("Operator ID token").fill("synthetic-local-token");
  await page.getByLabel("Job ID").fill("invalid");
  assert.equal(
    await page.getByRole("button", { name: "Load history" }).isDisabled(),
    true,
  );
  await page.getByLabel("Job ID").fill(jobId);
  await page.getByRole("button", { name: "Load history" }).click();
  await page
    .getByRole("status")
    .filter({ hasText: "5 records shown" })
    .waitFor();
  assert.equal(new URL(requests[0].url).searchParams.get("jobId"), jobId);
  assert.equal(new URL(requests[0].url).searchParams.get("limit"), "100");
  assert.equal(
    (await page.locator("body").innerText()).includes("DO_NOT_RENDER"),
    false,
  );
  await page.screenshot({
    path: `${evidence}notifications-desktop.png`,
    fullPage: true,
  });
  await page
    .getByRole("combobox", { name: "History status" })
    .selectOption("attention");
  await page
    .getByRole("status")
    .filter({ hasText: "2 records shown" })
    .waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: `${evidence}notifications-mobile.png`,
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page
    .getByRole("combobox", { name: "History status" })
    .selectOption("all");
  mode = "empty";
  await page.getByRole("button", { name: "Load history" }).click();
  await page
    .getByRole("heading", { name: "No message activity found" })
    .waitFor();
  mode = "denied";
  await page.getByRole("button", { name: "Load history" }).click();
  await page.getByRole("alert").filter({ hasText: "Access denied" }).waitFor();
  mode = "failure";
  await page.getByRole("button", { name: "Load history" }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "could not be loaded" })
    .waitFor();
  mode = "slow";
  const started = new Promise((done) => {
    slowStarted = done;
  });
  await page.getByRole("button", { name: "Load history" }).click();
  await started;
  await page
    .getByRole("status")
    .filter({ hasText: "Loading message" })
    .waitFor();
  await page.getByRole("button", { name: "Clear session" }).click();
  const lateResponse = page.waitForResponse((response) =>
    response.url().includes("/communications/sms/history"),
  );
  unblock();
  await lateResponse;
  // Wait for the response body and React's next paint before checking stale data.
  await page.evaluate(
    () =>
      new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      ),
  );
  assert.equal(await page.locator("ol li").count(), 0);
  assert.equal(await page.getByLabel("Operator ID token").inputValue(), "");
  assert.equal(
    await page.evaluate(() => localStorage.length + sessionStorage.length),
    0,
  );
  assert.equal(
    (await page.locator("body").innerText()).includes("DO_NOT_RENDER"),
    false,
  );
  assert.deepEqual(errors, []);
  await page.getByLabel("Operator ID token").focus();
  await page.keyboard.press("Tab");
  assert.equal(
    await page
      .getByLabel("Job ID")
      .evaluate((element) => element === document.activeElement),
    true,
  );
  console.log(
    JSON.stringify(
      {
        result: "PASS",
        apiRequests: requests.length,
        methods: [...new Set(requests.map((request) => request.method))],
        checks: [
          "desktop",
          "390px no overflow",
          "status and job filters",
          "invalid UUID",
          "empty",
          "403",
          "500",
          "loading",
          "late response after session clear",
          "no credential storage",
          "PII omission",
          "keyboard order",
          "no page errors",
        ],
        screenshots: ["notifications-desktop.png", "notifications-mobile.png"],
      },
      null,
      2,
    ),
  );
} finally {
  unblock?.();
  await browser.close();
  await new Promise((done) => server.close(done));
}
