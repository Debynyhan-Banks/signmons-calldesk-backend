import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
const require = createRequire(import.meta.url);
const {
  CustomerIntakeContinuationService: Intake,
} = require("../dist/communications/customer-intake-continuation.service.js");
const {
  CustomerConsentCredentials: Credentials,
} = require("../dist/communications/customer-consent-credentials.js");
const {
  ConversationMemoryCipher: Cipher,
} = require("../dist/logging/conversation-memory-cipher.service.js");
const {
  CustomerConsentResponseService: Responses,
} = require("../dist/communications/customer-consent-response.service.js");
const {
  CustomerConsentCaptureService: Capture,
} = require("../dist/communications/customer-consent-capture.service.js");
const {
  CustomerConsentBrowserTransport: Transport,
  CUSTOMER_BROWSER_HEADERS: HEADERS,
  readCustomerBrowserBody,
} = require("../dist/communications/customer-consent-browser-transport.js");
const {
  LocalCustomerBrowserBudget: Budget,
} = require("../dist/communications/customer-consent-browser-budget.js");
const {
  requestContextMiddleware,
  setAuthContext,
} = require("../dist/common/context/request-context.js");

export async function verifyOrganizationIntake({
  prisma,
  tenantId,
  otherTenantId,
  asOwner,
  organizationService,
  browser,
  evidence,
}) {
  const [db] = await prisma.$queryRawUnsafe(
    "SELECT current_database() AS name, inet_server_addr() AS address",
  );
  assert.match(db.name, /^calldesk_org_[0-9a-f]{12}$/);
  assert.equal(db.address, null);
  const credentials = new Credentials({
    activeKeyId: "fixture",
    keys: { fixture: Buffer.alloc(32, 4) },
  });
  const cipher = new Cipher({ conversationDataEncryptionKey: "4".repeat(64) });
  const responses = new Responses(prisma, cipher, credentials, {
    record: async () => {
      throw new Error("Consent writes disabled in this proof");
    },
  });
  const intake = new Intake(prisma, cipher, credentials);
  const integration = (fn, id = tenantId) =>
    new Promise((resolve, reject) =>
      requestContextMiddleware({ headers: {} }, {}, () => {
        setAuthContext({
          tenantId: id,
          userId: "integration:fictional",
          role: "webchat_integration",
        });
        Promise.resolve().then(fn).then(resolve, reject);
      }),
    );
  const other = await integration(() => responses.start(), otherTenantId);
  await assert.rejects(
    intake.continueOrganization({
      sessionToken: other.sessionToken,
      interactionId: randomUUID(),
      message: "Do you repair heating?",
    }),
  );
  const checks = [
    "tenant without approved profile cannot borrow another tenant answers",
  ];
  const html = await readFile(
    new URL("./fixtures/customer-intake-journey.html", import.meta.url),
  );
  const js = await readFile(
    new URL("./fixtures/customer-intake-journey.js", import.meta.url),
  );
  let latest, transport;
  const server = createServer(async (req, res) => {
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
      res.end(req.url === "/" ? html : js);
      return;
    }
    try {
      const body = await readCustomerBrowserBody(req);
      const result = await integration(() =>
        transport.handle({
          method: req.method,
          url: req.url,
          rawHeaders: req.rawHeaders,
          body,
          peerAddress: req.socket.remoteAddress,
          encrypted: false,
        }),
      );
      res.statusCode = result.status;
      for (const [key, value] of Object.entries(result.headers))
        res.setHeader(key, value);
      res.end(JSON.stringify(result.body));
    } catch {
      res.statusCode = 400;
      res.end("{}");
    }
  });
  let context;
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = "http://127.0.0.1:" + server.address().port;
    transport = new Transport(
      { origin, tenantId, fixtureLoopback: true },
      {
        responses: {
          start: async () => {
            latest = await responses.start();
            return latest;
          },
          prompt: (input) => responses.prompt(input),
          respond: (input) => responses.respond(input),
        },
        capture: new Capture(prisma, cipher, credentials),
        credentials,
        budget: new Budget(),
        continuation: {
          continue: (input) => intake.continueOrganization(input),
        },
        draft: intake,
      },
    );
    context = await browser.newContext({
      viewport: { width: 1280, height: 1000 },
    });
    await context.route("**/*", (route) =>
      new URL(route.request().url()).origin === origin
        ? route.continue()
        : route.abort(),
    );
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(origin, { waitUntil: "load" });
    await page.locator("#start").click();
    await page.locator("#conversation").waitFor({ state: "visible" });
    await page.locator("#message").fill("Do you repair heating?");
    await page.locator("#continue").click();
    await page.locator("#email").waitFor({ state: "visible" });
    assert.ok(
      (await page.locator("body").innerText()).includes(
        "Yes, we service heating equipment.",
      ),
    );
    await page.locator("#skip").click();
    await page.locator("#details").waitFor({ state: "visible" });
    const draft = {
      customerName: "Fictional Customer",
      phone: "+12025550123",
      address: "123 Fictional Lane",
      description: "Do you repair heating?",
      issueCategory: "COOLING",
      propertyType: "RESIDENTIAL",
      serviceIntent: "REPAIR",
    };
    for (const key of ["customerName", "phone", "address"])
      await page.locator("#" + key).fill(draft[key]);
    for (const key of ["issueCategory", "propertyType", "serviceIntent"])
      await page.locator("#" + key).selectOption(draft[key]);
    await page.locator("#reviewed").check();
    await page.locator("#draft").click();
    await page.locator("#preview").waitFor({ state: "visible" });
    await page.screenshot({
      path: evidence + "/organization-intake-desktop.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.screenshot({
      path: evidence + "/organization-intake-mobile.png",
      fullPage: true,
    });
    assert.deepEqual(errors, []);
    checks.push(
      "protected browser approved answer and optional-email skip/read-only draft desktop/mobile",
    );
    const request = {
      sessionToken: latest.sessionToken,
      requestId: randomUUID(),
      expectedRevision: 1,
      draft,
      confirmed: true,
    };
    await intake.submitReview(request);
    const noCredentials = new Proxy(
      {},
      {
        get() {
          throw new Error("Operator accessed customer credentials");
        },
      },
    );
    const operator = new Intake(prisma, cipher, noCredentials);
    const reviewed = await asOwner(() =>
      operator.readReview({ requestId: request.requestId }),
    );
    assert.equal(
      reviewed.organizationApprovedAt,
      (await asOwner(() => organizationService.read())).profile.approved
        .approvedAt,
    );
    assert.equal(reviewed.jobCreated, false);
    assert.ok(!JSON.stringify(reviewed).includes(latest.sessionToken));
    checks.push(
      "service-level submit and token-free operator read retain approved version without job admission",
    );
    const scope = credentials.verifySession(latest.sessionToken);
    const events = await prisma.communicationEvent.findMany({
      where: { conversationId: scope.conversationId },
      include: { content: true },
    });
    const turn = events.find(
      (event) => event.content.payload.type === "protected_intake_turn_v1",
    );
    assert.equal(turn.content.payload.version, 2);
    assert.match(turn.content.payload.organizationDigest, /^[0-9a-f]{64}$/);
    assert.ok(
      !JSON.stringify(events).includes("Yes, we service heating equipment."),
    );
    const replay = {
      sessionToken: latest.sessionToken,
      interactionId: turn.id,
      message: "Do you repair heating?",
    };
    const count = await prisma.communicationEvent.count();
    await intake.continueOrganization(replay);
    assert.equal(await prisma.communicationEvent.count(), count);
    await assert.rejects(
      intake.continue({ ...replay, interactionId: randomUUID() }),
    );
    checks.push(
      "encrypted version-bound exact replay and scripted-mode isolation",
    );
    let state = await asOwner(() => organizationService.read());
    state = await asOwner(() =>
      organizationService.write({
        expectedUpdatedAt: state.updatedAt,
        draft: { ...state.profile.draft, greeting: "Future approved greeting" },
      }),
    );
    await asOwner(() => operator.readReview({ requestId: request.requestId }));
    await asOwner(() =>
      organizationService.write(
        { expectedUpdatedAt: state.updatedAt, acknowledged: true },
        true,
      ),
    );
    await assert.rejects(
      asOwner(() => operator.readReview({ requestId: request.requestId })),
    );
    await assert.rejects(intake.continueOrganization(replay));
    assert.equal(await prisma.communicationEvent.count(), count);
    checks.push(
      "new approval refuses stale review and replay; draft-only changes do not invalidate",
    );
    await writeFile(
      evidence + "/organization-intake-summary.json",
      JSON.stringify(
        {
          checks,
          providerCalls: 0,
          jobCreated: false,
          liveAI: false,
          browserSubmission:
            "read-only draft; durable submit/operator read tested at service boundary",
          approvalChange:
            "old session refused; automatic restart/recovery not implemented",
        },
        null,
        2,
      ),
    );
    return checks;
  } finally {
    await context?.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
