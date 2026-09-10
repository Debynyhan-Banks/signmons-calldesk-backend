import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import {
  verifyAddressJourney,
  ADDRESS_CATALOG,
} from "./verify-address-journey.mjs";
const require = createRequire(import.meta.url);
const {
  LocalAddressService,
} = require("../dist/communications/local-address.service.js");
const {
  DurableVerificationService,
} = require("../dist/communications/durable-verification.service.js");
const {
  VerificationBudgetAdmission,
} = require("../dist/communications/verification-budget-admission.js");
const {
  LocalVerificationBrowserService,
  LOCAL_VERIFICATION_NOTICE,
} = require("../dist/communications/local-verification-browser.service.js");
const {
  TwilioVerifyAdapter,
} = require("../dist/communications/twilio-verify.adapter.js");
const {
  CustomerConsentBrowserTransport,
  readCustomerBrowserBody,
  CUSTOMER_BROWSER_HEADERS,
} = require("../dist/communications/customer-consent-browser-transport.js");
const {
  LocalCustomerBrowserBudget,
} = require("../dist/communications/customer-consent-browser-budget.js");
const {
  requestContextMiddleware,
  setAuthContext,
} = require("../dist/common/context/request-context.js");

export async function verifyBrowserVerification({
  prisma,
  cipher,
  credentials,
  responses,
  browser,
  evidence,
}) {
  const [db] = await prisma.$queryRawUnsafe(
    "SELECT current_database() AS name, inet_server_addr() AS address",
  );
  assert.match(db.name, /^calldesk_org_[0-9a-f]{12}$/);
  assert.equal(db.address, null);
  const tenant = await prisma.tenantOrganization.create({
    data: { name: "Fictional verification browser QA", timezone: "UTC" },
  });
  const tenantId = tenant.id;
  const fixture = (fn) =>
    new Promise((resolve, reject) =>
      requestContextMiddleware({ headers: {} }, {}, () => {
        setAuthContext({
          tenantId,
          userId: "integration:verification-fixture",
          role: "webchat_integration",
        });
        Promise.resolve().then(fn).then(resolve, reject);
      }),
    );
  let starts = 0,
    checks = 0,
    loseAck = true,
    transport,
    failStart = false;
  const binding = {
    tenantId,
    accountSid: "AC" + "a".repeat(32),
    serviceSid: "VA" + "b".repeat(32),
  };
  const sid = "VE" + "c".repeat(32);
  let phone;
  const provider = new TwilioVerifyAdapter(binding, () => ({
    verify: {
      v2: {
        services: () => ({
          verifications: {
            create: async ({ to }) => {
              starts++;
              if (failStart) throw Error("fictional timeout");
              phone = to;
              return { ...binding, sid, to, channel: "sms", status: "pending" };
            },
          },
          verificationChecks: {
            create: async ({ code }) => {
              checks++;
              return {
                ...binding,
                sid,
                to: phone,
                channel: "sms",
                status: code === "123456" ? "approved" : "pending",
              };
            },
          },
        }),
      },
    },
  }));
  const durable = new DurableVerificationService(
    prisma,
    cipher,
    credentials,
    Buffer.alloc(32, 6),
    provider,
    new VerificationBudgetAdmission({
      ...LOCAL_VERIFICATION_NOTICE,
      mode: "FIXTURE_ONLY",
      tenantId,
      rateVersion: "fictional-browser-flow-v1",
      flowUpperBoundUsdMicros: 25_000_000,
    }),
  );
  const files = {
    "/": (
      await readFile(
        new URL("./fixtures/customer-intake-journey.html", import.meta.url),
        "utf8",
      )
    ).replace(
      '<html lang="en">',
      '<html lang="en" data-verification-fixture="true" data-address-fixture="true">',
    ),
    "/journey.js": await readFile(
      new URL("./fixtures/customer-intake-journey.js", import.meta.url),
      "utf8",
    ),
  };
  let addressLost = false;
  const addressRequests = [];
  const requests = [],
    errors = [];
  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && files[req.url]) {
        for (const [k, v] of Object.entries(CUSTOMER_BROWSER_HEADERS))
          res.setHeader(k, v);
        res.setHeader(
          "Content-Type",
          req.url.endsWith(".js") ? "application/javascript" : "text/html",
        );
        res.setHeader(
          "Content-Security-Policy",
          "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
        );
        return res.end(files[req.url]);
      }
      const body = await readCustomerBrowserBody(req);
      if (req.url === "/customer-session/address")
        addressRequests.push(JSON.parse(body.toString()));
      if (req.url === "/customer-session/verify")
        requests.push(JSON.parse(body.toString()));
      const result = await fixture(() =>
        transport.handle({
          method: req.method,
          url: req.url,
          rawHeaders: req.rawHeaders,
          body,
          peerAddress: req.socket.remoteAddress,
          encrypted: false,
        }),
      );
      const lostAddress =
        !addressLost &&
        result.status === 200 &&
        result.body.addressState === "FIXTURE_VALIDATED";
      if (lostAddress) addressLost = true;
      const lost =
        lostAddress ||
        (loseAck &&
          result.status === 200 &&
          result.body.outcome === "APPROVED");
      if (lost) loseAck = false;
      res.statusCode = lost ? 503 : result.status;
      for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v);
      res.end(JSON.stringify(lost ? {} : result.body));
    } catch {
      res.statusCode = 503;
      res.end("{}");
    }
  });
  let context;
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    // Fresh local request limiter per fixture; never bypass the durable money reservation.
    let localBudget = new LocalCustomerBrowserBudget();
    transport = new CustomerConsentBrowserTransport(
      { origin, tenantId, fixtureLoopback: true },
      {
        responses,
        credentials,
        budget: { acquire: (...args) => localBudget.acquire(...args) },
        address: new LocalAddressService(
          prisma,
          cipher,
          credentials,
          ADDRESS_CATALOG,
        ),
        capture: {
          capture: async () => {
            throw Error("not used");
          },
        },
        continuation: {
          continue: async () => ({
            reply: "Fictional verification test conversation.",
            revision: 1,
            deliveryAuthorized: false,
          }),
        },
        verification: new LocalVerificationBrowserService(durable),
      },
    );
    context = await browser.newContext({
      viewport: { width: 390, height: 844 },
    });
    await context.route("**/*", (route) =>
      new URL(route.request().url()).origin === origin
        ? route.continue()
        : route.abort(),
    );
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    const begin = async () => {
      await page.goto(origin, { waitUntil: "load" });
      await page.locator("#start").click();
      await page.locator("#message").fill("Fictional cooling issue");
      await page.locator("#continue").click();
      await page.locator("#skip").click();
      await page.locator("#phone").fill("+12025550123");
      await page.locator("#customerName").fill("Fictional retained draft");
      await page.locator("#verifyNotice").click();
      await page.locator("#verifyConsent").waitFor({ state: "visible" });
    };
    await begin();
    assert.equal(await page.locator("#verifyStart").isEnabled(), false);
    assert.equal(
      await page.locator("#verifyNoticeText").innerText(),
      LOCAL_VERIFICATION_NOTICE.noticeText,
    );
    assert.equal(
      await page.locator("#verifyTerms").getAttribute("href"),
      LOCAL_VERIFICATION_NOTICE.termsUrl,
    );
    await page.locator("#verifyRequested").check();
    await page.locator("#phone").fill("+12025550124");
    assert.equal(await page.locator("#verifyStart").isEnabled(), false);
    await page.locator("#verifyNotice").click();
    await page.locator("#verifyRequested").check();
    await page.locator("#verifyStart").click();
    await page.getByText("Test request recorded.", { exact: false }).waitFor();
    await page.locator("#verifyCode").fill("000000");
    await page.locator("#verifyCheck").click();
    await page.waitForFunction(
      () => document.getElementById("verifyCode").value === "",
    );
    await page.locator("#verifyCode").fill("123456");
    await page.locator("#verifyCheck").click();
    await page.locator("#retry").waitFor({ state: "visible" });
    assert.equal(await page.locator("#verifyStart").isEnabled(), false);
    await page.locator("#retry").click();
    await page.getByText("Test code accepted.", { exact: false }).waitFor();
    assert.equal(starts, 1);
    assert.equal(checks, 2);
    const approvals = requests.filter((r) => r.code === "123456");
    assert.equal(approvals.length, 2);
    assert.deepEqual(approvals[0], approvals[1]);
    await page
      .locator("#durableVerification")
      .screenshot({ path: evidence + "/verification-journey-mobile.png" });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.setViewportSize({ width: 1280, height: 900 });
    await page
      .locator("#durableVerification")
      .screenshot({ path: evidence + "/verification-journey-desktop.png" });
    await page.locator("#verifyChange").click();
    await page.locator("#phone").fill("+12025550125");
    assert.equal(await page.locator("#verifyCheck").isEnabled(), false);
    assert.equal(await page.locator("#verifyStart").isEnabled(), false);
    assert.ok(
      (await page.locator("#verifyStatus").innerText()).includes(
        "no verification applies",
      ),
    );
    await page.locator("#forget").click();
    failStart = true;
    await begin();
    await page.locator("#verifyRequested").check();
    await page.locator("#verifyStart").click();
    await page.locator("#retry").waitFor({ state: "visible" });
    await page.locator("#retry").click();
    await page
      .getByText("Outcome unconfirmed. Do not request", { exact: false })
      .waitFor();
    assert.equal(starts, 2);
    await page.locator("#forget").click();
    await begin();
    await page.locator("#verifyRequested").check();
    await page.locator("#verifyStart").click();
    await page
      .getByText("Verification is unavailable: budget", { exact: false })
      .waitFor();
    assert.equal(
      await page.locator("#customerName").inputValue(),
      "Fictional retained draft",
    );
    assert.equal(starts, 2);
    await page
      .locator("#durableVerification")
      .screenshot({ path: evidence + "/verification-budget-refusal.png" });
    const holds = await prisma.auditLog.findMany({
      where: { tenantId, action: "conversation.verification_budget_reserved" },
    });
    assert.equal(holds.length, 2);
    assert.equal(
      holds.reduce((n, r) => n + r.metadata.reservedMicros, 0),
      50_000_000,
    );
    assert.equal(
      holds[0].metadata.noticeText,
      LOCAL_VERIFICATION_NOTICE.noticeText,
    );
    assert.equal(await prisma.job.count({ where: { tenantId } }), 0);
    assert.equal(
      await page.evaluate(() => localStorage.length + sessionStorage.length),
      0,
    );
    await page.locator("#forget").click();
    assert.equal(await page.locator("#phone").inputValue(), "");
    assert.equal(await page.locator("#verifyNoticeText").innerText(), "");
    assert.deepEqual(errors, []);
    const summary = {
      checks: [
        "server notice and unchecked consent; phone edit requires fresh acknowledgment",
        "mocked start and wrong/correct code through real durable services",
        "lost approval response exact retry without duplicate provider call or budget",
        "phone correction removes local verification state without replacement request",
        "unknown outcome exact retry retains original reservation",
        "budget refusal retains customer draft and does not call provider",
        "mobile/desktop fit, private clearing, no browser storage or page errors",
      ],
      mockedStarts: starts,
      mockedChecks: checks,
      liveProviderCalls: 0,
      newJobs: 0,
      phoneAccessAuthorized: false,
      productionRegistered: false,
    };
    await writeFile(
      evidence + "/verification-journey-summary.json",
      JSON.stringify(summary, null, 2),
    );
    localBudget = new LocalCustomerBrowserBudget();
    await begin();
    await verifyAddressJourney({
      page,
      prisma,
      cipher,
      credentials,
      token: requests.at(-1).sessionToken,
      requests: addressRequests,
      evidence,
    });
    return summary;
  } finally {
    await context?.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
