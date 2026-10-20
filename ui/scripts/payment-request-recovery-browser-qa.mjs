// Local fixture only: no provider, credential, customer, or database access.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? "playwright"
);
const root = resolve(fileURLToPath(new URL("../out/", import.meta.url)));
const jobId = "20000000-0000-4000-8000-000000000002";
const tenantId = "10000000-0000-4000-8000-000000000001";
const now = "2026-10-20T10:00:00.000Z";
const expiresAt = "2026-10-20T11:00:00.000Z";
const checkoutUrl = "https://checkout.stripe.com/c/pay/local-fixture";
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".txt": "text/plain",
  ".woff2": "font/woff2",
};
const summary = {
  calendarSyncPending: false,
  jobId,
  reference: "P07TEST1",
  queue: "NEW_REQUEST",
  serviceCategory: "HVAC repair",
  urgency: "STANDARD",
  status: "CREATED",
  technicianStatus: null,
  serviceWindowStart: null,
  serviceWindowEnd: null,
  timezone: "America/New_York",
  assignedTechnician: null,
  paymentGate: {
    required: true,
    state: "LOCKED",
    paymentStatus: "NOT_REQUESTED",
    amountTotalCents: 12500,
    currency: "usd",
    reasonCode: "PAYMENT_REQUIRED",
    label: "Payment is required before dispatch",
  },
  createdAt: now,
  updatedAt: now,
};
const detail = {
  ...summary,
  recommendation: null,
  routing: {
    version: "routing-v1",
    jobId,
    timeScope: "BUSINESS_HOURS",
    postalCode: null,
    covered: true,
    matchedRule: null,
    requirements: { requireAvailable: false, requireOnCall: false },
    reasonCodes: [],
    reasons: [],
    escalationPath: [],
  },
  candidates: [],
  assignmentHistory: [],
  customerBooking: {
    state: "AWAITING_RESPONSE",
    label: "Awaiting response",
    updatedAt: null,
    events: [],
  },
};

const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  const path = resolve(
    root,
    `.${pathname === "/" ? "/index.html" : extname(pathname) ? pathname : `${pathname}.html`}`,
  );
  if (!path.startsWith(`${root}/`)) return res.writeHead(403).end();
  try {
    const body = await readFile(path);
    res
      .writeHead(200, {
        "Content-Type": types[extname(path)] ?? "application/octet-stream",
      })
      .end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const results = [];
try {
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH ??
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  for (const viewport of [
    { name: "desktop", width: 1440, height: 1000 },
    { name: "mobile", width: 390, height: 844 },
  ]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    const expectedSyntheticFailures = [];
    const requestKeys = [];
    let active = false;
    let createAttempts = 0;
    let recoverAttempts = 0;
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (
        message.type() === "error" &&
        message.text().includes("503 (Service Unavailable)")
      )
        expectedSyntheticFailures.push(message.text());
      else if (message.type() === "error") errors.push(message.text());
    });
    await page.route("http://localhost:3000/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const json = (value, status = 200) =>
        route.fulfill({
          status,
          contentType: "application/json",
          body: JSON.stringify(value),
        });
      if (request.method() === "GET" && path === "/jobs/dispatch-board")
        return json([summary]);
      if (
        request.method() === "GET" &&
        path === `/jobs/dispatch-board/${jobId}`
      )
        return json(detail);
      if (
        request.method() === "GET" &&
        path === `/jobs/${jobId}/payment-request`
      )
        return json({
          paymentRequestId: active
            ? "30000000-0000-4000-8000-000000000003"
            : null,
          status: active ? "PENDING" : "NOT_REQUESTED",
          amountTotalCents: active ? 12500 : null,
          currency: active ? "usd" : null,
          requestedAt: active ? now : null,
          checkoutExpiresAt: active ? expiresAt : null,
          requestActive: active,
        });
      if (
        request.method() === "GET" &&
        path === `/jobs/${jobId}/payment-events`
      )
        return json([]);
      if (
        request.method() === "POST" &&
        path === `/jobs/${jobId}/payment-requests`
      ) {
        createAttempts += 1;
        requestKeys.push(request.headers()["idempotency-key"]);
        if (createAttempts === 1)
          return json({ message: "Synthetic lost response" }, 503);
        active = true;
        return json({
          paymentRequestId: "30000000-0000-4000-8000-000000000003",
          status: "PENDING",
          amountTotalCents: 12500,
          currency: "usd",
          requestedAt: now,
          checkoutExpiresAt: expiresAt,
          requestActive: true,
          checkoutUrl,
        });
      }
      if (
        request.method() === "POST" &&
        path === `/jobs/${jobId}/payment-request/recover`
      ) {
        recoverAttempts += 1;
        return json({
          status: "payment_checkout",
          checkoutUrl,
          checkoutExpiresAt: expiresAt,
        });
      }
      return json({ message: `Unexpected fixture request ${request.method()} ${path}` }, 500);
    });

    await page.goto(`${origin}/app/dispatch`, { waitUntil: "networkidle" });
    const create = page.getByRole("button", { name: "Create payment request" });
    if ((await create.count()) === 0) {
      await page
        .getByLabel("Firebase operator ID token")
        .fill("synthetic-browser-fixture-token");
      await page.getByRole("button", { name: "Connect" }).click();
      await create.waitFor();
    }
    await create.click();
    await page
      .getByRole("alert")
      .filter({ hasText: "Synthetic lost response" })
      .waitFor();
    await create.click();
    await page.getByRole("link", { name: "Open test checkout" }).waitFor();
    assert.equal(createAttempts, 2);
    assert.equal(requestKeys.length, 2);
    assert.match(requestKeys[0], /^[0-9a-f-]{36}$/i);
    assert.equal(requestKeys[1], requestKeys[0]);

    active = true;
    await page.reload({ waitUntil: "networkidle" });
    const recover = page.getByRole("button", {
      name: "Recover active payment request",
    });
    if ((await recover.count()) === 0) {
      await page
        .getByLabel("Firebase operator ID token")
        .fill("synthetic-browser-fixture-token");
      await page.getByRole("button", { name: "Connect" }).click();
      await recover.waitFor();
    }
    await recover.click();
    const recovered = page.getByRole("link", { name: "Open test checkout" });
    await recovered.waitFor();
    assert.equal(await recovered.getAttribute("href"), checkoutUrl);
    assert.equal(recoverAttempts, 1);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      true,
    );
    assert.deepEqual(errors, []);
    assert.equal(expectedSyntheticFailures.length, 1);
    results.push({
      viewport: viewport.name,
      stableRetry: true,
      activeRecovery: true,
      horizontalOverflow: false,
      errors: 0,
      expectedSyntheticFailures: 1,
    });
    await page.close();
  }
  console.log(JSON.stringify({ result: "PASS", results }));
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}
