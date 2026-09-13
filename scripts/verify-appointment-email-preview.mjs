import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createEmailFixtureServer } from "./preview-appointment-emails.mjs";

const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? "playwright"
);
const evidence = resolve(
  process.env.EMAIL_COMPOSITION_EVIDENCE_DIR ??
    "evidence/APP-013/email-composition",
);
const { server, counts } = createEmailFixtureServer();
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const errors = [],
  external = [],
  mutations = [];
try {
  await mkdir(evidence, { recursive: true });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.route("**/*", async (route) => {
    const request = route.request();
    if (new URL(request.url()).origin !== origin) {
      external.push("blocked external request");
      await route.abort();
      return;
    }
    if (request.method() !== "GET") {
      mutations.push(request.method());
      await route.abort();
      return;
    }
    await route.continue();
  });
  const page = await context.newPage();
  page.on("pageerror", () => errors.push("page error"));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push("console error");
  });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1050 });
    for (const kind of ["confirmed", "rescheduled", "cancelled"]) {
      const response = await page.goto(`${origin}/${kind}/email`, {
        waitUntil: "load",
      });
      assert.equal(response.status(), 200);
      assert.equal(response.headers()["cache-control"], "private, no-store");
      assert.equal(response.headers()["referrer-policy"], "no-referrer");
      assert.match(await page.locator("h1").innerText(), new RegExp(kind));
      assert.equal(await page.locator("script, img, iframe, form").count(), 0);
      assert.equal(
        await page.locator("a").count(),
        kind === "cancelled" ? 0 : 1,
      );
      const text = await page.locator("body").innerText();
      assert.match(text, /Eastern Time/);
      assert.match(text, /call or text \+12025550123/);
      if (kind !== "cancelled") {
        assert.match(
          await page.locator("a").getAttribute("href"),
          /^https:\/\/appointments\.example\.invalid\/appointment\/manage#fictional_only/,
        );
        await page.keyboard.press("Tab");
        assert.equal(
          await page.evaluate(() => document.activeElement?.tagName),
          "A",
        );
      } else {
        assert.doesNotMatch(text, /Manage appointment|appointment\.ics/);
      }
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        true,
      );
      await page.screenshot({
        path: resolve(evidence, `${kind}-${width}.png`),
        fullPage: true,
      });
      await page.evaluate(() => {
        document.body.style.fontSize = "32px";
        const heading = document.querySelector("h1");
        if (heading) heading.style.fontSize = "52px";
      });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        true,
      );
      await page.goto(`${origin}/${kind}/operator`, { waitUntil: "load" });
      assert.equal(await page.locator("a").count(), 0);
      assert.doesNotMatch(
        await page.content(),
        /fictional_only|https:|BEGIN:VCALENDAR/,
      );
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        true,
      );
      if (kind === "confirmed" && width === 390)
        await page.screenshot({
          path: resolve(evidence, "operator-390.png"),
          fullPage: true,
        });
      assert.equal(
        await page.evaluate(() => localStorage.length + sessionStorage.length),
        0,
      );
    }
  }
  assert.deepEqual(await context.cookies(), []);
  await page.goto(origin, { waitUntil: "load" });
  const downloadEvent = page.waitForEvent("download");
  await page.locator('a[href="/confirmed/appointment.ics"]').click();
  const download = await downloadEvent;
  assert.equal(download.suggestedFilename(), "appointment.ics");
  const stream = await download.createReadStream();
  let calendar = "";
  for await (const chunk of stream) calendar += chunk.toString("utf8");
  assert.match(calendar, /DTSTART:20260915T140000Z\r\n/);
  assert.doesNotMatch(calendar, /fictional_only|https:|LOCATION|ATTENDEE/);
  const cancelledDownload = await context.request.get(
    `${origin}/cancelled/appointment.ics`,
  );
  assert.equal(cancelledDownload.status(), 404);
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  assert.deepEqual(mutations, []);
  const summary = {
    result: "PASS",
    scope: "fictional local HTML/plain-text/calendar composition only",
    viewports: [1440, 390],
    cases: ["confirmed", "rescheduled", "cancelled"],
    checks: [
      "escaped fixed HTML",
      "private/no-store/referrer headers",
      "active-only management link",
      "cancellation without actions",
      "credential-free operator previews",
      "Eastern windows",
      "keyboard link focus",
      "200 percent text without horizontal overflow",
      "empty cookies/local/session storage",
      "actual fictional calendar download",
      "cancelled calendar 404",
    ],
    counts,
    errors,
    external,
    mutations,
    providerCalls: 0,
    limitations: [
      "No email client compatibility or live delivery proof",
      "No Calendar import/synchronization proof",
      "No identity, recipient, credential or canonical-state authority proof",
    ],
  };
  await writeFile(
    resolve(evidence, "browser-summary.json"),
    JSON.stringify(summary, null, 2) + "\n",
  );
  console.log(JSON.stringify(summary));
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}
