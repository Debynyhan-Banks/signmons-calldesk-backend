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
let retryAllowed = false;
let capabilityFailure = false;
let retryMode = "success";
const posts = [];
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
    templateKey:
      index === 0
        ? "APPOINTMENT_CONFIRMED"
        : index === 3
          ? "APPOINTMENT_CANCELLED"
          : "TECHNICIAN_ON_THE_WAY",
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
    updatedAt: "2026-09-08T14:01:00.000Z",
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
        "Access-Control-Allow-Headers": "authorization,content-type",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      },
    });
    return;
  }
  requests.push({ method: request.method(), url: request.url() });
  const pathname = new URL(request.url()).pathname;
  assert.ok(request.headers().authorization?.startsWith("Bearer synthetic-"));
  if (request.method() === "POST") {
    assert.equal(
      pathname,
      `/communications/sms/enqueue-intents/${intents[3].id}/retry`,
    );
    assert.equal(
      request.headers().authorization,
      "Bearer synthetic-owner-token",
    );
    assert.deepEqual(request.postDataJSON(), {
      acknowledgeRetry: true,
      reasonCode: "TRANSIENT_FAILURE_REVIEWED",
      expectedUpdatedAt: intents[3].updatedAt,
    });
    posts.push(request.postDataJSON());
    if (retryMode === "network") return route.abort("failed");
    if (retryMode === "slow" || retryMode === "timeout")
      await new Promise((done) => {
        unblocks.push(done);
      });
    return route.fulfill({
      status: Number(retryMode) || 202,
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify(
        retryMode === "malformed"
          ? {}
          : Number(retryMode)
            ? { message: "DO_NOT_RENDER_SERVER_PAYLOAD" }
            : { status: "pending" },
      ),
    });
  }
  assert.equal(request.method(), "GET");
  assert.ok(
    [
      "/communications/sms/history",
      "/communications/sms/enqueue-intents",
      "/communications/sms/capabilities",
    ].includes(pathname),
  );
  if (pathname.endsWith("capabilities")) {
    if (mode === "slow")
      await new Promise((done) => {
        unblocks.push(done);
      });
    return route.fulfill({
      status: capabilityFailure ? 503 : 200,
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ canRetryEnqueueIntent: retryAllowed }),
    });
  }
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
    path: `${evidence}cancellation-intents-desktop.png`,
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
    path: `${evidence}cancellation-intents-mobile.png`,
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
    // Hold all three reads, including authorization capability, through edits.
    await new Promise((done, reject) => {
      const deadline = Date.now() + 10_000;
      const check = () =>
        unblocks.length === 3
          ? done()
          : Date.now() > deadline
            ? reject(
                new Error("Three read requests did not reach fixture barrier"),
              )
            : setTimeout(check, 10);
      check();
    });
    if (change === "token")
      await page.getByLabel("Operator ID token").fill("synthetic-edited-token");
    else if (change === "job") await page.getByLabel("Job ID").fill("");
    else await page.getByRole("button", { name: "Clear session" }).click();
    const responses = Promise.all(
      ["history", "enqueue-intents", "capabilities"].map((endpoint) =>
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
  assert.equal(posts.length, 0);
  assert.equal(
    await page
      .getByRole("button", { name: "Review retry", exact: true })
      .count(),
    0,
  );
  mode = "ready";
  await page.getByLabel("Operator ID token").fill("synthetic-owner-token");
  const reload = async () => {
    await page.getByRole("button", { name: "Load history" }).click();
    await intentPanel
      .getByRole("status")
      .filter({ hasText: "2 intents shown" })
      .waitFor();
  };
  await reload();
  await page
    .getByRole("status")
    .filter({ hasText: "Read-only access:" })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Review retry", exact: true })
      .count(),
    0,
  );
  retryAllowed = true;
  capabilityFailure = true;
  await reload();
  await page
    .getByRole("status")
    .filter({ hasText: "Retry access could not be verified" })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Review retry", exact: true })
      .count(),
    0,
  );
  capabilityFailure = false;
  const openReview = async () => {
    await reload();
    const button = page.getByRole("button", {
      name: "Review retry",
      exact: true,
    });
    await button.waitFor();
    assert.equal(await button.count(), 1);
    await button.click();
    await page.getByRole("region", { name: "Review enqueue retry" }).waitFor();
    assert.ok(
      (
        await page
          .getByRole("region", { name: "Review enqueue retry" })
          .innerText()
      ).includes("Appointment cancelled"),
    );
    assert.equal(
      await page
        .getByLabel("Reviewed reason")
        .evaluate((element) => element === document.activeElement),
      true,
    );
    assert.equal(
      await page
        .getByRole("button", { name: "Request retry", exact: true })
        .isDisabled(),
      true,
    );
  };
  await openReview();
  await page.getByRole("button", { name: "Cancel review" }).click();
  assert.equal(posts.length, 0);
  await openReview();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page
    .getByRole("region", { name: "Review enqueue retry" })
    .screenshot({ path: `${evidence}cancellation-retry-desktop.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("region", { name: "Review enqueue retry" })
    .screenshot({ path: `${evidence}cancellation-retry-mobile.png` });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  const acknowledge = async () => {
    await page.getByRole("checkbox").check();
    assert.equal(
      await page
        .getByRole("button", { name: "Request retry", exact: true })
        .isDisabled(),
      true,
    );
    await page.getByRole("checkbox").uncheck();
    await page
      .getByLabel("Reviewed reason")
      .selectOption("TRANSIENT_FAILURE_REVIEWED");
    assert.equal(
      await page
        .getByRole("button", { name: "Request retry", exact: true })
        .isDisabled(),
      true,
    );
    await page.getByRole("checkbox").check();
  };
  await acknowledge();
  // Two synchronous clicks test the ref guard before React can repaint.
  await page
    .getByRole("button", { name: "Request retry", exact: true })
    .evaluate((button) => {
      button.click();
      button.click();
    });
  await page
    .getByRole("status")
    .filter({ hasText: "Retry requested." })
    .waitFor();
  assert.equal(posts.length, 1);
  assert.equal(await intentPanel.locator("li").count(), 0);
  assert.equal(
    await page
      .getByRole("button", { name: "Review retry", exact: true })
      .count(),
    0,
  );
  for (const outcome of [
    "400",
    "401",
    "403",
    "404",
    "409",
    "429",
    "500",
    "network",
    "malformed",
    "timeout",
  ]) {
    retryMode = outcome;
    await openReview();
    await acknowledge();
    await page
      .getByRole("button", { name: "Request retry", exact: true })
      .click();
    const message = ["500", "network", "malformed", "timeout"].includes(outcome)
      ? "Retry outcome uncertain"
      : outcome === "409"
        ? "intent or job changed"
        : outcome === "429"
          ? "limit reached"
          : ["401", "403"].includes(outcome)
            ? "Retry access denied"
            : outcome === "404"
              ? "intent is unavailable"
              : "not accepted";
    await page.getByRole("status").filter({ hasText: message }).waitFor();
    if (outcome === "timeout") unblocks.forEach((done) => done());
    assert.equal(await intentPanel.locator("li").count(), 0);
  }
  for (const change of ["token", "job", "clear"]) {
    await page.getByLabel("Operator ID token").fill("synthetic-owner-token");
    retryMode = "slow";
    unblocks = [];
    await openReview();
    await acknowledge();
    const outgoing = page.waitForRequest(
      (request) => request.method() === "POST",
    );
    await page
      .getByRole("button", { name: "Request retry", exact: true })
      .click();
    await outgoing;
    await page
      .getByRole("status")
      .filter({ hasText: "Submitting retry" })
      .waitFor();
    assert.equal(
      await page.getByRole("button", { name: "Load history" }).isDisabled(),
      true,
    );
    if (change === "token")
      await page.getByLabel("Operator ID token").fill("synthetic-edited-token");
    else if (change === "job") await page.getByLabel("Job ID").fill(jobId);
    else await page.getByRole("button", { name: "Clear session" }).click();
    const finished = page.waitForResponse(
      (response) => response.request().method() === "POST",
    );
    unblocks.forEach((done) => done());
    await finished;
    await page
      .getByRole("status")
      .filter({ hasText: "Submitting retry" })
      .waitFor({ state: "detached" });
    assert.equal(
      await page
        .getByRole("status")
        .filter({ hasText: "Retry requested." })
        .count(),
      0,
    );
    assert.equal(await intentPanel.locator("li").count(), 0);
  }
  assert.equal(posts.length, 14);
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
        syntheticPosts: posts.length,
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
          "verified capability fail-closed and dispatcher read-only",
          "review focus, cancellation, reason and acknowledgment required",
          "one synthetic POST for duplicate click with exact reviewed version",
          "400/401/403/404/409/429 rejection and refresh required",
          "500/network/malformed/15-second-timeout uncertainty without automatic retry",
          "late POST after token edit, job edit and session clear",
        ],
        screenshots: [
          "cancellation-intents-desktop.png",
          "cancellation-intents-mobile.png",
          "cancellation-retry-desktop.png",
          "cancellation-retry-mobile.png",
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
