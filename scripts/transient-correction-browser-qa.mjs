// Fictional local browser QA only; no Google credential or transport.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { showTransientCorrection } from "./transient-correction-screen.mjs";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? "playwright"
);
const out = "/tmp/signmons-transient-correction-qa";
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
const entered = {
  street: "123 Fictional St",
  unit: "Apt 2",
  city: "Example",
  postalCode: "44101",
};
const candidate = {
  addressLines: ["123 Fictional Street", "Apt 2"],
  city: "Example",
  postalCode: "44101",
  country: "US",
  state: "OH",
};
try {
  for (const action of ["confirm", "edit", "cancel"]) {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("**/*", (route) => {
      assert.equal(new URL(route.request().url()).hostname, "127.0.0.1");
      return route.continue();
    });
    const pending = showTransientCorrection(entered, candidate, {
      open: (url) => page.goto(url),
      timeoutMs: 30000,
    });
    await page
      .getByRole("heading", { name: "Review your address correction" })
      .waitFor();
    if (action === "confirm") {
      for (const width of [390, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          true,
        );
        await page.screenshot({
          path: `${out}/review-${width}.png`,
          fullPage: true,
        });
      }
      await page.locator("[name=confirmed]").check();
    }
    if (action === "edit")
      await page.locator("[name=street]").fill("124 Fictional St");
    const posted = page.waitForResponse((r) => r.request().method() === "POST");
    await page.locator(`button[value=${action}]`).click();
    const response = await posted;
    assert.equal(response.status(), 200);
    const result = await pending;
    assert.equal(
      result.status,
      { confirm: "CONFIRMED", edit: "EDITED", cancel: "CANCELLED" }[action],
    );
    assert.equal(result.admissionAuthorized, false);
    await page.getByText("Review closed.", { exact: false }).waitFor();
    assert.ok(
      !(await page.locator("body").textContent()).includes("Fictional"),
    );
    if (action === "edit")
      assert.equal(result.address.street, "124 Fictional St");
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(
    "PASS: real local screen, mobile/desktop, confirm/edit/cancel, sanitized closure, no external requests",
  );
} finally {
  await browser.close();
}
