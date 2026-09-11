// Section 2A injected-source proof, using the existing customer and operator pages.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
const require = createRequire(import.meta.url);
const { Test } = require("@nestjs/testing");
const { UnauthorizedException } = require("@nestjs/common");
const {
  CustomerIntakeContinuationService: Intake,
} = require("../dist/communications/customer-intake-continuation.service.js");
const {
  CustomerIntakeReviewController: Controller,
} = require("../dist/communications/customer-intake-review.controller.js");
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
const { RequestAuthGuard } = require("../dist/auth/request-auth.guard.js");
const { LoggingService } = require("../dist/logging/logging.service.js");
const {
  requestContextMiddleware,
  setAuthContext,
} = require("../dist/common/context/request-context.js");
const {
  createVerificationProof,
} = require("../dist/communications/verification-freshness.js");
const {
  VerificationCleanupService,
} = require("../dist/communications/verification-cleanup.service.js");

export async function verifyCurrentProofAdmission({
  prisma,
  cipher,
  credentials,
  browser,
  evidence,
  templateTenantId,
}) {
  const [db] = await prisma.$queryRawUnsafe(
    "SELECT current_database() AS name, inet_server_addr() AS address",
  );
  assert.match(db.name, /^calldesk_org_[0-9a-f]{12}$/);
  assert.equal(db.address, null);
  const template = await prisma.tenantOrganization.findUnique({
    where: { id: templateTenantId },
  });
  const payment = {
    currency: "usd",
    serviceFeeRequired: true,
    serviceFeeCents: 100,
    depositRequired: false,
    depositPolicy: { kind: "none" },
    emergencyFeePolicy: { kind: "none" },
    paymentGateMode: "fail_closed",
    webhookValidationRequired: true,
  };
  const paymentApprovedAt = new Date().toISOString();
  const tenant = await prisma.tenantOrganization.create({
    data: {
      name: "Fictional 2A",
      timezone: "UTC",
      settings: {
        ...template.settings,
        organizationPaymentPolicyV1: {
          version: 1,
          draft: payment,
          approved: {
            draft: payment,
            actorId: "fictional-owner",
            approvedAt: paymentApprovedAt,
          },
        },
      },
    },
  });
  const tenantId = tenant.id;
  await prisma.serviceCategory.create({ data: { tenantId, name: "COOLING" } });
  const context = (role, fn, id = tenantId) =>
    new Promise((resolve, reject) =>
      requestContextMiddleware({ headers: {} }, {}, () => {
        setAuthContext({
          tenantId: id,
          userId: role === "owner" ? "fictional-owner" : "integration:2a",
          role,
        });
        Promise.resolve().then(fn).then(resolve, reject);
      }),
    );
  const responses = new Responses(prisma, cipher, credentials, {
    record: async () => {
      throw Error("No consent mutation");
    },
  });
  const intake = new Intake(prisma, cipher, credentials);
  let supplied,
    mutation = (e) => e,
    fault = false,
    transport,
    submission,
    token,
    lost = false;
  const source = {
    mode: "FIXTURE_ONLY",
    resolve: async (tx, input) => {
      const row = await tx.tenantOrganization.findUnique({
        where: { id: input.tenantId },
      });
      if (input.requestId !== submission?.requestId) return null;
      const result = structuredClone(supplied);
      result.current.freshness.businessPolicyVersion =
        row.settings.organizationProfileV1.approved.approvedAt;
      return mutation(result);
    },
  };
  const wrapped = {
    $transaction: (fn, ...args) =>
      prisma.$transaction(
        (tx) =>
          fn(
            new Proxy(tx, {
              get(target, key) {
                if (key === "auditLog")
                  return {
                    ...target.auditLog,
                    create: (args) => {
                      if (
                        fault &&
                        args.data.action === "job.customer_intake_admitted"
                      )
                        throw Error("fixture audit failure");
                      return target.auditLog.create(args);
                    },
                  };
                const value = target[key];
                return typeof value === "function" ? value.bind(target) : value;
              },
            }),
          ),
        ...args,
      ),
  };
  const operator = new Intake(
    wrapped,
    cipher,
    new Proxy(
      {},
      {
        get() {
          throw Error("Operator cannot access customer credentials");
        },
      },
    ),
    undefined,
    undefined,
    undefined,
    source,
  );
  const module = await Test.createTestingModule({
    controllers: [Controller],
    providers: [
      { provide: Intake, useValue: operator },
      { provide: LoggingService, useValue: { warn() {}, error() {} } },
    ],
  })
    .overrideGuard(RequestAuthGuard)
    .useValue({
      canActivate(c) {
        if (
          c.switchToHttp().getRequest().headers.authorization !==
          "Bearer fixture-owner"
        )
          throw new UnauthorizedException();
        setAuthContext({ tenantId, userId: "fictional-owner", role: "owner" });
        return true;
      },
    })
    .compile();
  const app = module.createNestApplication({ logger: false });
  const files = {};
  for (const [path, name] of Object.entries({
    "/customer": "customer-intake-journey.html",
    "/journey.js": "customer-intake-journey.js",
    "/operator": "operator-intake-review.html",
    "/operator-review.js": "operator-intake-review.js",
    "/payment-policy.js": "payment-policy.js",
    "/window-review.js": "window-review.js",
  }))
    files[path] = await readFile(
      new URL("./fixtures/" + name, import.meta.url),
      "utf8",
    );
  files["/customer"] = files["/customer"].replace(
    '<html lang="en">',
    '<html lang="en" data-review-submit="true">',
  );
  app.use(requestContextMiddleware);
  app.use(async (req, res, next) => {
    if (files[req.url] && req.method === "GET") {
      for (const [k, v] of Object.entries(HEADERS)) res.setHeader(k, v);
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
    if (req.url === "/intake-review-request/approve") {
      const json = res.json.bind(res);
      res.json = (body) => {
        if (!lost && res.statusCode < 300) {
          lost = true;
          res.statusCode = 503;
          return json({});
        }
        return json(body);
      };
    }
    if (!req.url.startsWith("/customer-session/")) return next();
    try {
      const body = await readCustomerBrowserBody(req);
      const r = await context("webchat_integration", () =>
        transport.handle({
          method: req.method,
          url: req.url,
          rawHeaders: req.rawHeaders,
          body,
          peerAddress: req.socket.remoteAddress,
          encrypted: false,
        }),
      );
      if (req.url === "/customer-session/start" && r.status === 200)
        token = r.body.sessionToken;
      if (req.url === "/customer-session/submit" && r.status === 200)
        submission = JSON.parse(body.toString());
      res.statusCode = r.status;
      for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v);
      return res.end(JSON.stringify(r.body));
    } catch {
      res.statusCode = 503;
      return res.end("{}");
    }
  });
  let customerContext, operatorContext;
  try {
    await app.listen(0, "127.0.0.1");
    const origin = await app.getUrl();
    transport = new Transport(
      { origin, tenantId, fixtureLoopback: true },
      {
        responses,
        capture: new Capture(prisma, cipher, credentials),
        credentials,
        budget: new Budget(),
        continuation: { continue: (i) => intake.continueOrganization(i) },
        draft: intake,
        review: intake,
      },
    );
    customerContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
    });
    operatorContext = await browser.newContext({
      viewport: { width: 1280, height: 900 },
    });
    const errors = [];
    for (const c of [customerContext, operatorContext])
      await c.route("**/*", (r) =>
        new URL(r.request().url()).origin === origin ? r.continue() : r.abort(),
      );
    const customer = await customerContext.newPage(),
      reviewer = await operatorContext.newPage();
    for (const p of [customer, reviewer])
      p.on("pageerror", (e) => errors.push(e.message));
    await customer.goto(origin + "/customer", { waitUntil: "load" });
    await customer.locator("#start").click();
    await customer.locator("#message").fill("Do you service heating?");
    await customer.locator("#continue").click();
    await customer.locator("#email").waitFor({ state: "visible" });
    await customer.locator("#skip").click();
    for (const [id, v] of Object.entries({
      customerName: "Fictional 2A Customer",
      phone: "+12025550196",
      address: "196 Fictional Lane",
      description: "Fictional cooling issue",
    }))
      await customer.locator("#" + id).fill(v);
    for (const [id, v] of Object.entries({
      issueCategory: "COOLING",
      propertyType: "RESIDENTIAL",
      serviceIntent: "REPAIR",
    }))
      await customer.locator("#" + id).selectOption(v);
    await customer.locator("#reviewed").check();
    await customer.locator("#draft").click();
    await customer.locator("#submitReview").click();
    await customer.locator("#submitted").waitFor({ state: "visible" });
    const claims = credentials.verifySession(token),
      now = Date.now();
    const approvedAt =
      tenant.settings.organizationProfileV1.approved.approvedAt;
    const policy = {
      mode: "FIXTURE_ONLY",
      version: "2A",
      noticeVersion: "fixture-notice",
      sourceVersion: "injected-not-provider",
      businessPolicyVersion: approvedAt,
      lifetimeMs: 1800000,
    };
    const proof = (revision) =>
      createVerificationProof(
        {
          tenantId,
          sessionId: claims.sessionId,
          revision,
          expiresAt: claims.expiresAt,
        },
        policy,
        now,
        now,
      );
    supplied = {
      mode: "FIXTURE_ONLY",
      phone: {
        reference: "fixture-phone",
        value: submission.draft.phone,
        revision: "phone-1",
        usEligible: true,
        state: "APPROVED",
        proof: proof("phone-1"),
      },
      address: {
        reference: "fixture-address",
        value: submission.draft.address,
        revision: "address-1",
        confirmed: true,
        state: "VALIDATED",
        proof: proof("address-1"),
      },
      coverage: {
        reference: "fixture-county",
        policyVersion: "county-v1",
        country: "US",
        state: "OH",
        county: "39035",
        outcome: "IN_AREA",
        addressRevision: "address-1",
        proof: proof("address-1"),
      },
      current: {
        phoneRevision: "phone-1",
        addressRevision: "address-1",
        coveragePolicyVersion: "county-v1",
        freshness: policy,
        paymentApprovedAt: approvedAt,
        payment: {
          currency: "usd",
          serviceFeeRequired: true,
          serviceFeeCents: 100,
          depositRequired: false,
          depositPolicy: { kind: "none" },
          emergencyFeePolicy: { kind: "none" },
          paymentGateMode: "fail_closed",
          webhookValidationRequired: true,
        },
      },
    };
    supplied.current.paymentApprovedAt = paymentApprovedAt;
    supplied.current.payment = payment;
    // Read the existing operator decision shape, rather than adding a new UI form.
    await reviewer.goto(origin + "/operator", { waitUntil: "load" });
    await reviewer.locator("#operatorToken").fill("fixture-owner");
    await reviewer.locator("#requestId").fill(submission.requestId);
    await reviewer.locator("#load").click();
    await reviewer.locator("#review").waitFor({ state: "visible" });
    await reviewer.locator("#urgency").selectOption("STANDARD");
    await reviewer.locator("#ack").check();
    const mutations = [
      (e) => {
        e.phone.value = "+12025550199";
        return e;
      },
      (e) => {
        e.address.value = "Changed";
        return e;
      },
      (e) => {
        e.phone.state = "UNCERTAIN";
        return e;
      },
      (e) => {
        e.address.confirmed = false;
        return e;
      },
      (e) => {
        e.coverage.outcome = "UNKNOWN";
        return e;
      },
      (e) => {
        e.coverage.county = "39093";
        return e;
      },
      (e) => {
        e.current.phoneRevision = "changed";
        return e;
      },
      (e) => {
        e.current.coveragePolicyVersion = "changed";
        return e;
      },
      (e) => {
        e.phone.proof.scope.tenantId = templateTenantId;
        return e;
      },
      (e) => {
        e.phone.proof.expiresAt = now - 1;
        return e;
      },
    ];
    // Exact operator payload is captured from the existing UI for all transaction tests.
    let body;
    await reviewer.route("**/intake-review-request/approve", async (route) => {
      body = route.request().postDataJSON();
      await route.continue();
    });
    fault = true;
    await reviewer.locator("#approve").click();
    await reviewer.locator("#retry").waitFor({ state: "visible" });
    await reviewer.waitForFunction(
      () => !document.getElementById("retry").disabled,
    );
    assert.equal(await prisma.job.count({ where: { tenantId } }), 0);
    fault = false;
    for (const mutate of mutations) {
      mutation = mutate;
      await assert.rejects(context("owner", () => operator.admitReview(body)));
      assert.equal(await prisma.job.count({ where: { tenantId } }), 0);
    }
    mutation = (e) => e;
    await assert.rejects(
      context("technician", () => operator.admitReview(body)),
    );
    await assert.rejects(
      context("owner", () => operator.admitReview(body), templateTenantId),
    );
    await reviewer.locator("#retry").click();
    await reviewer.waitForFunction(
      () => !document.getElementById("retry").disabled,
    );
    await reviewer.locator("#retry").click();
    await reviewer.locator("#result").waitFor({ state: "visible" });
    await new VerificationCleanupService(
      prisma,
      credentials,
      "FIXTURE_ONLY",
    ).sweep(tenantId);
    mutation = () => {
      throw Error("Receipt replay must not consume fresh proof");
    };
    const replays = await Promise.all([
      context("owner", () => operator.admitReview(body)),
      context("owner", () => operator.admitReview(body)),
    ]);
    assert.deepEqual(replays[0], replays[1]);
    const jobs = await prisma.job.findMany({ where: { tenantId } });
    assert.equal(jobs.length, 1);
    assert.equal(
      jobs[0].policySnapshot.intakeAdmission.currentProof.fixtureOnly,
      true,
    );
    assert.equal(
      jobs[0].policySnapshot.intakeAdmission.currentProof
        .realVerificationAccepted,
      false,
    );
    assert.equal(
      await prisma.auditLog.count({
        where: { tenantId, action: "job.customer_intake_admitted" },
      }),
      1,
    );
    await reviewer.screenshot({
      path: evidence + "/current-proof-admission-desktop.png",
      fullPage: true,
    });
    await reviewer.setViewportSize({ width: 390, height: 844 });
    await reviewer.screenshot({
      path: evidence + "/current-proof-admission-mobile.png",
      fullPage: true,
    });
    assert.equal(
      await reviewer.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    assert.deepEqual(errors, []);
    await writeFile(
      evidence + "/current-proof-admission-summary.json",
      JSON.stringify(
        {
          checks: [
            "existing customer submits and existing operator approves with separate fixture identity",
            "ten invalid or changed injected proof cases refuse without a job",
            "wrong role and tenant refuse",
            "real audit failure rolls back admission",
            "lost acknowledgment and concurrent exact replay after cleanup retain one job and audit without fresh proof",
            "fixture-only references bind atomically without real verification or send authority",
            "desktop/mobile existing operator page, zero page errors",
          ],
          liveProviderCalls: 0,
          realVerificationAccepted: false,
          productionRegistered: false,
        },
        null,
        2,
      ),
    );
  } finally {
    await customerContext?.close();
    await operatorContext?.close();
    await app.close();
  }
}
