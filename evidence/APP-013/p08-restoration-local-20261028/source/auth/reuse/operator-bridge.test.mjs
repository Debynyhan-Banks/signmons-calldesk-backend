import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  createOperatorBridge,
  createUpstream,
  qualifiedPaymentContext,
  qualifyActor,
  normalizeDatabase,
  plan,
} from "./operator-bridge.mjs";
const actor = "10000000-0000-4000-8000-000000000001";
const q = () => ({
  status: "QUALIFIED_DATABASE",
  tenantId: plan.tenantId,
  jobId: plan.jobId,
  actorId: actor,
  actorRole: "owner",
  approvedAt: "2026-10-19T10:00:00.000Z",
  jobUpdatedAt: "2026-10-19T11:00:00.000Z",
  amountTotalCents: 12500,
  currency: "usd",
  policyDigest: "a".repeat(64),
  connectedAccountSha256: plan.connectedAccountSha256,
});
function raw() {
  const d = {
    currency: "usd",
    serviceFeeRequired: false,
    serviceFeeCents: null,
    depositRequired: true,
    depositPolicy: { kind: "fixed", amountCents: 12500 },
    emergencyFeePolicy: { kind: "none" },
    paymentGateMode: "fail_closed",
    webhookValidationRequired: true,
  };
  const approved = { draft: d, actorId: actor, approvedAt: q().approvedAt };
  const digest = createHash("sha256")
    .update(JSON.stringify(approved))
    .digest("hex");
  const account = "acct_localP08only";
  return {
    expected: {
      ...plan,
      connectedAccountSha256: createHash("sha256")
        .update(account)
        .digest("hex"),
    },
    value: {
      database: "neondb",
      user: "neondb_owner",
      roleCount: 1,
      roleClosed: true,
      roleMemberships: 0,
      roleSessions: 0,
      jobCount: 1,
      job: {
        id: plan.jobId,
        tenantId: plan.tenantId,
        status: "CREATED",
        deletedAt: null,
        updatedAt: q().jobUpdatedAt,
        calendarEventId: null,
        serviceWindowStart: null,
        serviceWindowEnd: null,
        policySnapshot: {
          intakeAdmission: {
            version: 2,
            actorId: "signmons-intake-admission-v1",
            paymentApprovedAt: approved.approvedAt,
            paymentDigest: digest,
            humanReviewed: false,
          },
        },
        pricingSnapshot: {},
      },
      tenantCount: 1,
      tenant: {
        id: plan.tenantId,
        status: "ACTIVE",
        chargesEnabled: true,
        stripeConnectAccountId: account,
        settings: {
          organizationPaymentPolicyV1: { version: 1, draft: d, approved },
        },
      },
      paymentCount: 0,
      calendarCount: 0,
      actorCount: 1,
      actors: [
        { id: actor, tenantId: plan.tenantId, role: "OWNER", status: "ACTIVE" },
      ],
    },
  };
}
const response = (v) =>
  new Response(JSON.stringify(v), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
function fixture() {
  const state = {
    bound: false,
    status: "NOT_REQUESTED",
    calls: [],
    delay: null,
  };
  const transport = async (url, options) => {
    assert.equal(new URL(url).origin, plan.origin);
    assert.equal(options.headers.Authorization, "Bearer local-synthetic-token");
    state.calls.push({
      path: new URL(url).pathname,
      method: options.method,
      key: options.headers["Idempotency-Key"],
    });
    const path = new URL(url).pathname;
    if (path === "/job-payment-policy/apply") {
      if (state.delay) await state.delay;
      state.bound = true;
      return response({
        jobId: plan.jobId,
        updatedAt: "2026-10-19T11:00:01.000Z",
        policyBound: true,
        bookingAuthorized: false,
        deliveryAuthorized: false,
        paymentInitiated: false,
      });
    }
    if (path.endsWith("/payment-requests")) {
      state.status = "PENDING";
      return response({
        paymentRequestId: randomUUID(),
        status: "PENDING",
        amountTotalCents: 12500,
        currency: "usd",
        checkoutUrl: "https://checkout.stripe.com/c/pay/localP08only",
      });
    }
    if (path.endsWith("/recover"))
      return response({
        status: "payment_checkout",
        checkoutUrl: "https://checkout.stripe.com/c/pay/localP08only",
        checkoutExpiresAt: "2099-01-01T00:00:00Z",
      });
    if (path.endsWith("/payment-events"))
      return response(
        state.status === "SUCCEEDED"
          ? [
              {
                id: randomUUID(),
                type: "checkout.session.completed",
                processingStatus: "PROCESSED",
              },
            ]
          : [],
      );
    if (path.includes("/dispatch-board/"))
      return response({
        jobId: plan.jobId,
        paymentGate: {
          state: state.bound
            ? state.status === "SUCCEEDED"
              ? "UNLOCKED"
              : "LOCKED"
            : "NOT_REQUIRED",
        },
      });
    return response({
      paymentRequestId: state.status === "NOT_REQUESTED" ? null : randomUUID(),
      status: state.status,
      amountTotalCents: state.status === "NOT_REQUESTED" ? null : 12500,
      currency: state.status === "NOT_REQUESTED" ? null : "usd",
    });
  };
  return { state, transport };
}
async function open(options = {}) {
  const f = fixture(),
    bridge = await createOperatorBridge({
      qualification: q(),
      token: "local-synthetic-token",
      transport: f.transport,
      deadline: Date.now() + 30000,
      ...options,
    });
  const start = await fetch(bridge.bootstrapUrl, { redirect: "manual" });
  assert.equal(start.status, 303);
  const cookie = start.headers.get("set-cookie").split(";")[0];
  const page = await fetch(bridge.origin + "/", { headers: { cookie } });
  const html = await page.text();
  const csrf = JSON.parse(html.match(/const csrf=("[^"]+")/)[1]);
  const action = async (a, ack = true, changes = {}) => {
    const r = await fetch(bridge.origin + "/action", {
      method: "POST",
      headers: {
        cookie,
        Origin: bridge.origin,
        "Content-Type": "application/json",
        "X-P08-CSRF": csrf,
        ...changes.headers,
      },
      body: JSON.stringify({ action: a, acknowledged: ack, ...changes.body }),
    });
    return { status: r.status, value: await r.json() };
  };
  return { ...f, bridge, cookie, csrf, html, action };
}
test("actual policy normalizer derives canonical digest and fixed amount without identity/account leakage", () => {
  const f = raw(),
    v = normalizeDatabase(f.value, f.expected);
  assert.equal(v.amountTotalCents, 12500);
  assert.equal(v.actorId, actor);
  assert.equal(v.currency, "usd");
  assert.equal(v.businessMutation, false);
  assert.doesNotMatch(JSON.stringify(v), /acct_local|owner@/);
});
test("total absent/null/foreign rows and existing activity refuse", () => {
  for (const mutate of [
    (v) => (v.jobCount = 0),
    (v) => (v.job = null),
    (v) => (v.tenantCount = 0),
    (v) => (v.tenant = null),
    (v) => (v.actorCount = 0),
    (v) => (v.actorCount = 2),
    (v) => (v.roleClosed = false),
    (v) => (v.roleSessions = 1),
    (v) => (v.roleMemberships = 1),
    (v) => (v.paymentCount = 1),
    (v) => (v.calendarCount = 1),
    (v) => (v.job.deletedAt = new Date().toISOString()),
    (v) => (v.job.tenantId = randomUUID()),
    (v) => (v.tenant.chargesEnabled = false),
    (v) => (v.tenant.stripeConnectAccountId = null),
    (v) => (v.job.policySnapshot = null),
    (v) => (v.job.pricingSnapshot = { currency: "usd" }),
    (v) =>
      (v.job.policySnapshot.intakeAdmission.paymentDigest = "b".repeat(64)),
    (v) => (v.actors[0].status = "DISABLED"),
    (v) => (v.actors[0].tenantId = randomUUID()),
  ]) {
    const f = raw();
    mutate(f.value);
    assert.throws(() => normalizeDatabase(f.value, f.expected));
  }
});
test("UUID and actual same-tenant active application actor required before any transport", () => {
  const user = {
      id: actor,
      tenantId: plan.tenantId,
      status: "ACTIVE",
      role: "OWNER",
    },
    claims = { sub: actor, tenantId: plan.tenantId, role: "owner" };
  assert.equal(qualifyActor(claims, user), actor);
  for (const c of [
    { ...claims, sub: "old-phone-text-id" },
    { ...claims, tenantId: randomUUID() },
    { ...claims, role: "dispatcher" },
    { ...claims, impersonatedTenantId: randomUUID() },
  ])
    assert.throws(() => qualifyActor(c, user));
  for (const u of [
    null,
    { ...user, id: randomUUID() },
    { ...user, tenantId: randomUUID() },
    { ...user, status: "DISABLED" },
    { ...user, role: "TECH" },
  ])
    assert.throws(() => qualifyActor(claims, u));
});
test("unqualified/stale money or identity cannot construct upstream", () => {
  for (const v of [
    { ...q(), actorId: "text" },
    { ...q(), currency: "eur" },
    { ...q(), amountTotalCents: 0 },
    { ...q(), jobId: randomUUID() },
    { ...q(), connectedAccountSha256: "b".repeat(64) },
    { ...q(), approvedAt: "not-time" },
  ])
    assert.throws(() => qualifiedPaymentContext(v));
});
test("exact method/job route allowlist and deadline refuse before transport", async () => {
  let calls = 0;
  const u = createUpstream(
    async () => {
      calls++;
      return response({});
    },
    "synthetic",
    q(),
    Date.now() + 1000,
  );
  for (const [m, p] of [
    ["GET", "/jobs/dispatch-board"],
    ["POST", "/jobs/" + randomUUID() + "/payment-requests"],
    ["POST", "/jobs/" + plan.jobId + "/payment-exception"],
    ["GET", "https://evil.invalid"],
  ])
    await assert.rejects(u.request(m, p, {}));
  assert.equal(calls, 0);
  const dead = createUpstream(
    async () => {
      calls++;
    },
    "synthetic",
    q(),
    Date.now() - 1,
  );
  await assert.rejects(
    dead.request("GET", "/jobs/" + plan.jobId + "/payment-request"),
  );
  assert.equal(calls, 0);
});
test("bootstrap one-use; bearer stays server-side; cookie private and no persistence", async () => {
  const f = await open();
  try {
    assert.doesNotMatch(
      f.html,
      /local-synthetic-token|sessionStorage|localStorage|indexedDB/,
    );
    assert.equal(
      (await fetch(f.bridge.bootstrapUrl, { redirect: "manual" })).status,
      403,
    );
    assert.equal((await fetch(f.bridge.origin + "/")).status, 403);
    const page = await fetch(f.bridge.origin + "/", {
      headers: { cookie: f.cookie },
    });
    assert.match(page.headers.get("cache-control"), /no-store/);
    assert.match(
      page.headers.get("content-security-policy"),
      /default-src 'none'/,
    );
  } finally {
    await f.bridge.stop();
  }
});
test("Origin/CSRF/body/unknown action and unacknowledged policy cannot mutate", async () => {
  const f = await open();
  try {
    for (const changes of [
      { headers: { Origin: "https://evil.invalid" } },
      { headers: { "X-P08-CSRF": "bad" } },
      { body: { jobId: randomUUID() } },
      { body: { action: "assign" } },
    ])
      assert.equal((await f.action("bind", true, changes)).status >= 400, true);
    assert.equal((await f.action("bind", false)).status, 409);
    assert.equal((await f.action("create")).status, 409);
    assert.equal(f.state.calls.length, 0);
  } finally {
    await f.bridge.stop();
  }
});
test("real HTTP loopback create, controlled lost response, one active recovery, failed/success state and clear", async () => {
  const f = await open({ dropCreateResponse: true });
  try {
    assert.match((await f.action("read")).value.message, /unverified/);
    assert.equal((await f.action("bind")).status, 200);
    assert.match((await f.action("read")).value.message, /gate remains locked/);
    assert.equal((await f.action("create")).status, 503);
    assert.equal((await f.action("create")).status, 409);
    assert.equal((await f.action("recover")).status, 200);
    assert.equal((await f.action("recover")).status, 409);
    f.state.status = "FAILED";
    assert.match((await f.action("read")).value.message, /not succeeded/);
    f.state.status = "SUCCEEDED";
    const settled = await f.action("read");
    assert.match(settled.value.message, /Verified payment succeeded/);
    assert.equal(settled.value.paymentGate, "UNLOCKED");
    assert.equal(
      f.state.calls.filter((x) => x.path.endsWith("/payment-requests")).length,
      1,
    );
    assert.equal(
      f.state.calls.filter((x) => x.path.endsWith("/recover")).length,
      1,
    );
    assert.equal((await f.action("clear")).status, 200);
    assert.equal((await f.action("read")).status, 403);
    assert.equal(f.bridge.state().closed, true);
  } finally {
    await f.bridge.stop();
  }
});
test("concurrent click has one winner and cannot invoke second policy operation", async () => {
  const f = await open();
  let release;
  f.state.delay = new Promise((r) => (release = r));
  try {
    const first = f.action("bind");
    while (!f.state.calls.length) await new Promise((r) => setTimeout(r, 1));
    assert.equal((await f.action("bind")).status, 409);
    release();
    assert.equal((await first).status, 200);
    assert.equal(f.state.calls.length, 1);
  } finally {
    release?.();
    await f.bridge.stop();
  }
});
test("foreign tracking, money and unexpected gate cannot assert a successful outcome", async () => {
  for (const bad of ["job", "money", "gate"]) {
    const base = fixture();
    const transport = async (url, opt) => {
      let r = await base.transport(url, opt);
      if (url.includes("/dispatch-board/")) {
        let v = await r.json();
        if (bad === "job") v.jobId = randomUUID();
        if (bad === "gate") v.paymentGate.state = "UNLOCKED";
        r = response(v);
      } else if (bad === "money" && url.endsWith("/payment-request")) {
        let v = await r.json();
        v.amountTotalCents = 1;
        r = response(v);
      }
      return r;
    };
    const f = await open({ transport });
    try {
      await f.action("bind");
      assert.equal((await f.action("read")).status >= 400, true);
    } finally {
      await f.bridge.stop();
    }
  }
});
test("return query alone has no settlement path", async () => {
  const f = await open();
  try {
    assert.equal(
      (
        await fetch(f.bridge.origin + "/?payment=success", {
          headers: { cookie: f.cookie },
        })
      ).status,
      403,
    );
    assert.equal(f.state.status, "NOT_REQUESTED");
  } finally {
    await f.bridge.stop();
  }
});
test("private clear failure cannot claim cleanup succeeded", async () => {
  const f = await open({
    onClose: async () => {
      throw Error("synthetic private failure");
    },
  });
  try {
    assert.equal((await f.action("clear")).status, 503);
    assert.equal(f.bridge.state().cleanupFailure, true);
    assert.equal((await f.action("read")).status, 403);
  } finally {
    await f.bridge.stop();
  }
});
test("deadline closes private session without additional action", async () => {
  let closed = false;
  const f = await open({
    deadline: Date.now() + 250,
    onClose: async () => {
      closed = true;
    },
  });
  try {
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(closed, true);
    assert.equal(f.bridge.state().closed, true);
  } finally {
    await f.bridge.stop();
  }
});
// A caller may provide the already-installed Playwright module. No package download.
test("isolated desktop/mobile browser controls preserve one request and clear private session", async () => {
  const module = process.env.PLAYWRIGHT_MODULE;
  assert.ok(
    module,
    "PLAYWRIGHT_MODULE must identify an existing installed module",
  );
  const { chromium } = await import(module);
  const browser = await chromium.launch({
    headless: true,
    executablePath:
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  try {
    for (const viewport of [
      { width: 1440, height: 1000 },
      { width: 390, height: 844 },
    ]) {
      const f = fixture(),
        bridge = await createOperatorBridge({
          qualification: q(),
          token: "local-synthetic-token",
          transport: f.transport,
          deadline: Date.now() + 30000,
          dropCreateResponse: true,
        });
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      let external = 0;
      const errors = [];
      await page.route("**/*", (route) => {
        if (new URL(route.request().url()).origin !== bridge.origin) {
          external++;
          return route.abort();
        }
        return route.continue();
      });
      page.on("pageerror", (e) => errors.push(e.message));
      try {
        await page.goto(bridge.bootstrapUrl);
        await page
          .getByRole("button", { name: "Read verified status", exact: true })
          .click();
        await page
          .getByRole("status")
          .filter({ hasText: "unverified" })
          .waitFor();
        await page.getByRole("checkbox").check();
        await page
          .getByRole("button", {
            name: "Apply saved payment policy",
            exact: true,
          })
          .click();
        await page
          .getByRole("status")
          .filter({ hasText: "policy applied" })
          .waitFor();
        await page
          .getByRole("button", {
            name: "Create secure payment request",
            exact: true,
          })
          .click();
        await page
          .getByRole("status")
          .filter({ hasText: "outcome uncertain" })
          .waitFor();
        await page
          .getByRole("button", {
            name: "Recover active payment request",
            exact: true,
          })
          .click();
        await page
          .getByRole("status")
          .filter({ hasText: "Recovered" })
          .waitFor();
        f.state.status = "FAILED";
        await page
          .getByRole("button", { name: "Read verified status", exact: true })
          .click();
        await page
          .getByRole("status")
          .filter({ hasText: "not succeeded" })
          .waitFor();
        f.state.status = "SUCCEEDED";
        await page
          .getByRole("button", { name: "Read verified status", exact: true })
          .click();
        await page
          .getByRole("status")
          .filter({ hasText: "Verified payment succeeded" })
          .waitFor();
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          true,
        );
        assert.deepEqual(
          await page.evaluate(() => ({
            local: localStorage.length,
            session: sessionStorage.length,
          })),
          { local: 0, session: 0 },
        );
        await page.screenshot({
          path: rootPath("browser-" + viewport.width + ".png"),
        });
        await page
          .getByRole("button", { name: "Clear private session", exact: true })
          .click();
        await page
          .getByRole("status")
          .filter({ hasText: "Private session cleared" })
          .waitFor();
        assert.equal((await context.cookies()).length, 0);
        assert.equal(
          f.state.calls.filter((x) => x.path.endsWith("/payment-requests"))
            .length,
          1,
        );
        assert.equal(external, 0);
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
        await bridge.stop();
      }
    }
  } finally {
    await browser.close();
  }
});
function rootPath(name) {
  return new URL(name, import.meta.url).pathname;
}
