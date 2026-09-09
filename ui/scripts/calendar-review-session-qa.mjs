// Real browser fetch -> isolated Nest HTTP. No fulfilled/mocked API routes.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? "playwright"
);
const url = new URL(process.argv[2]);
assert.equal(url.hostname, "127.0.0.1");
const evidence = resolve(
  process.env.QA_EVIDENCE_DIR ?? "evidence/APP-013/calendar-review-session",
);
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ headless: true });
const id = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const checks = [],
  external = [],
  mutations = [],
  pageErrors = [],
  consoleErrors = [];
const metrics = async () =>
  (await fetch(new URL("/fixture-metrics.json", url))).json();
async function until(predicate) {
  const deadline = Date.now() + 6000;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, "fixture condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  // Discover only this preview's generated, non-secret loopback configuration.
  await page.goto(url.href, { waitUntil: "load" });
  const api = new URL(
    await page.evaluate(() => window.calendarReviewFixtureOrigin),
  );
  assert.equal(api.hostname, "127.0.0.1");
  assert.notEqual(api.origin, url.origin);
  // Do not enable request routing: intercepted Chromium requests can bypass
  // preflight behavior. Preview CSP restricts connections to this loopback API.
  page.on("request", (req) => {
    if (![url.origin, api.origin].includes(new URL(req.url()).origin))
      external.push(req.url());
    if (!["GET", "OPTIONS"].includes(req.method()))
      mutations.push(req.method());
  });
  const panel = page.getByRole("region", {
    name: "Calendar review",
    exact: true,
  });
  const area = (name) => panel.getByRole("region", { name, exact: true });
  const job = area("Job operation history"),
    operation = area("Exact operation snapshot"),
    requests = area("Recovery request history");
  const text = (area, value) =>
    area.getByText(value, { exact: false }).first().waitFor();
  const load = (area) =>
    area.getByRole("button", { name: "Load snapshot", exact: true }).click();
  const refs = async () => {
    await panel.getByLabel("Job reference", { exact: true }).fill(id);
    await panel.getByLabel("Operation reference", { exact: true }).fill(id);
  };
  const bind = async (identity) => {
    await page.getByLabel("Fixture identity").selectOption(identity);
    await page
      .getByRole("button", { name: "Bind fixture session", exact: true })
      .click();
    await panel.getByLabel("Job reference", { exact: true }).waitFor();
  };
  const empty = async () => {
    assert.equal(await panel.locator("li").count(), 0);
    if (await panel.getByLabel("Job reference", { exact: true }).count()) {
      assert.equal(
        await panel.getByLabel("Job reference", { exact: true }).inputValue(),
        "",
      );
      assert.equal(
        await panel
          .getByLabel("Operation reference", { exact: true })
          .inputValue(),
        "",
      );
    }
  };
  const denied = async () => {
    await text(panel, "review access is required");
    await empty();
    assert.equal(await panel.getByRole("button").count(), 0);
  };
  await denied();
  assert.equal((await metrics()).gets, 0);
  for (const [identity, width] of [
    ["owner-a", 1440],
    ["admin-a", 390],
  ]) {
    await page.setViewportSize({ width, height: 1000 });
    const before = (await metrics()).gets;
    await bind(identity);
    assert.equal((await metrics()).gets, before); // no auto-read on bind
    await refs();
    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().startsWith(api.origin) &&
        response.request().method() === "GET",
    );
    await load(job);
    const response = await responsePromise;
    assert.equal(response.status(), 200);
    assert.match(response.headers()["cache-control"], /no-store/);
    assert.equal(response.headers()["access-control-allow-origin"], url.origin);
    assert.equal(
      response.headers()["access-control-allow-credentials"],
      undefined,
    );
    await load(operation);
    await text(operation, "Write attempt ended");
    await load(requests);
    await text(requests, "Ended-attempt read-back requested");
    assert.doesNotMatch(await panel.innerText(), /PRIVATE-|Bearer/);
    assert.match(await panel.innerText(), /not completion evidence/);
    assert.equal(await panel.getByRole("button").count(), 4);
    await panel.getByLabel("Operation reference", { exact: true }).focus();
    await page.keyboard.press("Tab");
    assert.equal(
      await panel
        .getByRole("button", { name: "Clear review session" })
        .evaluate((node) => node === document.activeElement),
      true,
    );
    await page.screenshot({
      path: resolve(evidence, `http-ready-${width}.png`),
      fullPage: true,
    });
    await page.evaluate(
      () => (document.documentElement.style.fontSize = "200%"),
    );
    assert.equal(
      await panel.evaluate((node) => node.scrollWidth <= node.clientWidth),
      true,
    );
    await page.evaluate(() => (document.documentElement.style.fontSize = ""));
    await bind(identity);
    await empty(); // same token must reset references/snapshots
    checks.push(
      `${identity}: three real GETs, exact CORS/no-store, privacy, keyboard, ${width}px and 200% text; same-token rebind clears`,
    );
  }
  await bind("owner-b");
  await refs();
  await load(job);
  await text(job, "No records returned");
  await load(operation);
  await operation.getByRole("alert").waitFor();
  const beforeHistory = (await metrics()).reads;
  await load(requests);
  await requests.getByRole("alert").waitFor();
  assert.equal((await metrics()).reads, beforeHistory + 1);
  checks.push(
    "Tenant B sees empty job and operation/history 404; no audit read for missing operation",
  );
  for (const identity of ["dispatcher", "bad", "missing-tenant"]) {
    await bind(identity);
    await refs();
    const before = (await metrics()).reads;
    await load(operation);
    await denied();
    assert.equal((await metrics()).reads, before);
    await page
      .getByRole("button", { name: "Unmount panel", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Mount panel", exact: true })
      .click();
    await denied(); // denied session cannot be re-enabled by remount
  }
  checks.push(
    "Forged owner display role rejected server-side, invalid token and missing tenant refused before reads; denial survives remount",
  );
  await bind("failure-a");
  await refs();
  await load(operation);
  await text(operation, "Snapshot unavailable");
  assert.doesNotMatch(await panel.innerText(), /PRIVATE-/);
  await page.screenshot({
    path: resolve(evidence, "http-error-390.png"),
    fullPage: true,
  });
  const failedGets = (await metrics()).gets;
  await page.waitForTimeout(150);
  assert.equal((await metrics()).gets, failedGets);
  await bind("owner-a");
  await refs();
  await load(operation);
  await text(operation, "Write attempt ended");
  checks.push(
    "Real sanitized 503, no automatic retry, explicit bind/manual refresh succeeds",
  );
  for (const action of [
    "reference",
    "rebind",
    "signout",
    "clear",
    "unmount",
    "replace",
  ]) {
    await bind("delayed-a");
    await refs();
    const before = await metrics();
    await load(operation);
    await until(
      async () => (await metrics()).delayedStarted > before.delayedStarted,
    );
    if (action === "reference")
      await panel
        .getByLabel("Operation reference", { exact: true })
        .fill(other);
    if (action === "rebind") await bind("owner-b");
    if (action === "signout")
      await page.getByRole("button", { name: "Sign out fixture" }).click();
    if (action === "clear")
      await panel.getByRole("button", { name: "Clear review session" }).click();
    if (action === "unmount")
      await page
        .getByRole("button", { name: "Unmount panel", exact: true })
        .click();
    if (action === "replace")
      await page
        .getByRole("button", { name: "Replace session object" })
        .click();
    await until(
      async () => (await metrics()).delayedFinished > before.delayedFinished,
    );
    if (action === "unmount")
      await page
        .getByRole("button", { name: "Mount panel", exact: true })
        .click();
    assert.equal(await panel.locator("li").count(), 0);
    if (["signout", "clear", "replace"].includes(action)) {
      await denied();
      await page
        .getByRole("button", { name: "Unmount panel", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Mount panel", exact: true })
        .click();
      await denied();
    }
    checks.push(
      `Real delayed GET discarded after ${action}; no obsolete data after server completion`,
    );
  }
  assert.equal(
    await page.evaluate(() => localStorage.length + sessionStorage.length),
    0,
  );
  assert.deepEqual(await page.context().cookies(), []);
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(external, []);
  assert.deepEqual(mutations, []);
  // Chromium may report failed-resource console entries for intentional 401/403/404/503.
  assert.ok(
    consoleErrors.every((message) =>
      /^Failed to load resource: the server responded with a status of (401|403|404|503)\b/.test(
        message,
      ),
    ),
  );
  const result = await metrics();
  assert.ok(result.preflights > 0);
  assert.equal(result.cancelledGets, 6);
  assert.equal(result.forbiddenHeaders, 0);
  assert.equal(result.mutations, 0);
  for (const status of [200, 204, 401, 403, 404, 503])
    assert.ok(result.statuses[status] > 0);
  const summary = {
    result: "PASS",
    checks,
    metrics: result,
    pageErrors,
    external,
    mutations,
    expectedHttpConsoleErrors: consoleErrors.length,
    syntheticSeams: ["Firebase verifier", "Prisma read-only double"],
    real: "React session-panel/client/adapter -> browser fetch/CORS -> Nest guards/context/service/filter",
    providerCalls: 0,
    productionRegistration: false,
    screenshots: evidence,
  };
  await writeFile(
    resolve(evidence, "summary.json"),
    JSON.stringify(summary, null, 2) + "\n",
  );
  console.log(JSON.stringify(summary));
} finally {
  await browser.close();
}
