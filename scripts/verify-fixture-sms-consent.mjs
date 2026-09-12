import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
const require = createRequire(import.meta.url);
const {
  FixtureSmsConsent,
} = require("../dist/communications/fixture-sms-consent.js");
const {
  CustomerConsentCredentials,
} = require("../dist/communications/customer-consent-credentials.js");
const {
  CustomerConsentBrowserTransport,
} = require("../dist/communications/customer-consent-browser-transport.js");
const {
  LocalCustomerBrowserBudget,
} = require("../dist/communications/customer-consent-browser-budget.js");
const {
  requestContextMiddleware,
  setAuthContext,
} = require("../dist/common/context/request-context.js");
export async function verifyFixtureSmsBrowser({
  out = process.env.SMS_INTAKE_EVIDENCE_DIR,
  factory,
} = {}) {
  const { chromium } = await import(
    pathToFileURL(process.env.PLAYWRIGHT_MODULE)
  );
  assert.ok(out);
  await mkdir(out, { recursive: true });
  const html = (
    await readFile(
      new URL("./fixtures/customer-intake-journey.html", import.meta.url),
      "utf8",
    )
  ).replace('<html lang="en">', '<html lang="en" data-sms-fixture="true">');
  const script = await readFile(
    new URL("./fixtures/customer-intake-journey.js", import.meta.url),
    "utf8",
  );
  const origin = "http://127.0.0.1:45678";
  const browser = await chromium.launch({ headless: true });
  const checks = [];
  try {
    for (const width of [390, 1280]) {
      const tenantId = randomUUID(),
        sessionId = randomUUID();
      const credentials = new CustomerConsentCredentials({
        activeKeyId: "fixture",
        keys: { fixture: Buffer.alloc(32, 7) },
      });
      const token = credentials.issueSession({
        tenantId,
        sessionId,
        conversationId: randomUUID(),
      });
      const policy = {
        fixtureOnly: true,
        tenantId,
        sessionId,
        phone: "+12025550123",
        phoneRevision: 1,
        version: "fictional-v1",
        sender: "Fictional Heating",
        disclosure:
          "Test only: optional service texts. Frequency varies. Message and data rates may apply. STOP to opt out; HELP for help. Not a condition of purchase.",
        optedOut: false,
        active: true,
      };
      const model = factory
        ? await factory({
            credentials,
            claims: credentials.verifySession(token),
            policy,
          })
        : new FixtureSmsConsent(credentials, () => policy);
      const transport = new CustomerConsentBrowserTransport(
        { origin, tenantId, fixtureLoopback: true },
        {
          credentials,
          budget: new LocalCustomerBrowserBudget(),
          fixtureSms: model,
          responses: {},
          capture: {},
        },
      );
      const invoke = (input) =>
        new Promise((resolve, reject) =>
          requestContextMiddleware({ headers: {} }, {}, () => {
            setAuthContext({
              tenantId,
              userId: "integration:fixture",
              role: "webchat_integration",
            });
            transport
              .handle({
                method: "POST",
                url: "/customer-session/sms",
                peerAddress: "127.0.0.1",
                encrypted: false,
                rawHeaders: [
                  "Host",
                  "127.0.0.1:45678",
                  "Origin",
                  origin,
                  "Sec-Fetch-Site",
                  "same-origin",
                  "Sec-Fetch-Mode",
                  "cors",
                  "Sec-Fetch-Dest",
                  "empty",
                  "X-CallDesk-Request",
                  "customer-intake-v1",
                  "Content-Type",
                  "application/json",
                ],
                body: Buffer.from(JSON.stringify(input)),
              })
              .then(resolve, reject);
          }),
        );
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      let loseCapture = true,
        captured,
        smsCalls = 0;
      await page.route("**/*", async (route) => {
        const req = route.request(),
          path = new URL(req.url()).pathname;
        assert.equal(new URL(req.url()).origin, origin);
        if (path === "/")
          return route.fulfill({ contentType: "text/html", body: html });
        if (path === "/journey.js")
          return route.fulfill({
            contentType: "application/javascript",
            body: script,
          });
        if (["/fixture-sms-privacy", "/fixture-sms-terms"].includes(path))
          return route.fulfill({
            contentType: "text/html",
            body: "<h1>Fictional policy only</h1><p>Local test; not a published business policy. No real enrollment or sending.</p>",
          });
        const body = req.postDataJSON();
        if (path.endsWith("/sms")) {
          smsCalls++;
          const result = await invoke(body);
          if (body.action === "CAPTURE" && result.status === 200) {
            if (captured) assert.deepEqual(result.body, captured);
            captured = result.body;
            if (loseCapture) {
              loseCapture = false;
              return route.fulfill({
                status: 503,
                contentType: "application/json",
                body: "{}",
              });
            }
          }
          return route.fulfill({
            status: result.status,
            headers: result.headers,
            body: JSON.stringify(result.body),
          });
        }
        let result;
        if (path.endsWith("/start"))
          result = {
            sessionToken: token,
            expiresAt: new Date(
              credentials.verifySession(token).expiresAt,
            ).toISOString(),
          };
        else if (path.endsWith("/continue"))
          result = { reply: "Fictional issue noted.", revision: 1 };
        else if (path.endsWith("/draft"))
          result = {
            draft: body.draft,
            transcriptRevision: 1,
            emailChoice: "NOT_RECORDED",
            jobCreated: false,
            bookingAuthorized: false,
            requiresHumanReview: true,
            urgencyAssessment: "NOT_PERFORMED",
          };
        else throw Error("Unexpected path " + path);
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ ...result, deliveryAuthorized: false }),
        });
      });
      await page.goto(origin);
      await page.locator("#start").click();
      await page.locator("#message").fill("Fictional issue");
      await page.locator("#continue").click();
      await page.locator("#skip").click();
      await page.locator("#phone").fill(policy.phone);
      await page.locator("#smsReview").click();
      await page.locator("#smsSave").waitFor({ state: "visible" });
      assert.equal(await page.locator("#smsRequested").isChecked(), false);
      assert.equal(await page.locator("#smsSave").isDisabled(), true);
      assert.match(
        await page.locator("#smsDisclosure").innerText(),
        /Fictional Heating/,
      );
      assert.equal(
        await page.locator("#smsPolicies a").first().getAttribute("href"),
        "/fixture-sms-privacy",
      );
      await page.locator("#smsRequested").focus();
      await page.keyboard.press("Space");
      assert.equal(await page.locator("#smsRequested").isChecked(), true);
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      await page.screenshot({
        path: out + "/fixture-sms-" + width + ".png",
        fullPage: true,
      });
      await page.locator("#smsSave").click();
      await page.locator("#retry").waitFor({ state: "visible" });
      assert.doesNotMatch(
        await page.locator("#smsStatus").innerText(),
        /preference recorded/,
      );
      await page.locator("#retry").click();
      await page.waitForFunction(
        (text) =>
          document.querySelector("#smsStatus").textContent.includes(text),
        factory ? "local fixture database" : "temporary fixture memory",
      );
      await page.screenshot({
        path: out + "/fixture-sms-saved-" + width + ".png",
        fullPage: true,
      });
      assert.equal(captured.liveConsentRecorded, false);
      assert.equal(captured.deliveryAuthorized, false);
      await page.locator("#smsReview").click();
      await page.locator("#smsSkip").waitFor({ state: "visible" });
      const beforeSkip = smsCalls;
      await page.locator("#smsSkip").click();
      assert.equal(smsCalls, beforeSkip);
      for (const [id, value] of [
        ["customerName", "Fictional Customer"],
        ["address", "123 Fictional Street"],
        ["description", "Fictional issue"],
      ])
        await page.locator("#" + id).fill(value);
      await page.locator("#issueCategory").selectOption("HEATING");
      await page.locator("#propertyType").selectOption("RESIDENTIAL");
      await page.locator("#serviceIntent").selectOption("REPAIR");
      await page.locator("#reviewed").check();
      await page.locator("#draft").click();
      await page.locator("#preview").waitFor({ state: "visible" });
      assert.deepEqual(errors, []);
      checks.push({
        width,
        capture: true,
        lostResponseReplay: true,
        skipWithoutWrite: true,
        previewWithoutSms: true,
        deliveryAuthorized: false,
      });
      await page.close();
    }
    await writeFile(
      out + "/summary.json",
      JSON.stringify(
        {
          mode: factory
            ? "REAL_DURABLE_FIXTURE_AND_TRANSPORT_MOCK_INTAKE"
            : "REAL_FIXTURE_MODEL_AND_TRANSPORT_MOCK_INTAKE",
          persistentDatabaseWrites: factory
            ? "isolated local database; counted by parent harness"
            : 0,
          providerCalls: 0,
          checks,
        },
        null,
        2,
      ) + "\n",
    );
    console.log(JSON.stringify({ passed: checks.length }));
  } finally {
    await browser.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await verifyFixtureSmsBrowser();
