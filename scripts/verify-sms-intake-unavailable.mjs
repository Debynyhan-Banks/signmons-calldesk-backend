// UI-only regression: mocked intake responses, no database or provider access.
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const html = await readFile(new URL("./fixtures/customer-intake-journey.html", import.meta.url), "utf8");
const script = await readFile(new URL("./fixtures/customer-intake-journey.js", import.meta.url), "utf8");
const out = process.env.SMS_INTAKE_EVIDENCE_DIR;
assert.ok(out, "Explicit evidence directory required");
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
const checks = [];
try {
  for (const width of [390, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const requests = [], errors = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.route("**/*", async route => {
      const req = route.request(), url = new URL(req.url());
      assert.equal(url.origin, "http://127.0.0.1:45678");
      if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: html });
      if (url.pathname === "/journey.js") return route.fulfill({ contentType: "application/javascript", body: script });
      const body = req.postDataJSON();
      requests.push({ path: url.pathname, body });
      let result;
      if (url.pathname.endsWith("/start")) result = {
        sessionToken: "fictional-test-token", expiresAt: new Date(Date.now() + 600000).toISOString(),
      };
      else if (url.pathname.endsWith("/continue")) result = {
        reply: "Fictional issue noted.", revision: 1,
      };
      else if (url.pathname.endsWith("/draft")) result = {
        jobCreated: false, bookingAuthorized: false, requiresHumanReview: true,
        urgencyAssessment: "NOT_PERFORMED", transcriptRevision: 1,
        emailChoice: "NOT_RECORDED", draft: body.draft,
      };
      else throw Error("Unexpected endpoint " + url.pathname);
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ...result, deliveryAuthorized: false }) });
    });
    await page.goto("http://127.0.0.1:45678/");
    await page.locator("#start").click();
    await page.locator("#message").fill("Fictional heating request");
    await page.locator("#continue").click();
    await page.locator("#skip").click();
    const checkbox = page.locator("#smsRequested");
    assert.equal(await checkbox.isDisabled(), true);
    assert.equal(await checkbox.isChecked(), false);
    await page.locator("#customerName").fill("Fictional Customer");
    await page.locator("#phone").fill("+12025550123");
    await page.locator("#address").fill("123 Fictional Street");
    await page.locator("#description").fill("Fictional heating request");
    await page.locator("#issueCategory").selectOption("HEATING");
    await page.locator("#propertyType").selectOption("RESIDENTIAL");
    await page.locator("#serviceIntent").selectOption("REPAIR");
    // Simulated devtools tampering cannot enter the explicit draft payload.
    await checkbox.evaluate(e => { e.disabled = false; e.checked = true; });
    await page.locator("#reviewed").check();
    assert.equal(await checkbox.isDisabled(), true);
    assert.equal(await checkbox.isChecked(), false);
    await page.screenshot({ path: out + "/sms-unavailable-" + width + ".png", fullPage: true });
    await page.locator("#draft").click();
    await page.locator("#preview").waitFor({ state: "visible" });
    assert.match(await page.locator("#summary").innerText(), /SMS: no new consent recorded/);
    const draft = requests.find(r => r.path.endsWith("/draft")).body;
    assert.deepEqual(Object.keys(draft).sort(), ["draft", "expectedRevision", "sessionToken"]);
    assert.equal(Object.keys(draft.draft).length, 7);
    await page.locator("#editDraft").click();
    assert.equal(await checkbox.isDisabled(), true);
    await page.locator("#reviewed").focus();
    await page.keyboard.press("Tab");
    assert.equal(await page.locator("#draft").evaluate(e => e === document.activeElement), false);
    // Review is required independently; accepting SMS never substitutes for it.
    assert.equal(await page.locator("#draft").isDisabled(), true);
    await page.locator("#reviewed").check();
    await page.locator("#reviewed").focus();
    await page.keyboard.press("Tab");
    assert.equal(await page.locator("#draft").evaluate(e => e === document.activeElement), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
    checks.push({ width, unavailable: true, continuedWithoutSms: true, tamperingExcluded: true, keyboard: true });
    await page.close();
  }
  await writeFile(out + "/summary.json", JSON.stringify({ mode: "UI_MOCK_ONLY", providerCalls: 0, databaseWrites: 0, checks }, null, 2) + "\n");
  console.log(JSON.stringify({ passed: checks.length, mode: "UI_MOCK_ONLY" }));
} finally { await browser.close(); }
