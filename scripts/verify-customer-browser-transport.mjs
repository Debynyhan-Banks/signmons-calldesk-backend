// Existing parent fixture owns the random local database and every fictional session.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
const require = createRequire(import.meta.url);
const {
  CustomerConsentBrowserTransport: Transport,
  CUSTOMER_BROWSER_HEADERS,
  readCustomerBrowserBody,
} = require("../dist/communications/customer-consent-browser-transport.js");
const {
  LocalCustomerBrowserBudget: Budget,
} = require("../dist/communications/customer-consent-browser-budget.js");

export async function verifyCustomerBrowserTransport({
  prisma,
  make,
  service,
  capture,
  credentials,
  asIntegration,
  tenantId,
  otherTenantId,
}) {
  const [db] = await prisma.$queryRawUnsafe(
    "SELECT current_database() AS name, inet_server_addr() AS address",
  );
  assert.match(db.name, /^calldesk_app013_intents_[0-9a-f]{12}$/);
  assert.equal(db.address, null);
  const out =
    process.env.CUSTOMER_BROWSER_EVIDENCE_DIR ??
    join(process.cwd(), "evidence/APP-013/customer-browser-transport");
  await mkdir(out, { recursive: true });
  const html = await readFile(
    new URL("./fixtures/customer-browser-transport.html", import.meta.url),
    "utf8",
  );
  const script = await readFile(
    new URL("./fixtures/customer-browser-transport.js", import.meta.url),
    "utf8",
  );
  const diagnostics = [],
    observed = [],
    checks = [],
    secrets = [];
  const calls = { start: 0, capture: 0, prompt: 0, respond: 0 };
  let transport,
    origin,
    failApplication = false;
  const ports = {
    responses: {
      start: async () => {
        calls.start++;
        if (failApplication) throw Error("PRIVATE-APP-ERROR");
        const s = await make(false);
        secrets.push(s.sessionToken);
        return s;
      },
      prompt: async (input) => {
        calls.prompt++;
        return service.prompt(input);
      },
      respond: async (input) => {
        calls.respond++;
        return service.respond(input);
      },
    },
    capture: {
      capture: async (input) => {
        calls.capture++;
        return capture.capture(input);
      },
    },
    credentials,
    budget: new Budget(),
    diagnostic: (entry) => diagnostics.push(entry),
  };
  const server = createServer(
    { maxHeaderSize: 8192, requestTimeout: 10000, headersTimeout: 10000 },
    async (req, res) => {
      for (const [name, value] of Object.entries(CUSTOMER_BROWSER_HEADERS))
        res.setHeader(name, value);
      if (req.method === "GET" && ["/", "/fixture.js"].includes(req.url)) {
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
        // Read limit precedes buffering/parsing. Fixture socket timeout bounds slow input.
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
          headers: CUSTOMER_BROWSER_HEADERS,
          body: { error: "Customer request refused." },
        };
      }
      observed.push({ status: result.status }); // Never log URLs, raw headers/bodies/errors.
      res.statusCode = result.status;
      for (const [name, value] of Object.entries(result.headers))
        res.setHeader(name, value);
      res.end(JSON.stringify(result.body));
    },
  );
  let attacker, browser;
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = "http://127.0.0.1:" + server.address().port;
    transport = new Transport(
      { origin, tenantId, fixtureLoopback: true },
      ports,
    );
    const headers = {
      Origin: origin,
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Dest": "empty",
      "X-CallDesk-Request": "customer-intake-v1",
      "Content-Type": "application/json",
    };
    const post = async (path, body = "{}", extra = {}) => {
      const r = await fetch(origin + path, {
        method: "POST",
        headers: { ...headers, ...extra },
        body,
      });
      const text = await r.text();
      assert.equal(
        r.headers.get("cache-control"),
        "private, no-store, max-age=0",
      );
      assert.equal(r.headers.get("referrer-policy"), "no-referrer");
      assert.equal(r.headers.get("access-control-allow-origin"), null);
      assert.equal(r.headers.get("set-cookie"), null);
      return { status: r.status, text };
    };
    const before = await prisma.conversation.count({ where: { tenantId } });
    for (const extra of [
      { Origin: "null" },
      { Origin: "http://hostile.invalid" },
      { "Sec-Fetch-Site": "same-site" },
      { "X-CallDesk-Request": "" },
      { Cookie: "PRIVATE-COOKIE" },
      { Authorization: "Bearer PRIVATE-INTEGRATION" },
    ]) {
      const result = await post("/customer-session/start", "{}", extra);
      assert.equal(result.status, 403);
      assert.equal(result.text, '{"error":"Customer request refused."}');
    }
    assert.equal(calls.start, 0);
    assert.equal(
      await prisma.conversation.count({ where: { tenantId } }),
      before,
    );
    checks.push(
      "real HTTP origin/metadata/custom-header/cookie/integration-header refusals leave database untouched",
    );
    assert.equal(
      (await post("/customer-session/start?credential=PRIVATE-QUERY")).status,
      403,
    );
    assert.equal(
      (await post("/customer-session/start", "x".repeat(16385))).status,
      413,
    );
    assert.equal(
      (await post("/customer-session/start", '{"a":1,"a":2}')).status,
      400,
    );
    checks.push(
      "query credentials, oversized stream and duplicate JSON refuse with fixed private responses",
    );
    failApplication = true;
    const failure = await post("/customer-session/start");
    failApplication = false;
    assert.equal(failure.status, 503);
    assert.ok(!failure.text.includes("PRIVATE"));
    assert.equal(
      await prisma.conversation.count({ where: { tenantId } }),
      before,
    );
    checks.push(
      "application failure is sanitized without retry or customer creation",
    );
    const wrongTenant = credentials.issueSession({
      tenantId: otherTenantId,
      conversationId: "00000000-0000-4000-8000-000000000001",
      sessionId: "00000000-0000-4000-8000-000000000002",
    });
    assert.equal(
      (
        await post(
          "/customer-session/capture",
          JSON.stringify({
            sessionToken: wrongTenant,
            email: "Private@example.invalid",
          }),
        )
      ).status,
      403,
    );
    assert.equal(calls.capture, 0);
    checks.push(
      "valid signature for another tenant cannot cross the fixed browser binding",
    );

    attacker = createServer((_req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.end(
        "<!doctype html><title>Fictional hostile origin</title><p>Cross-origin refusal fixture</p>",
      );
    });
    await new Promise((resolve) => attacker.listen(0, "127.0.0.1", resolve));
    const hostileOrigin = "http://127.0.0.1:" + attacker.address().port;
    const { chromium } = await import(
      process.env.PLAYWRIGHT_MODULE ?? "playwright"
    );
    browser = await chromium.launch({ headless: true });
    const errors = [],
      external = [];
    for (const width of [1440, 390]) {
      const context = await browser.newContext({
        viewport: { width, height: 1050 },
      });
      await context.route("**/*", (route) =>
        ![origin, hostileOrigin].includes(new URL(route.request().url()).origin)
          ? (external.push("blocked"), route.abort())
          : route.continue(),
      );
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      page.on("pageerror", () => errors.push("page error"));
      await page.goto(origin, { waitUntil: "load" });
      const [bootstrap] = await Promise.all([
        page.waitForResponse(
          (response) => response.url() === origin + "/customer-session/start",
        ),
        page.locator("#start").click(),
      ]);
      assert.equal(
        bootstrap.status(),
        200,
        "same-origin browser bootstrap must succeed",
      );
      await page.locator("#email").fill("Browser+Private@example.invalid");
      await page.locator("#capture").click();
      await page.locator("#permission").waitFor({ state: "visible" });
      assert.equal(
        await page.locator("#mailbox").innerText(),
        "Browser+Private@example.invalid",
      );
      assert.equal(await page.locator("#grant").isDisabled(), true);
      await page.screenshot({
        path: join(out, "private-prompt-" + width + ".png"),
        fullPage: true,
      });
      if (width === 1440) await page.locator("#confirmed").check();
      await page.locator(width === 1440 ? "#grant" : "#decline").click();
      await page
        .getByText("Choice recorded privately. Sending remains disabled.")
        .waitFor();
      assert.equal(await page.locator("#mailbox").innerText(), "");
      assert.deepEqual(
        await page.evaluate(() => [localStorage.length, sessionStorage.length]),
        [0, 0],
      );
      assert.equal((await context.cookies()).length, 0);
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      await page.goto(hostileOrigin, { waitUntil: "load" });
      const oldCalls = { ...calls },
        oldCount = await prisma.conversation.count({ where: { tenantId } });
      const cross = await page.evaluate(async (target) => {
        const results = [];
        for (const custom of [false, true]) {
          try {
            await fetch(target + "/customer-session/start", {
              method: "POST",
              credentials: "omit",
              headers: custom
                ? {
                    "Content-Type": "application/json",
                    "X-CallDesk-Request": "customer-intake-v1",
                  }
                : { "Content-Type": "text/plain" },
              body: "{}",
            });
            results.push("unexpected");
          } catch {
            results.push("blocked");
          }
        }
        return results;
      }, origin);
      assert.deepEqual(cross, ["blocked", "blocked"]);
      assert.deepEqual(calls, oldCalls);
      assert.equal(
        await prisma.conversation.count({ where: { tenantId } }),
        oldCount,
      );
      await context.close();
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    checks.push(
      "desktop/mobile browser bootstrap, capture, prompt and explicit grant/decline persist through the actual transport/services/database",
    );
    checks.push(
      "real second-origin simple POST and JSON/custom-header preflight fail without application work",
    );
    checks.push(
      "private browser state clears after completion; no cookies, web storage, URL credentials or external traffic",
    );
    // Quota exhaustion must refuse before bootstrap even with valid browser headers.
    const exhausted = new Transport(
      { origin, tenantId, fixtureLoopback: true },
      { ...ports, budget: { acquire: () => null } },
    );
    const oldCalls = { ...calls };
    const limited = await asIntegration(() =>
      exhausted.handle({
        method: "POST",
        url: "/customer-session/start",
        rawHeaders: Object.entries({
          ...headers,
          Host: new URL(origin).host,
        }).flat(),
        body: Buffer.from("{}"),
        peerAddress: "127.0.0.1",
        encrypted: false,
      }),
    );
    assert.equal(limited.status, 429);
    assert.deepEqual(calls, oldCalls);
    checks.push(
      "unavailable quota refuses before customer creation; local budget concurrency/window limits have unit proof",
    );
    for (const secret of [
      ...secrets,
      "PRIVATE",
      "Browser+Private@",
      "Private@example",
      origin,
    ]) {
      assert.ok(!JSON.stringify(diagnostics).includes(secret));
      assert.ok(!JSON.stringify(observed).includes(secret));
    }
    checks.push(
      "diagnostics contain fixed operation/status only; raw errors, URLs, mailboxes and bearer credentials are absent",
    );
    await writeFile(
      join(out, "summary.json"),
      JSON.stringify(
        {
          result: "PASS",
          checks,
          checkCount: checks.length,
          calls,
          diagnosticCount: diagnostics.length,
          httpStatuses: observed.reduce(
            (counts, entry) => ({
              ...counts,
              [entry.status]: (counts[entry.status] ?? 0) + 1,
            }),
            {},
          ),
          viewports: [1440, 390],
          pageErrors: errors,
          external,
          providerCalls: 0,
          productionActions: 0,
          deliveryAuthorized: false,
          limitations: [
            "Explicit loopback HTTP fixture, not production TLS/proxy/access-log acceptance",
            "Local budget resets on restart and is not distributed protection",
            "No production route, key loader, collection, full protected AI intake or sending",
          ],
        },
        null,
        2,
      ) + "\n",
    );
  } finally {
    await browser?.close();
    if (attacker?.listening)
      await new Promise((resolve) => attacker.close(resolve));
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
}
