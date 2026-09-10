// Local-only composition: real services/controllers, explicit fixture identity.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { verifyPreferredWindow } from "./verify-preferred-window-review.mjs";
import { verifyLocalPhone } from "./verify-local-phone.mjs";
const require = createRequire(import.meta.url);
const {
  LocalCustomerPhoneService: Phone,
} = require("../dist/communications/local-customer-phone.service.js");
const { Test } = require("@nestjs/testing");
const {
  PreferredWindowReviewService: WindowReview,
} = require("../dist/jobs/preferred-window-review.service.js");
const {
  PreferredWindowReviewController: WindowController,
} = require("../dist/jobs/preferred-window-review.controller.js");
const {
  OrganizationPaymentPolicyService: Policy,
} = require("../dist/tenants/organization-payment-policy.service.js");
const {
  OrganizationPaymentPolicyController: PolicyController,
} = require("../dist/tenants/organization-payment-policy.controller.js");
const {
  JobPaymentPolicyService: JobPolicy,
} = require("../dist/jobs/job-payment-policy.service.js");
const {
  JobPaymentPolicyController: JobPolicyController,
} = require("../dist/jobs/job-payment-policy.controller.js");
const {
  BookingReadinessPreviewService: Readiness,
} = require("../dist/jobs/booking-readiness-preview.service.js");
const {
  BookingReadinessPreviewController: ReadinessController,
} = require("../dist/jobs/booking-readiness-preview.controller.js");
const { UnauthorizedException } = require("@nestjs/common");
const {
  CustomerIntakeContinuationService: Intake,
} = require("../dist/communications/customer-intake-continuation.service.js");
const {
  CustomerIntakeReviewController: Controller,
} = require("../dist/communications/customer-intake-review.controller.js");
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
const { RequestAuthGuard } = require("../dist/auth/request-auth.guard.js");
const { LoggingService } = require("../dist/logging/logging.service.js");
const {
  requestContextMiddleware,
  setAuthContext,
} = require("../dist/common/context/request-context.js");

export async function verifyBrowserReviewAdmission({
  prisma,
  tenantId,
  otherTenantId,
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
    keys: { fixture: Buffer.alloc(32, 9) },
  });
  const cipher = new Cipher({ conversationDataEncryptionKey: "9".repeat(64) });
  const responses = new Responses(prisma, cipher, credentials, {
    record: async () => {
      throw Error("No consent writes in this proof");
    },
  });
  const intake = new Intake(prisma, cipher, credentials);
  let credentialAccesses = 0;
  const operator = new Intake(
    prisma,
    cipher,
    new Proxy(
      {},
      {
        get() {
          credentialAccesses++;
          throw Error("No customer credentials for operator");
        },
      },
    ),
  );
  const fixture = (fn) =>
    new Promise((resolve, reject) =>
      requestContextMiddleware({ headers: {} }, {}, () => {
        setAuthContext({
          tenantId,
          userId: "integration:fixture",
          role: "webchat_integration",
        });
        Promise.resolve().then(fn).then(resolve, reject);
      }),
    );
  const phoneProof = await verifyLocalPhone({
    prisma,
    cipher,
    credentials,
    responses,
    fixture,
  });
  await writeFile(
    evidence + "/phone-database-summary.json",
    JSON.stringify(phoneProof, null, 2),
  );
  const module = await Test.createTestingModule({
    controllers: [
      Controller,
      ReadinessController,
      PolicyController,
      JobPolicyController,
      WindowController,
    ],
    providers: [
      { provide: Intake, useValue: operator },
      { provide: WindowReview, useValue: new WindowReview(prisma) },
      { provide: Policy, useValue: new Policy(prisma) },
      { provide: JobPolicy, useValue: new JobPolicy(prisma) },
      { provide: Readiness, useValue: new Readiness(prisma) },
      { provide: LoggingService, useValue: { warn() {}, error() {} } },
    ],
  })
    .overrideGuard(RequestAuthGuard)
    .useValue({
      canActivate(context) {
        const token = context.switchToHttp().getRequest().headers.authorization;
        if (
          ![
            "Bearer fixture-owner",
            "Bearer fixture-other",
            "Bearer fixture-tech",
          ].includes(token)
        )
          throw new UnauthorizedException();
        setAuthContext({
          tenantId: token === "Bearer fixture-other" ? otherTenantId : tenantId,
          userId: "fictional-owner",
          role: token === "Bearer fixture-tech" ? "technician" : "owner",
        });
        return true;
      },
    })
    .compile();
  const app = module.createNestApplication({ logger: false });
  let customerContext, operatorContext, transport;
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
    '<html lang="en" data-review-submit="true" data-phone-fixture="true">',
  );
  assert.ok(files["/customer"].includes('data-review-submit="true"'));
  let lostSubmission = false,
    lostApproval = false,
    lostWindow = false,
    lostPhone = false;
  app.use(requestContextMiddleware);
  app.use(async (req, res, next) => {
    if (req.url === "/preferred-window-review/save") {
      const json = res.json.bind(res);
      res.json = (body) => {
        if (!lostWindow && res.statusCode < 300) {
          lostWindow = true;
          res.statusCode = 503;
          return json({});
        }
        return json(body);
      };
    }
    if (req.url === "/intake-review-request/approve") {
      const json = res.json.bind(res);
      res.json = (body) => {
        if (!lostApproval && res.statusCode < 300) {
          lostApproval = true;
          res.statusCode = 503;
          return json({});
        }
        return json(body);
      };
    }
    if (files[req.url] && req.method === "GET") {
      for (const [key, value] of Object.entries(HEADERS))
        res.setHeader(key, value);
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
    if (!req.url.startsWith("/customer-session/")) return next();
    try {
      const body = await readCustomerBrowserBody(req);
      const value = await fixture(() =>
        transport.handle({
          method: req.method,
          url: req.url,
          rawHeaders: req.rawHeaders,
          body,
          peerAddress: req.socket.remoteAddress,
          encrypted: false,
        }),
      );
      const losePhone =
        req.url === "/customer-session/phone" &&
        value.status === 200 &&
        value.body.state === "FIXTURE_VERIFIED" &&
        !lostPhone;
      if (losePhone) lostPhone = true;
      const lose =
        losePhone ||
        (req.url === "/customer-session/submit" &&
          value.status === 200 &&
          !lostSubmission);
      if (lose && !losePhone) lostSubmission = true;
      res.statusCode = lose ? 503 : value.status;
      for (const [key, value2] of Object.entries(value.headers))
        res.setHeader(key, value2);
      res.end(JSON.stringify(lose ? {} : value.body));
    } catch {
      res.statusCode = 400;
      res.end("{}");
    }
  });
  const errors = [],
    submissions = [],
    approvals = [],
    phoneRequests = [],
    checks = [];
  const before = await prisma.job.count();
  try {
    await app.listen(0, "127.0.0.1");
    const origin = await app.getUrl();
    transport = new Transport(
      { origin, tenantId, fixtureLoopback: true },
      {
        responses,
        localPhone: new Phone(prisma, cipher, credentials, Buffer.alloc(32, 7)),
        capture: new Capture(prisma, cipher, credentials),
        credentials,
        budget: new Budget(),
        continuation: {
          continue: (input) => intake.continueOrganization(input),
        },
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
    for (const context of [customerContext, operatorContext])
      await context.route("**/*", async (route) => {
        const request = route.request(),
          url = new URL(request.url());
        if (url.origin !== origin) return route.abort();
        const list =
          url.pathname === "/customer-session/phone"
            ? phoneRequests
            : url.pathname === "/customer-session/submit"
              ? submissions
              : url.pathname === "/intake-review-request/approve"
                ? approvals
                : null;
        if (!list) return route.continue();
        list.push(request.postData());
        return route.continue();
      });
    const customer = await customerContext.newPage(),
      reviewer = await operatorContext.newPage();
    for (const page of [customer, reviewer])
      page.on("pageerror", (e) => errors.push(e.message));
    await customer.goto(origin + "/customer", { waitUntil: "load" });
    await customer.locator("#start").click();
    await customer.locator("#message").fill("Do you repair heating?");
    await customer.locator("#continue").click();
    await customer.locator("#email").waitFor({ state: "visible" });
    assert.ok(
      (await customer.locator("body").innerText()).includes(
        "Yes, we service heating equipment.",
      ),
    );
    await customer.locator("#skip").click();
    for (const [id, value] of Object.entries({
      customerName: "Fictional Browser Customer",
      phone: "+12025550196",
      address: "196 Fictional Lane",
    }))
      await customer.locator("#" + id).fill(value);
    for (const [id, value] of Object.entries({
      issueCategory: "COOLING",
      propertyType: "RESIDENTIAL",
      serviceIntent: "REPAIR",
    }))
      await customer.locator("#" + id).selectOption(value);
    await customer.locator("#phoneRequest").click();
    await customer
      .locator("#phoneStatus")
      .filter({ hasText: "Enter test code" })
      .waitFor();
    await customer.locator("#phoneCode").fill("000000");
    await customer.locator("#phoneCheck").click();
    await customer.waitForFunction(
      () => document.querySelector("#phoneCode").value === "",
    );
    await customer.locator("#phoneCode").fill("123456");
    await customer.locator("#phoneCheck").click();
    await customer.locator("#retry").waitFor({ state: "visible" });
    await customer.locator("#retry").click();
    await customer
      .locator("#phoneStatus")
      .filter({ hasText: "Test verification complete" })
      .waitFor();
    const successfulChecks = phoneRequests.filter(
      (s) => JSON.parse(s).code === "123456",
    );
    assert.equal(successfulChecks.length, 2);
    assert.equal(successfulChecks[0], successfulChecks[1]);
    await customer.setViewportSize({ width: 1280, height: 900 });
    await customer
      .locator("#details")
      .screenshot({ path: evidence + "/phone-fixture-desktop.png" });
    await customer.setViewportSize({ width: 390, height: 844 });
    await customer
      .locator("#details")
      .screenshot({ path: evidence + "/phone-fixture-mobile.png" });
    assert.equal(
      await customer.locator("#phone").evaluate((e) => e.readOnly),
      true,
    );
    await customer.locator("#phoneChange").click();
    await customer
      .locator("#phoneStatus")
      .filter({ hasText: "Previous test proof cleared" })
      .waitFor();
    assert.equal(
      await customer.locator("#phone").evaluate((e) => e.readOnly),
      false,
    );
    await customer.locator("#phone").fill("+12025550197");
    checks.push(
      "local phone request, wrong code, successful fixture check and explicit correction invalidate proof without sending",
    );
    await customer.locator("#reviewed").check();
    await customer.locator("#draft").click();
    await customer.locator("#submitReview").click();
    await customer.locator("#retry").waitFor({ state: "visible" });
    await customer.locator("#retry").click();
    await customer.locator("#submitted").waitFor({ state: "visible" });
    assert.equal(submissions.length, 2);
    assert.equal(submissions[0], submissions[1]);
    const { requestId } = JSON.parse(submissions[0]);
    assert.ok(
      (await customer.locator("#requestReceipt").innerText()).includes(
        requestId,
      ),
    );
    assert.equal(await prisma.job.count(), before);
    checks.push(
      "customer explicitly submits immutable review request; lost acknowledgment exact retry creates no job",
    );
    await customer.screenshot({
      path: evidence + "/customer-submitted-mobile.png",
      fullPage: true,
    });
    for (const [token, status] of [
      ["bad", 401],
      ["fixture-other", 409],
      ["fixture-tech", 403],
    ]) {
      const response = await fetch(origin + "/intake-review-request/read", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ requestId }),
      });
      assert.equal(response.status, status);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
    }
    await reviewer.goto(origin + "/operator", { waitUntil: "load" });
    await reviewer.locator("#operatorToken").fill("fixture-owner");
    await reviewer.locator("#requestId").fill(requestId);
    await reviewer.locator("#load").click();
    await reviewer.locator("#review").waitFor({ state: "visible" });
    assert.equal(await reviewer.locator("#approve").isDisabled(), true);
    assert.ok(
      (await reviewer.locator("#facts").innerText()).includes(
        "Fictional Browser Customer",
      ),
    );
    await reviewer.locator("#urgency").selectOption("STANDARD");
    await reviewer.locator("#ack").check();
    await reviewer.screenshot({
      path: evidence + "/operator-review-desktop.png",
      fullPage: true,
    });
    await reviewer.locator("#approve").click();
    await reviewer.locator("#retry").waitFor({ state: "visible" });
    await reviewer.waitForFunction(
      () => !document.getElementById("retry").disabled,
    );
    assert.equal(await reviewer.locator("#urgency").isDisabled(), true);
    await reviewer.locator("#retry").click();
    await reviewer.locator("#result").waitFor({ state: "visible" });
    assert.equal(approvals.length, 2);
    assert.equal(approvals[0], approvals[1]);
    assert.ok(!approvals[0].includes("sessionToken"));
    assert.equal(await prisma.job.count(), before + 1);
    const jobs = await prisma.job.findMany({ where: { tenantId } });
    const job = jobs.find(
      (x) => x.policySnapshot?.intakeAdmission?.requestId === requestId,
    );
    assert.ok(job);
    assert.equal(job.status, "CREATED");
    assert.ok(
      (await reviewer.locator("#receipt").innerText()).includes(job.id),
    );
    assert.equal(credentialAccesses, 0);
    checks.push(
      "operator reads by opaque reference with role/tenant enforcement, selects urgency and explicitly approves",
    );
    checks.push(
      "lost approval acknowledgment exact retry returns one committed CREATED job without customer credentials",
    );
    await reviewer.setViewportSize({ width: 390, height: 844 });
    await reviewer.screenshot({
      path: evidence + "/operator-admitted-mobile.png",
      fullPage: true,
    });
    const snapshotBefore = await prisma.job.findUnique({
      where: { id: job.id },
    });
    const auditBefore = await prisma.auditLog.count();
    await reviewer.locator("#openReadiness").click();
    await reviewer.locator("#readiness").waitFor({ state: "visible" });
    const readinessText = await reviewer.locator("#readinessFacts").innerText();
    for (const reason of [
      "Preferred service window is missing",
      "Payment policy needs operator review",
      "Customer contact is not verified",
      "Service address is not verified",
    ])
      assert.ok(readinessText.includes(reason));
    assert.ok(
      (await reviewer.locator("#confirmationPreview").innerText()).includes(
        "no finalized booking",
      ),
    );
    await reviewer.screenshot({
      path: evidence + "/booking-readiness-mobile.png",
      fullPage: true,
    });
    await reviewer.setViewportSize({ width: 1280, height: 1000 });
    await reviewer.screenshot({
      path: evidence + "/booking-readiness-desktop.png",
      fullPage: true,
    });
    await reviewer.setViewportSize({ width: 390, height: 844 });
    assert.deepEqual(
      await prisma.job.findUnique({ where: { id: job.id } }),
      snapshotBefore,
    );
    assert.equal(await prisma.auditLog.count(), auditBefore);
    const preview = async (token = "fixture-owner", body = { jobId: job.id }) =>
      fetch(origin + "/booking-readiness/preview", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    assert.equal((await preview("fixture-other")).status, 404);
    assert.equal((await preview("fixture-tech")).status, 403);
    assert.equal((await preview("bad")).status, 401);
    assert.equal(
      (
        await preview("fixture-owner", {
          jobId: job.id,
          bookingAuthorized: true,
        })
      ).status,
      400,
    );
    await prisma.job.update({
      where: { id: job.id },
      data: {
        policySnapshot: {
          ...snapshotBefore.policySnapshot,
          depositRequired: true,
          serviceFeeRequired: false,
        },
      },
    });
    await reviewer.locator("#openReadiness").click();
    await reviewer.waitForFunction(() =>
      document
        .getElementById("readinessFacts")
        .textContent.includes("Required payment has not been requested"),
    );
    const paymentPreview = await preview();
    assert.equal(
      paymentPreview.headers.get("cache-control"),
      "private, no-store",
    );
    const paymentBody = await paymentPreview.json();
    assert.equal(paymentBody.payment.state, "LOCKED");
    assert.equal(paymentBody.bookingAuthorized, false);
    assert.equal(paymentBody.deliveryAuthorized, false);
    await writeFile(
      evidence + "/booking-readiness-summary.json",
      JSON.stringify(
        {
          jobId: job.id,
          initialBlockers: readinessText,
          paymentRequiredReason: paymentBody.payment.reason,
          readOnlyJobAndAuditUnchanged: true,
          bookingAuthorized: false,
          deliveryAuthorized: false,
          confirmation: paymentBody.confirmation,
          identity: "fixture only",
        },
        null,
        2,
      ),
    );
    await prisma.job.update({
      where: { id: job.id },
      data: { policySnapshot: snapshotBefore.policySnapshot },
    });
    checks.push(
      "created job opens read-only readiness; missing policy/window/verification and required-payment refusal; no false confirmation or writes",
    );
    await reviewer.locator("#loadPolicy").click();
    await reviewer.waitForFunction(
      () => !document.getElementById("savePolicy").disabled,
    );
    await reviewer.locator("#feeRequired").check();
    await reviewer.locator("#feeCents").fill("7500");
    await reviewer.locator("#savePolicy").click();
    await reviewer.waitForFunction(() =>
      document.getElementById("policySnapshot").textContent.includes("7500"),
    );
    assert.equal(await reviewer.locator("#approvePolicy").isDisabled(), true);
    await reviewer.locator("#policyAck").check();
    await reviewer.locator("#approvePolicy").click();
    await reviewer.waitForFunction(() =>
      document
        .getElementById("policySnapshot")
        .textContent.includes("approvedAt"),
    );
    const policyFetch = async () => {
      const r = await fetch(origin + "/organization/payment-policy", {
        headers: { Authorization: "Bearer fixture-owner" },
      });
      assert.equal(r.status, 200);
      return r.json();
    };
    const approvedPolicy = await policyFetch();
    const asPolicyOwner = (fn) =>
      new Promise((resolve, reject) =>
        requestContextMiddleware({ headers: {} }, {}, () => {
          setAuthContext({
            tenantId,
            userId: "fictional-owner",
            role: "owner",
          });
          Promise.resolve().then(fn).then(resolve, reject);
        }),
      );
    const failingDb = new Proxy(prisma, {
      get(target, key) {
        if (key === "$transaction")
          return (fn) =>
            target.$transaction((tx) =>
              fn(
                new Proxy(tx, {
                  get(t, k) {
                    return k === "auditLog"
                      ? {
                          create: async () => {
                            throw Error("fixture audit failure");
                          },
                        }
                      : Reflect.get(t, k);
                  },
                }),
              ),
            );
        return Reflect.get(target, key);
      },
    });
    const beforeFailedPolicy = await prisma.tenantOrganization.findUnique({
      where: { id: tenantId },
    });
    await assert.rejects(
      asPolicyOwner(() =>
        new Policy(failingDb).write({
          expectedUpdatedAt: approvedPolicy.updatedAt,
          draft: { ...approvedPolicy.policy.draft, serviceFeeCents: 8500 },
        }),
      ),
    );
    assert.deepEqual(
      await prisma.tenantOrganization.findUnique({ where: { id: tenantId } }),
      beforeFailedPolicy,
    );
    const beforeFailedBinding = await prisma.job.findUnique({
      where: { id: job.id },
    });
    await assert.rejects(
      asPolicyOwner(() =>
        new JobPolicy(failingDb).apply({
          jobId: job.id,
          expectedUpdatedAt: beforeFailedBinding.updatedAt.toISOString(),
          approvedAt: approvedPolicy.policy.approved.approvedAt,
          acknowledged: true,
        }),
      ),
    );
    assert.deepEqual(
      await prisma.job.findUnique({ where: { id: job.id } }),
      beforeFailedBinding,
    );
    await reviewer.locator("#openReadiness").click();
    await reviewer.waitForFunction(() =>
      document
        .getElementById("readinessFacts")
        .textContent.includes("Payment policy needs operator review"),
    );
    await reviewer.locator("#applyPolicyAck").check();
    const applying = reviewer.waitForRequest((r) =>
      r.url().endsWith("/job-payment-policy/apply"),
    );
    await reviewer.locator("#applyPolicy").click();
    const appliedRequest = await applying;
    await reviewer.waitForFunction(() =>
      document
        .getElementById("policyStatus")
        .textContent.includes("Reviewed policy attached"),
    );
    const bound = await prisma.job.findUnique({ where: { id: job.id } });
    assert.equal(bound.policySnapshot.serviceFeeRequired, true);
    assert.equal(bound.pricingSnapshot.serviceFeeAmountCents, 7500);
    assert.equal(
      bound.policySnapshot.paymentPolicyBinding.approvedAt,
      approvedPolicy.policy.approved.approvedAt,
    );
    assert.deepEqual(
      bound.policySnapshot.intakeAdmission,
      snapshotBefore.policySnapshot.intakeAdmission,
    );
    const auditCount = await prisma.auditLog.count();
    const replay = await fetch(origin + "/job-payment-policy/apply", {
      method: "POST",
      headers: {
        Authorization: "Bearer fixture-owner",
        "Content-Type": "application/json",
      },
      body: appliedRequest.postData(),
    });
    assert.equal(replay.status, 201);
    assert.equal(await prisma.auditLog.count(), auditCount);
    assert.deepEqual(
      await prisma.job.findUnique({ where: { id: job.id } }),
      bound,
    );
    await reviewer.locator("#feeCents").fill("9500");
    assert.equal(await reviewer.locator("#approvePolicy").isDisabled(), true);
    await reviewer.locator("#savePolicy").click();
    await reviewer.waitForFunction(() =>
      document.getElementById("policySnapshot").textContent.includes("9500"),
    );
    const changedDraft = await policyFetch();
    assert.equal(changedDraft.policy.approved.draft.serviceFeeCents, 7500);
    await reviewer.locator("#openReadiness").click();
    await reviewer.waitForFunction(() =>
      document
        .getElementById("readinessFacts")
        .textContent.includes("Required payment has not been requested"),
    );
    await reviewer.screenshot({
      path: evidence + "/payment-policy-mobile.png",
      fullPage: true,
    });
    await reviewer.setViewportSize({ width: 1280, height: 1000 });
    await reviewer.screenshot({
      path: evidence + "/payment-policy-desktop.png",
      fullPage: true,
    });
    await reviewer.setViewportSize({ width: 390, height: 844 });
    assert.equal((await preview()).status, 201);
    for (const token of ["fixture-tech", "fixture-other"]) {
      const refused = await fetch(origin + "/job-payment-policy/apply", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
        },
        body: appliedRequest.postData(),
      });
      assert.ok([403, 409].includes(refused.status));
    }
    assert.equal(await prisma.payment.count(), 0);
    const stale = await fetch(origin + "/organization/payment-policy/approve", {
      method: "POST",
      headers: {
        Authorization: "Bearer fixture-owner",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        expectedUpdatedAt: approvedPolicy.updatedAt,
        acknowledged: true,
      }),
    });
    assert.equal(stale.status, 409);
    const concurrent = await Promise.all(
      [1, 2].map(() =>
        fetch(origin + "/organization/payment-policy/approve", {
          method: "POST",
          headers: {
            Authorization: "Bearer fixture-owner",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            expectedUpdatedAt: changedDraft.updatedAt,
            acknowledged: true,
          }),
        }),
      ),
    );
    assert.deepEqual(concurrent.map((r) => r.status).sort(), [201, 409]);
    assert.deepEqual(
      await prisma.job.findUnique({ where: { id: job.id } }),
      bound,
    );
    const supersededReplay = await fetch(origin + "/job-payment-policy/apply", {
      method: "POST",
      headers: {
        Authorization: "Bearer fixture-owner",
        "Content-Type": "application/json",
      },
      body: appliedRequest.postData(),
    });
    assert.equal(supersededReplay.status, 409);
    await writeFile(
      evidence + "/payment-policy-summary.json",
      JSON.stringify(
        {
          approvedServiceFeeCents: 7500,
          unapprovedDraftServiceFeeCents: 9500,
          jobSnapshotPreserved: true,
          exactReplayNoWrites: true,
          realPolicyAndBindingAuditRollback: true,
          concurrentApprovalCommitsOnce: true,
          supersededApprovalReplayRefused: true,
          paymentRecords: 0,
          bookingAuthorized: false,
          deliveryAuthorized: false,
          productionRegistered: false,
        },
        null,
        2,
      ),
    );
    checks.push(
      "owner browser saves and separately approves payment policy; reviewed job binds exact approved snapshot once; draft changes do not alter approval or job; required payment remains locked",
    );
    checks.push(
      ...(await verifyPreferredWindow({
        prisma,
        reviewer,
        origin,
        evidence,
        jobId: job.id,
        asOwner: asPolicyOwner,
        failingDb,
      })),
    );
    await reviewer.locator("#load").click();
    await reviewer.waitForFunction(() =>
      document.getElementById("status").textContent.includes("Request refused"),
    );
    assert.equal(await reviewer.locator("#review").isVisible(), false);
    assert.equal(await reviewer.locator("#approve").isEnabled(), false);
    assert.equal(await prisma.job.count(), before + 1);
    checks.push(
      "closed request read refuses visibly without offering a replacement admission",
    );
    for (const page of [customer, reviewer]) {
      assert.equal(
        await page.evaluate(() => localStorage.length + sessionStorage.length),
        0,
      );
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      await page.locator(page === customer ? "#forget" : "#clear").click();
    }
    assert.equal(await reviewer.locator("#operatorToken").inputValue(), "");
    assert.equal(await reviewer.locator("#windowPreference").inputValue(), "");
    assert.equal(await reviewer.locator("#windowReview").isVisible(), false);
    assert.deepEqual(errors, []);
    checks.push(
      "separate customer/operator contexts, no browser storage, mobile fit, private clear and zero page errors",
    );
    await writeFile(
      evidence + "/browser-review-summary.json",
      JSON.stringify(
        {
          checks,
          newFictionalJobs: 1,
          status: "CREATED",
          bookingAuthorized: false,
          deliveryAuthorized: false,
          operatorCustomerCredentialAccesses: credentialAccesses,
          browserErrors: errors,
          identity:
            "explicit local fixture guard; not production authentication acceptance",
          productionRegistered: false,
        },
        null,
        2,
      ),
    );
    return checks;
  } finally {
    await customerContext?.close();
    await operatorContext?.close();
    await app.close();
  }
}
