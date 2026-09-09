import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
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

export async function verifyCustomerIntakeBrowser({
  prisma,
  make,
  credentials,
  cipher,
  asIntegration,
  tenantId,
}) {
  const [db] = await prisma.$queryRawUnsafe(
    "SELECT current_database() AS name, inet_server_addr() AS address",
  );
  assert.match(db.name, /^calldesk_app013_intents_[0-9a-f]{12}$/);
  assert.equal(db.address, null);
  const out =
    process.env.CUSTOMER_INTAKE_BROWSER_EVIDENCE_DIR ??
    join(process.cwd(), "evidence/APP-013/customer-intake-browser");
  await mkdir(out, { recursive: true });
  const html = await readFile(
    new URL("./fixtures/customer-intake-browser.html", import.meta.url),
    "utf8",
  );
  const script = await readFile(
    new URL("./fixtures/customer-intake-browser.js", import.meta.url),
    "utf8",
  );
  const checks = [],
    errors = [],
    external = [],
    diagnostics = [];
  const originalJobs = await prisma.job.count(),
    originalConsent = await prisma.appointmentEmailConsentEvidence.count(),
    originalIntents = await prisma.appointmentEmailIntent.count();
  let transport,
    browser,
    expire = false,
    loseAck = false,
    hold,
    held,
    release,
    latest,
    scriptedCalls = 0;
  const requests = [];
  const clocked = new Proxy(credentials, {
    get(target, prop) {
      if (prop === "verifySession")
        return (token) =>
          target.verifySession(token, Date.now() + (expire ? 900001 : 0));
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const intake = new Intake(prisma, cipher, clocked, {
    reply: async () => {
      scriptedCalls++;
      return "<b>Fictional repair recorded</b> — scripted only";
    },
  });
  const ports = () => ({
    responses: {
      start: async () => {
        latest = await make(false);
        return latest;
      },
    },
    credentials: clocked,
    budget: new Budget(),
    continuation: {
      continue: async (input) => {
        requests.push(input);
        if (hold) {
          held();
          await hold;
        }
        return intake.continue(input);
      },
    },
    diagnostic: (entry) => diagnostics.push(entry),
  });
  const server = createServer(
    { maxHeaderSize: 8192, requestTimeout: 10000, headersTimeout: 10000 },
    async (req, res) => {
      for (const [key, value] of Object.entries(HEADERS))
        res.setHeader(key, value);
      if (req.method === "GET" && ["/", "/intake.js"].includes(req.url)) {
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
      if (
        loseAck &&
        req.url === "/customer-session/continue" &&
        result.status === 200
      ) {
        loseAck = false;
        // Model a gateway losing the success acknowledgment after commit.
        // A socket reset may be transparently retried by the browser network stack.
        res.statusCode = 503;
        res.end(JSON.stringify({ error: "Customer request refused." }));
        return;
      }
      res.statusCode = result.status;
      for (const [key, value] of Object.entries(result.headers))
        res.setHeader(key, value);
      res.end(JSON.stringify(result.body));
    },
  );
  const eventCount = (session) =>
    prisma.communicationEvent.count({
      where: { tenantId, conversationId: session.claims.conversationId },
    });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = "http://127.0.0.1:" + server.address().port;
    const { chromium } = await import(
      process.env.PLAYWRIGHT_MODULE ?? "playwright"
    );
    browser = await chromium.launch({ headless: true });
    for (const width of [1440, 390]) {
      transport = new Transport(
        { origin, tenantId, fixtureLoopback: true },
        ports(),
      );
      const context = await browser.newContext({
        viewport: { width, height: 1050 },
      });
      await context.route("**/*", (route) =>
        new URL(route.request().url()).origin === origin
          ? route.continue()
          : (external.push("blocked"), route.abort()),
      );
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      page.on("pageerror", () => errors.push("page error"));
      const statuses = [];
      page.on("response", (response) => {
        if (response.url().includes("/customer-session/")) {
          statuses.push(response.status());
          assert.equal(
            response.headers()["cache-control"],
            "private, no-store, max-age=0",
          );
        }
      });
      await page.clock.install();
      await page.goto(origin, { waitUntil: "load" });
      const start = async () => {
        await page.locator("#start").click();
        await page
          .getByText("Private session started. Scripted replies only.")
          .waitFor();
      };
      const send = async (message) => {
        await page.locator("#message").fill(message);
        await page.locator("#send").click();
      };
      await start();
      const first = latest;
      await send("Fictional private first message");
      await page
        .getByText(
          "Message saved privately. No appointment booked; sending remains disabled.",
        )
        .waitFor();
      assert.equal(await page.locator("#turns li").count(), 1);
      assert.equal(await page.locator("#turns b").count(), 0);
      assert.equal(await eventCount(first), 1);
      loseAck = true;
      await send("Fictional private retry message");
      await page.getByText("Outcome unconfirmed.", { exact: false }).waitFor();
      assert.equal(await page.locator("#message").isDisabled(), true);
      const uncertain = requests.at(-1),
        oldCalls = scriptedCalls;
      assert.equal(await eventCount(first), 2);
      await page.locator("#retry").click();
      await page
        .getByText(
          "Message saved privately. No appointment booked; sending remains disabled.",
        )
        .waitFor();
      assert.deepEqual(requests.at(-1), uncertain);
      assert.equal(scriptedCalls, oldCalls);
      assert.equal(await eventCount(first), 2);
      assert.equal(await page.locator("#turns li").count(), 2);
      await page.screenshot({
        path: join(out, `conversation-${width}.png`),
        fullPage: true,
      });
      await prisma.conversation.update({
        where: { id: first.claims.conversationId },
        data: { status: "COMPLETED" },
      });
      await send("Must not save stale message");
      await page
        .getByText("Conversation changed or is unavailable.", { exact: false })
        .waitFor();
      assert.equal(await eventCount(first), 2);
      assert.equal(await page.locator("#turns li").count(), 0);
      await start();
      const second = latest;
      expire = true;
      await send("Expired credential must refuse");
      await page
        .getByText("Session or request refused.", { exact: false })
        .waitFor();
      expire = false;
      assert.equal(await eventCount(second), 0);
      await start();
      const third = latest;
      hold = new Promise((resolve) => {
        release = resolve;
      });
      const entered = new Promise((resolve) => {
        held = resolve;
      });
      await send("Late old-session reply");
      await entered;
      await page.locator("#forget").click();
      await start();
      const fourth = latest;
      release();
      hold = undefined;
      await assertEventually(async () => (await eventCount(third)) === 1);
      assert.equal(await page.locator("#turns li").count(), 0);
      assert.equal(await page.locator("#message").inputValue(), "");
      assert.equal(await eventCount(fourth), 0);
      assert.notEqual(
        third.claims.conversationId,
        fourth.claims.conversationId,
      );
      // Client deadline advances independently; no server credential lifetime extension.
      await page.clock.fastForward(900001);
      await page
        .getByText("Session expired or unavailable.", { exact: false })
        .waitFor();
      assert.equal(await eventCount(fourth), 0);
      await page.screenshot({
        path: join(out, `expired-${width}.png`),
        fullPage: true,
      });
      await page.reload({ waitUntil: "load" });
      assert.equal(await page.locator("#start").isVisible(), true);
      assert.equal(await page.locator("#turns li").count(), 0);
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
      assert.ok(statuses.includes(409));
      assert.ok(statuses.includes(401));
      await context.close();
    }
    checks.push(
      "1440/390 browser bootstrap and scripted continuation persist encrypted turns through actual transport/service/database",
      "literal text rendering does not interpret scripted HTML",
      "lost HTTP acknowledgment retains immutable pending input; explicit same-ID replay adds no write or scripted call",
      "stale conversation returns 409 and clears private state without a new turn",
      "expired server credential returns 401 before persistence and clears private state",
      "clear during in-flight work prevents late reply publication in a new session; abort does not retract a committed turn",
      "client deadline refuses and clears without renewing authority; reload cannot recover/adopt old state",
      "no cookies, web storage, credential URLs, horizontal overflow, page errors or external requests",
    );
    assert.equal(await prisma.job.count(), originalJobs);
    assert.equal(
      await prisma.appointmentEmailConsentEvidence.count(),
      originalConsent,
    );
    assert.equal(await prisma.appointmentEmailIntent.count(), originalIntents);
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    assert.ok(!JSON.stringify(diagnostics).includes("Fictional"));
    for (const request of requests)
      assert.ok(!JSON.stringify(diagnostics).includes(request.sessionToken));
    checks.push(
      "no jobs, consent, finalized intents or delivery authority; diagnostics omit messages and credentials",
    );
    await writeFile(
      join(out, "summary.json"),
      JSON.stringify(
        {
          result: "PASS",
          checks,
          checkCount: checks.length,
          viewports: [1440, 390],
          scriptedCalls,
          providerCalls: 0,
          productionActions: 0,
          deliveryAuthorized: false,
          pageErrors: errors,
          external,
          limitations: [
            "Local loopback fixture only, no production route or AI/booking activation",
            "Client abort cannot undo server persistence",
            "No credential recovery, renewal, distributed limiter or retention implementation",
          ],
        },
        null,
        2,
      ) + "\n",
    );
  } finally {
    release?.();
    await browser?.close();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
}
async function assertEventually(fn) {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("Fixture condition did not complete");
}
