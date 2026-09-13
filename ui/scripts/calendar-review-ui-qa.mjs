// Test the real, unlinked React component through its synthetic-only preview.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? "playwright"
);
const url = new URL(process.argv[2]);
assert.equal(url.hostname, "127.0.0.1");
const evidence = resolve(
  process.env.QA_EVIDENCE_DIR ?? "evidence/APP-013/calendar-review-ui",
);
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ headless: true });
const id = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const errors = [],
  external = [],
  mutations = [];
const checks = [];
try {
  const page = await browser.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.route("**/*", async (route) => {
    const req = route.request();
    if (new URL(req.url()).origin !== url.origin) {
      external.push(req.url());
      return route.abort();
    }
    if (req.method() !== "GET") {
      mutations.push(req.method());
      return route.abort();
    }
    return route.continue();
  });
  const panel = page.getByRole("region", {
    name: "Calendar review",
    exact: true,
  });
  const area = (name) => panel.getByRole("region", { name, exact: true });
  const operation = area("Exact operation snapshot");
  const requests = area("Recovery request history");
  const job = area("Job operation history");
  const load = (area) =>
    area.getByRole("button", { name: "Load snapshot", exact: true }).click();
  const waitText = async (area, text) => {
    await area.getByText(text, { exact: false }).first().waitFor();
  };
  const refs = async () => {
    await panel.getByLabel("Job reference", { exact: true }).fill(id);
    await panel.getByLabel("Operation reference", { exact: true }).fill(id);
  };
  const scenario = (value) =>
    page.getByLabel("Fixture scenario").selectOption(value);
  const calls = async () =>
    Number(await page.getByLabel("Injected read calls").textContent());
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(url.href, { waitUntil: "load" });
    await refs();
    await load(job);
    await load(operation);
    await load(requests);
    await waitText(operation, "Calendar outcome uncertain");
    await waitText(requests, "Uncertain-attempt read-back requested");
    const text = await panel.innerText();
    assert.match(text, /separate reads/);
    assert.match(text, /not completion evidence/);
    assert.doesNotMatch(text, /PRIVATE-/);
    assert.equal(await panel.getByRole("button").count(), 4);
    await page.getByLabel("Operation reference", { exact: true }).focus();
    await page.keyboard.press("Tab");
    assert.equal(
      await panel
        .getByRole("button", { name: "Clear review session" })
        .evaluate((node) => node === document.activeElement),
      true,
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.screenshot({
      path: resolve(evidence, `review-ready-${width}.png`),
      fullPage: true,
    });
    await page.evaluate(
      () => (document.documentElement.style.fontSize = "200%"),
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.evaluate(() => (document.documentElement.style.fontSize = ""));
    await scenario("empty");
    await load(requests);
    await waitText(requests, "No records returned");
    await scenario("truncated");
    await load(requests);
    await waitText(requests, "Showing the newest 100 records");
    assert.equal(await requests.locator("li").count(), 100);
    await scenario("finalized");
    await load(operation);
    await waitText(operation, "not a current booking receipt");
    await scenario("partial");
    await load(requests);
    await waitText(requests, "Snapshot unavailable");
    await waitText(operation, "not a current booking receipt");
    await page.screenshot({
      path: resolve(evidence, `review-partial-${width}.png`),
      fullPage: true,
    });
    for (const mode of ["malformed", "network", "404", "429", "503"]) {
      await scenario(mode);
      await load(operation);
      await operation.getByRole("alert").waitFor();
      assert.equal(await operation.locator("li").count(), 0);
      assert.doesNotMatch(await operation.innerText(), /PRIVATE-/);
    }
    await scenario("delayed");
    const before = await calls();
    await load(operation);
    await operation.getByRole("button", { name: "Loading…" }).waitFor();
    assert.equal(await operation.locator("li").count(), 0);
    await panel.getByLabel("Operation reference", { exact: true }).fill(other);
    await page.waitForTimeout(850);
    assert.equal(await calls(), before + 1);
    assert.equal(await panel.locator("li").count(), 0);
    await refs();
    await load(operation);
    await page.getByLabel("Fixture session").selectOption("admin-b");
    await page.waitForTimeout(850);
    assert.equal(
      await panel
        .getByLabel("Operation reference", { exact: true })
        .inputValue(),
      "",
    );
    assert.equal(await panel.locator("li").count(), 0);
    await refs();
    await load(operation);
    await panel.getByRole("button", { name: "Clear review session" }).click();
    await page.waitForTimeout(850);
    assert.equal(await panel.locator("li").count(), 0);
    await waitText(panel, "review access is required");
    await page.getByLabel("Fixture session").selectOption("owner-a");
    await refs();
    await scenario("403");
    await load(operation);
    await waitText(panel, "review access is required");
    assert.equal(await panel.locator("li").count(), 0);
    assert.equal(await panel.getByRole("button").count(), 0);
    await page.getByLabel("Fixture session").selectOption("dispatcher");
    assert.equal(await panel.getByRole("button").count(), 0);
    assert.equal(
      await page.evaluate(() => localStorage.length + sessionStorage.length),
      0,
    );
    checks.push({
      width,
      ready: true,
      privacy: true,
      emptyAndCap: true,
      partialFailure: true,
      errors: true,
      lateReferenceSessionAndClear: true,
      accessDenied: true,
      keyboard: true,
      doubleTextNoOverflow: true,
    });
  }
  await page.getByLabel("Fixture session").selectOption("owner-a");
  await refs();
  await scenario("timeout");
  await load(operation);
  await operation.getByRole("alert").waitFor({ timeout: 20_000 });
  await page.waitForTimeout(1200);
  assert.equal(await operation.locator("li").count(), 0);
  assert.match(await operation.innerText(), /no recovery action was requested/);
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  assert.deepEqual(mutations, []);
  console.log(
    JSON.stringify({
      result: "PASS",
      checks,
      timeoutAndLateDiscard: true,
      errors,
      external,
      mutations,
      injectedReadCalls: await calls(),
      screenshots: evidence,
    }),
  );
} finally {
  await browser.close();
}
