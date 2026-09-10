import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
const require = createRequire(import.meta.url);
const {
  CustomerConsentBrowserTransport: Transport,
  CUSTOMER_BROWSER_HEADERS: HEADERS,
  readCustomerBrowserBody,
} = require("../dist/communications/customer-consent-browser-transport.js");
const {
  LocalCustomerBrowserBudget: Budget,
} = require("../dist/communications/customer-consent-browser-budget.js");
const {
  CustomerIntakeContinuationService: Intake,
} = require("../dist/communications/customer-intake-continuation.service.js");
export async function verifyCustomerIntakeJourney({
  prisma,
  make,
  credentials,
  cipher,
  asIntegration,
  tenantId,
  service,
  capture,
}) {
  const [db] = await prisma.$queryRawUnsafe(
    "SELECT current_database() AS name, inet_server_addr() AS address",
  );
  assert.match(db.name, /^calldesk_app013_intents_[0-9a-f]{12}$/);
  assert.equal(db.address, null);
  const out =
    process.env.CUSTOMER_INTAKE_JOURNEY_EVIDENCE_DIR ??
    join(process.cwd(), "evidence/APP-013/customer-intake-journey");
  await mkdir(out, { recursive: true });
  const html = await readFile(
      new URL("./fixtures/customer-intake-journey.html", import.meta.url),
      "utf8",
    ),
    script = await readFile(
      new URL("./fixtures/customer-intake-journey.js", import.meta.url),
      "utf8",
    );
  const errors = [],
    external = [],
    checks = [],
    diagnostics = [],
    requests = [];
  let transport,
    browser,
    latest,
    lose,
    scriptedCalls = 0;
  const intake = new Intake(prisma, cipher, credentials, {
    reply: async () => {
      scriptedCalls++;
      return "Fictional issue noted. Please review your details; no booking has been made.";
    },
  });
  const snapshot = async () => ({
    jobs: await prisma.job.findMany({ orderBy: { id: "asc" } }),
    intents: await prisma.appointmentEmailIntent.findMany({
      orderBy: { id: "asc" },
    }),
  });
  const baseline = await snapshot();
  const privateSnapshot = async () => ({
    events: await prisma.communicationEvent.findMany({
      orderBy: { id: "asc" },
    }),
    content: await prisma.communicationContent.findMany({
      orderBy: { id: "asc" },
    }),
    audit: await prisma.auditLog.findMany({ orderBy: { id: "asc" } }),
    consent: await prisma.appointmentEmailConsentEvidence.findMany({
      orderBy: { id: "asc" },
    }),
    conversations: await prisma.conversation.findMany({
      orderBy: { id: "asc" },
    }),
  });
  const ports = () => ({
    responses: {
      start: async () => {
        latest = await make(false);
        return latest;
      },
      prompt: (input) => service.prompt(input),
      respond: (input) => service.respond(input),
    },
    capture,
    credentials,
    budget: new Budget(),
    continuation: intake,
    draft: intake,
    diagnostic: (entry) => diagnostics.push(entry),
  });
  const server = createServer(
    { maxHeaderSize: 8192, requestTimeout: 10000, headersTimeout: 10000 },
    async (req, res) => {
      for (const [key, value] of Object.entries(HEADERS))
        res.setHeader(key, value);
      if (req.method === "GET" && ["/", "/journey.js"].includes(req.url)) {
        res.setHeader(
          "Content-Type",
          req.url === "/"
            ? "text/html; charset=utf-8"
            : "application/javascript; charset=utf-8",
        );
        res.setHeader(
          "Content-Security-Policy",
          "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
        );
        res.end(req.url === "/" ? html : script);
        return;
      }
      let result;
      try {
        req.setTimeout(10000, () => req.destroy());
        const body = await readCustomerBrowserBody(req);
        requests.push({ path: req.url, body: JSON.parse(body.toString()) });
        result = await asIntegration(() =>
          transport.handle({
            method: req.method,
            url: req.url,
            rawHeaders: req.rawHeaders,
            body,
            peerAddress: req.socket.remoteAddress,
            encrypted: false,
          }),
        );
      } catch {
        result = {
          status: 413,
          headers: HEADERS,
          body: { error: "Customer request refused." },
        };
      }
      if (lose === req.url && result.status === 200) {
        lose = undefined;
        result = {
          status: 503,
          headers: HEADERS,
          body: { error: "Customer request refused." },
        };
      }
      res.statusCode = result.status;
      for (const [key, value] of Object.entries(result.headers))
        res.setHeader(key, value);
      res.end(JSON.stringify(result.body));
    },
  );
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = "http://127.0.0.1:" + server.address().port;
    const { chromium } = await import(
      process.env.PLAYWRIGHT_MODULE ?? "playwright"
    );
    browser = await chromium.launch({ headless: true });
    for (const [choice, width] of [
      ["GRANTED", 1440],
      ["DECLINED", 390],
      ["NOT_RECORDED", 390],
    ]) {
      transport = new Transport(
        { origin, tenantId, fixtureLoopback: true },
        ports(),
      );
      const context = await browser.newContext({
        viewport: { width, height: 1100 },
      });
      await context.route("**/*", (route) =>
        new URL(route.request().url()).origin === origin
          ? route.continue()
          : (external.push("blocked"), route.abort()),
      );
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      page.on("pageerror", () => errors.push("page error"));
      await page.goto(origin, { waitUntil: "load" });
      await page.locator("#start").click();
      await page.locator("#conversation").waitFor({ state: "visible" });
      const session = latest;
      await page
        .locator("#message")
        .fill("Fictional cooling system is not cooling.");
      await page.locator("#continue").click();
      await page.locator("#email").waitFor({ state: "visible" });
      if (choice === "NOT_RECORDED") {
        await page.locator("#skip").click();
      } else {
        await page
          .locator("#mailboxInput")
          .fill("Journey+Private@example.invalid");
        lose = "/customer-session/capture";
        await page.locator("#capture").click();
        await page
          .getByText("Outcome unconfirmed.", { exact: false })
          .waitFor();
        const request = requests.at(-1);
        await page.locator("#retry").click();
        await page.locator("#promptStep").waitFor({ state: "visible" });
        assert.deepEqual(requests.at(-1), request);
        await page.locator("#prompt").click();
        await page.locator("#consent").waitFor({ state: "visible" });
        assert.equal(await page.locator("#grant").isDisabled(), true);
        if (choice === "GRANTED") await page.locator("#confirmed").check();
        lose = "/customer-session/respond";
        await page
          .locator(choice === "GRANTED" ? "#grant" : "#decline")
          .click();
        await page
          .getByText("Outcome unconfirmed.", { exact: false })
          .waitFor();
        const responseRequest = requests.at(-1);
        await page.locator("#retry").click();
        await page.locator("#details").waitFor({ state: "visible" });
        assert.deepEqual(requests.at(-1), responseRequest);
      }
      await page.locator("#details").waitFor({ state: "visible" });
      for (const [key, value] of Object.entries({
        customerName: "Fictional Customer",
        phone: "bad-phone",
        address: "123 Fictional Lane",
      }))
        await page.locator("#" + key).fill(value);
      for (const [key, value] of Object.entries({
        issueCategory: "COOLING",
        propertyType: "RESIDENTIAL",
        serviceIntent: "REPAIR",
      }))
        await page.locator("#" + key).selectOption(value);
      assert.equal(
        await page.locator("#description").inputValue(),
        "Fictional cooling system is not cooling.",
      );
      assert.equal(await page.locator("#draft").isDisabled(), true);
      await page.locator("#reviewed").check();
      await page.locator("#draft").click();
      await page
        .getByText("Check the draft fields", { exact: false })
        .waitFor();
      await page.locator("#phone").fill("+12025550123");
      const before = await privateSnapshot();
      await page.locator("#draft").click();
      await page.locator("#preview").waitFor({ state: "visible" });
      assert.deepEqual(await privateSnapshot(), before);
      assert.deepEqual(await snapshot(), baseline);
      assert.ok(
        (await page.locator("#summary").innerText()).includes(
          "Email choice: " + choice,
        ),
      );
      assert.ok(
        (await page.locator("#summary").innerText()).includes(
          "Urgency: not assessed",
        ),
      );
      const scope = await prisma.appointmentEmailConsentScope.findUnique({
        where: {
          tenantId_conversationId: {
            tenantId,
            conversationId: session.claims.conversationId,
          },
        },
      });
      const consent = scope
        ? await prisma.appointmentEmailConsentEvidence.findMany({
            where: { scopeId: scope.id },
          })
        : [];
      assert.equal(consent.length, choice === "NOT_RECORDED" ? 0 : 1);
      if (consent.length) assert.equal(consent[0].decision, choice);
      const captureAudits = await prisma.auditLog.count({
        where: {
          entityId: session.claims.conversationId,
          action: "conversation.email_captured",
        },
      });
      assert.equal(captureAudits, choice === "NOT_RECORDED" ? 0 : 1);
      await page.screenshot({
        path: join(out, "draft-" + choice + "-" + width + ".png"),
        fullPage: true,
      });
      // A draft is a snapshot, not authority to bypass a newer transcript.
      const draftRequest = requests.at(-1).body;
      await intake.continue({
        sessionToken: session.sessionToken,
        interactionId: randomUUID(),
        message: "A later fictional detail",
      });
      await assert.rejects(intake.previewDraft(draftRequest), /changed/);
      await page.locator("#forget").click();
      assert.equal(await page.locator("#summary").innerText(), "");
      assert.equal(await page.locator("#mailbox").innerText(), "");
      assert.deepEqual(
        await page.evaluate(() => [localStorage.length, sessionStorage.length]),
        [0, 0],
      );
      assert.equal((await context.cookies()).length, 0);
      assert.equal(page.url(), origin + "/");
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      await context.close();
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    assert.deepEqual(await snapshot(), baseline);
    for (const req of requests) {
      if (req.body.sessionToken)
        assert.ok(!JSON.stringify(diagnostics).includes(req.body.sessionToken));
    }
    assert.ok(!JSON.stringify(diagnostics).includes("Journey+Private"));
    checks.push(
      "actual browser/transport/database journey covers grant, decline and no-email branches",
      "email skip creates no capture or consent and does not block draft",
      "lost capture/consent acknowledgment replays exact input and records once",
      "grant requires separate mailbox confirmation; declining still reaches draft",
      "description carries forward without repeated intake question; explicit draft review required",
      "invalid phone refuses with editable correction and no draft write",
      "draft previews leave conversation/content/events/audit/consent/jobs/intents unchanged",
      "new transcript revision invalidates an older draft request",
      "draft records historical choice only; urgency unassessed and job/booking/sending disabled",
      "desktop/mobile privacy clearing, no cookies/storage/credential URLs/external requests/page errors",
    );
    await writeFile(
      join(out, "summary.json"),
      JSON.stringify(
        {
          result: "PASS",
          checks,
          checkCount: checks.length,
          choices: ["GRANTED", "DECLINED", "NOT_RECORDED"],
          viewports: [1440, 390],
          scriptedCalls,
          providerCalls: 0,
          productionActions: 0,
          jobCreated: false,
          bookingAuthorized: false,
          deliveryAuthorized: false,
          pageErrors: errors,
          external,
          limits: [
            "Read-only customer-stated draft, not saved or a CreateJobPayload",
            "No actual AI, urgency assessment, address/phone/mailbox verification, booking or delivery",
            "No production route/key/configuration or retention/recovery implementation",
          ],
        },
        null,
        2,
      ) + "\n",
    );
  } finally {
    await browser?.close();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
}
