// Synthetic, intercepted UI regression only. No database or provider requests.
import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? "playwright"
);
const browser = await chromium.launch({ headless: true });
const output =
  process.env.CORRECTION_QA_DIR ?? "/tmp/signmons-correction-comparison-qa";
await mkdir(output, { recursive: true });
const html = await readFile(
  new URL("./fixtures/customer-intake-journey.html", import.meta.url),
  "utf8",
);
const script = await readFile(
  new URL("./fixtures/customer-intake-journey.js", import.meta.url),
  "utf8",
);
const candidate = {
  addressLines: ["123 Fictional Street", "Apt 2"],
  city: "Example",
  state: "OH",
  postalCode: "44101",
  country: "US",
};
const calls = [];
const errors = [];
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    assert.equal(url.origin, "http://127.0.0.1:39999");
    if (url.pathname === "/")
      return route.fulfill({ contentType: "text/html", body: html });
    if (url.pathname.endsWith(".js"))
      return route.fulfill({
        contentType: "application/javascript",
        body: script,
      });
    const body = route.request().postDataJSON();
    calls.push(body);
    let result = { deliveryAuthorized: false };
    if (url.pathname.endsWith("/start"))
      Object.assign(result, {
        sessionToken: "synthetic-only",
        expiresAt: new Date(Date.now() + 600000).toISOString(),
      });
    else if (url.pathname.endsWith("/continue"))
      Object.assign(result, { reply: "Fictional draft", revision: 1 });
    else if (url.pathname.endsWith("/correction"))
      Object.assign(result, {
        fixtureOnly: true,
        addressVerified: false,
        admissionAuthorized: false,
        county: "UNKNOWN",
        status:
          body.action === "confirm"
            ? "CUSTOMER_CONFIRMED"
            : "CONFIRMATION_REQUIRED",
        candidate,
        customerAddress: candidate,
        candidateId: "synthetic-candidate",
        revision: 1,
        expiresAt: Date.now() + 60000,
      });
    else throw Error("Unexpected route " + url.pathname);
    await route.fulfill({ json: result });
  });
  await page.goto("http://127.0.0.1:39999/");
  await page.evaluate(() => {
    document.documentElement.dataset.correctionFixture = "true";
    document.documentElement.dataset.addressFixture = "true";
  });
  await page.locator("#start").click();
  await page.locator("#message").fill("Fictional equipment issue");
  await page.locator("#continue").click();
  await page.locator("#skip").click();
  await page.locator("#address").fill("123 Fictional St");
  await page.locator("#addressUnit").fill("Apt 2");
  await page.locator("#correctionCity").fill("Example");
  await page.locator("#correctionPostal").fill("44101");
  const propose = async () => {
    await page.locator("#correctionPropose").click();
    await page.locator("#correctionComparison").waitFor({ state: "visible" });
    assert.match(
      await page.locator("#correctionEntered").textContent(),
      /123 Fictional St, Apt 2/,
    );
    assert.match(
      await page.locator("#correctionCandidate").textContent(),
      /123 Fictional Street, Apt 2/,
    );
    assert.equal(await page.locator("#correctionConfirm").isEnabled(), false);
  };
  await propose();
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.screenshot({
      path: `${output}/comparison-${width}.png`,
      fullPage: true,
    });
  }
  await page.locator("#correctionEdit").click();
  assert.equal(await page.locator("#address").inputValue(), "123 Fictional St");
  assert.equal(
    await page
      .locator("#address")
      .evaluate((e) => e === document.activeElement),
    true,
  );
  assert.equal(await page.locator("#correctionComparison").isVisible(), false);
  await propose();
  await page.locator("#correctionCancel").click();
  assert.equal(await page.locator("#addressUnit").inputValue(), "Apt 2");
  assert.equal(await page.locator("#correctionComparison").isVisible(), false);
  assert.equal(calls.filter((c) => c.action === "confirm").length, 0);
  await propose();
  await page.locator("#correctionChecked").check();
  await page.locator("#correctionConfirm").click();
  await page.waitForFunction(() =>
    document
      .querySelector("#correctionStatus")
      .textContent.startsWith("Customer confirmed"),
  );
  assert.equal(calls.filter((c) => c.action === "confirm").length, 1);
  assert.equal(await page.locator("#address").inputValue(), "123 Fictional St");
  await page.locator("#address").fill("124 Fictional St");
  assert.equal(await page.locator("#correctionComparison").isVisible(), false);
  assert.equal(await page.locator("#correctionConfirm").isEnabled(), false);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: comparison, unit, edit/focus, cancel, explicit confirmation, stale invalidation, mobile/desktop, no external requests",
  );
} finally {
  await browser.close();
}
