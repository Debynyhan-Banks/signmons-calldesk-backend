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
let unblocks = [];
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
const intents = ["PENDING", "QUEUED", "STALE", "FAILED", "PENDING"].map(
  (status, index) => ({
    id: `30000000-0000-4000-8000-00000000000${index}`,
    jobId: index === 4 ? "10000000-0000-4000-8000-000000000002" : jobId,
    templateKey: "TECHNICIAN_ON_THE_WAY",
    status,
    attemptCount: status === "FAILED" ? 5 : status === "STALE" ? 1 : 0,
    lastErrorCode:
      status === "FAILED"
        ? "enqueue_failed"
        : status === "STALE"
          ? "stale_lifecycle_state"
          : null,
    nextAttemptAt: "2026-09-08T14:02:00.000Z",
    createdAt: "2026-09-08T14:00:00.000Z",
    communicationEventId: status === "QUEUED" ? records[2].id : null,
    stateHash: "DO_NOT_RENDER_STATE_HASH",
    phone: "DO_NOT_RENDER_PHONE",
    body: "DO_NOT_RENDER_BODY",
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
  const pathname = new URL(request.url()).pathname;
  assert.ok(
    [
      "/communications/sms/history",
      "/communications/sms/enqueue-intents",
    ].includes(pathname),
  );
  assert.ok(request.headers().authorization?.startsWith("Bearer synthetic-"));
  const isIntent = pathname.endsWith("enqueue-intents");
  const responseMode =
    mode === "intent-failure"
      ? isIntent
        ? "failure"
        : "ready"
      : mode === "history-failure"
        ? isIntent
          ? "ready"
          : "failure"
        : mode;
  if (responseMode === "slow") {
    await new Promise((done) => {
      unblocks.push(done);
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
          : isIntent
            ? intents
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
  await page
    .getByRole("status")
    .filter({ hasText: "4 intents shown" })
    .waitFor();
  const historyRequest = requests.find((request) =>
    request.url.includes("/history"),
  );
  assert.equal(new URL(historyRequest.url).searchParams.get("jobId"), jobId);
  assert.equal(new URL(historyRequest.url).searchParams.get("limit"), "100");
  const intentRequest = requests.find((request) =>
    request.url.includes("enqueue-intents"),
  );
  assert.equal(new URL(intentRequest.url).search, "");
  const intentPanel = page.getByRole("region", { name: "SMS enqueue intents" });
  assert.equal(await intentPanel.locator("li").count(), 4);
  assert.ok(
    (await intentPanel.innerText()).includes(
      "Queue acknowledged · not delivery",
    ),
  );
  await page
    .getByRole("combobox", { name: "Intent status" })
    .selectOption("pending");
  assert.equal(await intentPanel.locator("li").count(), 1);
  await page
    .getByRole("combobox", { name: "Intent status" })
    .selectOption("queued");
  assert.equal(await intentPanel.locator("li").count(), 1);
  await page
    .getByRole("combobox", { name: "Intent status" })
    .selectOption("all");
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  assert.equal(
    (await page.locator("body").innerText()).includes("DO_NOT_RENDER"),
    false,
  );
  await page.screenshot({
    path: `${evidence}notification-intents-desktop.png`,
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
  await page
    .getByRole("combobox", { name: "Intent status" })
    .selectOption("attention");
  assert.equal(await intentPanel.locator("li").count(), 2);
  await page.screenshot({
    path: `${evidence}notification-intents-mobile.png`,
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
  await page
    .getByRole("heading", { name: "No enqueue intents match" })
    .waitFor();
  mode = "denied";
  await page.getByRole("button", { name: "Load history" }).click();
  await page
    .getByRole("region", { name: "SMS history", exact: true })
    .getByRole("alert")
    .filter({ hasText: "Access denied" })
    .waitFor();
  await intentPanel
    .getByRole("alert")
    .filter({ hasText: "access denied" })
    .waitFor();
  mode = "failure";
  await page.getByRole("button", { name: "Load history" }).click();
  await page
    .getByRole("region", { name: "SMS history", exact: true })
    .getByRole("alert")
    .filter({ hasText: "could not be loaded" })
    .waitFor();
  await intentPanel.getByRole("alert").waitFor();
  mode = "intent-failure";
  await page.getByRole("button", { name: "Load history" }).click();
  await page
    .getByRole("status")
    .filter({ hasText: "5 records shown" })
    .waitFor();
  await intentPanel.getByRole("alert").waitFor();
  mode = "history-failure";
  await page.getByRole("button", { name: "Load history" }).click();
  await intentPanel
    .getByRole("status")
    .filter({ hasText: "2 intents shown" })
    .waitFor();
  await page
    .getByRole("region", { name: "SMS history", exact: true })
    .getByRole("alert")
    .waitFor();
  for (const change of ["token", "job", "clear"]) {
    mode = "slow";
    unblocks = [];
    await page.getByRole("button", { name: "Load history" }).click();
    await page
      .getByRole("status")
      .filter({ hasText: "Loading message" })
      .waitFor();
    await intentPanel
      .getByRole("status")
      .filter({ hasText: "Loading enqueue" })
      .waitFor();
    // Wait for both intercepted requests to reach the held-response barrier.
    await new Promise((done, reject) => {
      const deadline = Date.now() + 10_000;
      const check = () =>
        unblocks.length === 2
          ? done()
          : Date.now() > deadline
            ? reject(
                new Error("Both read requests did not reach fixture barrier"),
              )
            : setTimeout(check, 10);
      check();
    });
    if (change === "token")
      await page.getByLabel("Operator ID token").fill("synthetic-edited-token");
    else if (change === "job") await page.getByLabel("Job ID").fill("");
    else await page.getByRole("button", { name: "Clear session" }).click();
    const responses = Promise.all(
      ["history", "enqueue-intents"].map((endpoint) =>
        page.waitForResponse((response) =>
          response.url().includes(`/communications/sms/${endpoint}`),
        ),
      ),
    );
    unblocks.forEach((done) => done());
    await responses;
    // Wait for the response body and React's next paint before checking stale data.
    await page.evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        ),
    );
    assert.equal(await page.locator("ol li").count(), 0);
  }
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
          "independent partial failures",
          "intent status and loaded-subset job filters",
          "late responses after token edit, job edit and session clear",
          "no credential storage",
          "PII omission",
          "keyboard order",
          "no page errors",
        ],
        screenshots: [
          "notification-intents-desktop.png",
          "notification-intents-mobile.png",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  unblocks.forEach((done) => done());
  await browser.close();
  await new Promise((done) => server.close(done));
}
