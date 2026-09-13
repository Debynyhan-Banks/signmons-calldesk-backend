// Static export + intercepted synthetic responses only. No real tokens or APIs.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? "playwright"
);
const root = fileURLToPath(new URL("../out/", import.meta.url));
const evidence = fileURLToPath(
  new URL("../../evidence/APP-013/", import.meta.url),
);
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  const path = resolve(
    root,
    `.${pathname === "/" ? "/index.html" : extname(pathname) ? pathname : `${pathname}.html`}`,
  );
  if (!path.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
  try {
    res.writeHead(200, {
      "Content-Type": types[extname(path)] ?? "application/octet-stream",
    });
    res.end(await readFile(path));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const errors = [],
  requests = [],
  unexpected = [];
const jobId = "10000000-0000-4000-8000-000000000001";
const hold =
  "Calendar synchronization is unfinished. Appointment details and actions are on hold; please contact the office before making plans or changes.";
const legacyHold =
  "The calendar reservation needs confirmation by the office. Appointment details and actions are on hold; please contact the office before making plans or changes.";
const booking = {
  status: "appointment_details",
  state: "confirmed",
  bookingState: "PENDING_CUSTOMER_CONFIRMATION",
  reference: "FIXTURE1",
  customerName: "Synthetic Customer",
  serviceCategory: "Fixture service",
  appointment: { label: "Synthetic finalized arrival window" },
  technician: { state: "UNASSIGNED", label: "Awaiting assignment" },
  payment: {
    state: "NOT_STARTED",
    label: "Payment not requested",
    canContinue: false,
  },
  customerResponse: {
    state: "AWAITING_RESPONSE",
    label: "Waiting for confirmation",
    updatedAt: null,
    events: [],
  },
  availableActions: ["confirm", "request_reschedule"],
};
const detail = {
  jobId,
  reference: "FIXTURE1",
  calendarSyncPending: true,
  queue: "ESCALATED",
  serviceCategory: "Fixture service",
  urgency: "STANDARD",
  status: "CANCELLED",
  technicianStatus: "ASSIGNED",
  serviceWindowStart: null,
  serviceWindowEnd: null,
  timezone: "UTC",
  createdAt: "2026-09-08T14:00:00Z",
  updatedAt: "2026-09-08T14:00:00Z",
  assignedTechnician: {
    id: "tech-1",
    fullName: "Synthetic Tech",
    role: "TECH",
  },
  paymentGate: {
    state: "NOT_REQUIRED",
    required: false,
    paymentStatus: "NOT_REQUESTED",
    label: "No payment required",
  },
  recommendation: null,
  candidates: [
    {
      userId: "tech-1",
      fullName: "Synthetic Tech",
      role: "TECH",
      proficiency: "EXPERT",
      activeAssignments: 1,
      eligible: false,
      reasons: ["Calendar synchronization is unfinished; contact the office"],
    },
  ],
  routing: {
    covered: true,
    matchedRule: null,
    reasons: ["Synthetic covered area"],
    escalationPath: [],
  },
  assignmentHistory: [],
  customerBooking: {
    state: "AWAITING_RESPONSE",
    label: "No customer response",
    updatedAt: null,
    events: [],
  },
};
try {
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH ??
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  for (const [name, width] of [
    ["desktop", 1440],
    ["mobile", 390],
  ]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    page.on("pageerror", (error) => errors.push(error.message));
    let customerMode = "pending";
    let dispatchDetail = detail;
    await page.route("**/*", async (route) => {
      const req = route.request(),
        url = new URL(req.url());
      if (url.origin === origin) return route.continue();
      const path = url.pathname;
      requests.push({ path, method: req.method() });
      const reply = (body, status = 200) =>
        route.fulfill({
          status,
          contentType: "application/json",
          body: JSON.stringify(body),
        });
      if (path.endsWith("/appointments/manage")) {
        const action = req.postDataJSON().action;
        if (customerMode === "deleted")
          return reply(
            { statusCode: 400, message: "Appointment not found." },
            400,
          );
        if (customerMode === "settled-payment" && action === "view")
          return reply({
            ...booking,
            payment: {
              state: "PENDING",
              label: "Synthetic payment pending",
              canContinue: true,
            },
          });
        return customerMode === "settled" && action === "view"
          ? reply(booking)
          : reply(
              {
                statusCode: 409,
                message: customerMode === "legacy" ? legacyHold : hold,
              },
              409,
            );
      }
      if (req.method() !== "GET") {
        unexpected.push(path);
        return route.abort();
      }
      if (path.endsWith("/jobs/dispatch-board")) return reply([dispatchDetail]);
      if (path.endsWith(`/jobs/dispatch-board/${jobId}`)) return reply(dispatchDetail);
      if (path.endsWith("/payment-request"))
        return reply({ status: "NOT_REQUESTED" });
      if (path.endsWith("/payment-events")) return reply([]);
      unexpected.push(path);
      return route.abort();
    });
    const overflow = async () =>
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
      );
    await page.goto(
      `${origin}/appointment/manage#synthetic-management-token-no-real-authority`,
    );
    await page.getByRole("alert").filter({ hasText: hold }).waitFor();
    assert.ok(
      (
        await page.getByRole("alert").filter({ hasText: hold }).innerText()
      ).includes(hold),
    );
    assert.equal(
      await page
        .getByRole("button", { name: /Confirm appointment window/i })
        .count(),
      0,
    );
    await overflow();
    await page.screenshot({
      path: `${evidence}calendar-hold-customer-${name}.png`,
      fullPage: true,
    });
    // An unjournaled legacy CREATE hold uses the same fail-closed customer UI.
    customerMode = "legacy";
    await page.reload();
    await page.getByRole("alert").filter({ hasText: legacyHold }).waitFor();
    assert.equal(
      await page.getByText("Synthetic Customer", { exact: true }).count(),
      0,
    );
    assert.equal(
      await page.getByRole("button", { name: /Confirm.*window/i }).count(),
      0,
    );
    await overflow();
    await page.screenshot({
      path: `${evidence}legacy-create-hold-customer-${name}.png`,
      fullPage: true,
    });
    customerMode = "settled";
    await page.reload();
    await page
      .getByText("Synthetic finalized arrival window", { exact: true })
      .waitFor();
    customerMode = "legacy";
    await page.getByRole("button", { name: /Confirm.*window/i }).click();
    await page.getByRole("alert").filter({ hasText: legacyHold }).waitFor();
    assert.equal(
      await page
        .getByText("Synthetic finalized arrival window", { exact: true })
        .count(),
      0,
    );
    assert.equal(
      await page.getByRole("button", { name: /Confirm.*window/i }).count(),
      0,
    );
    // A formerly settled page must also discard the old card for a journal hold.
    customerMode = "settled";
    await page.reload();
    await page
      .getByText("Synthetic finalized arrival window", { exact: true })
      .waitFor();
    customerMode = "pending";
    await page.getByRole("button", { name: /Confirm.*window/i }).click();
    await page.getByRole("alert").filter({ hasText: hold }).waitFor();
    assert.equal(
      await page
        .getByText("Synthetic finalized arrival window", { exact: true })
        .count(),
      0,
    );
    assert.equal(
      await page.getByRole("button", { name: /Confirm.*window/i }).count(),
      0,
    );
    // Missing/deleted responses must hide both initially loaded and stale data.
    customerMode = "deleted";
    await page.reload();
    await page
      .getByRole("alert")
      .filter({ hasText: "Appointment not found." })
      .waitFor();
    assert.equal(
      await page
        .getByText("Synthetic finalized arrival window", { exact: true })
        .count(),
      0,
    );
    await overflow();
    await page.screenshot({
      path: `${evidence}deleted-booking-customer-${name}.png`,
      fullPage: true,
    });
    for (const action of ["confirm", "payment"]) {
      customerMode = action === "payment" ? "settled-payment" : "settled";
      await page.reload();
      await page
        .getByText("Synthetic finalized arrival window", { exact: true })
        .waitFor();
      customerMode = "deleted";
      if (action === "payment") {
        const popupPromise = page.waitForEvent("popup");
        await page
          .getByRole("button", { name: "Continue to payment", exact: true })
          .click();
        const popup = await popupPromise;
        await page
          .getByRole("alert")
          .filter({ hasText: "Appointment not found." })
          .waitFor();
        if (!popup.isClosed())
          await popup.waitForEvent("close", { timeout: 5000 });
        assert.equal(popup.isClosed(), true);
      } else {
        await page.getByRole("button", { name: /Confirm.*window/i }).click();
        await page
          .getByRole("alert")
          .filter({ hasText: "Appointment not found." })
          .waitFor();
      }
      assert.equal(
        await page
          .getByText("Synthetic finalized arrival window", { exact: true })
          .count(),
        0,
      );
      assert.equal(
        await page
          .getByRole("button", { name: /Confirm.*window|Continue to payment/i })
          .count(),
        0,
      );
      await overflow();
    }
    await page.goto(`${origin}/app/dispatch`);
    await page
      .getByLabel("Firebase operator ID token")
      .fill("synthetic-no-real-authority");
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    const assignment = page.getByRole("button", {
      name: "Calendar review required",
      exact: true,
    });
    await assignment.waitFor();
    assert.equal(await assignment.isDisabled(), true);
    assert.equal(
      await page
        .getByRole("button", { name: "Cancel assignment", exact: true })
        .isDisabled(),
      true,
    );
    assert.equal(await page.getByRole("combobox").isDisabled(), true);
    assert.ok(
      (await page.getByRole("status").innerText()).includes(
        "reservation is provisional",
      ),
    );
    assert.equal(
      await page.getByText("No eligible match", { exact: true }).count(),
      1,
    );
    await page
      .getByRole("textbox", { name: /Operator reason/ })
      .fill("An operator reason must not unlock pending Calendar work.");
    assert.equal(await assignment.isDisabled(), true);
    await overflow();
    await page.getByRole("status").scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `${evidence}calendar-hold-dispatch-${name}.png`,
      fullPage: true,
    });
    for (const assigned of [true, false]) {
      dispatchDetail = {
        ...detail, reference: assigned ? "LEGACYASSIGNED" : "LEGACYUNASSIGNED",
        status: "ACCEPTED",
        serviceWindowStart: "2026-10-10T12:00:00Z",
        serviceWindowEnd: assigned ? "2026-10-10T14:00:00Z" : null,
        assignedTechnician: assigned ? detail.assignedTechnician : null,
        technicianStatus: assigned ? "ASSIGNED" : null,
      };
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await page.getByText(`Job #${dispatchDetail.reference}`, { exact: true }).waitFor();
      assert.equal(await assignment.isDisabled(), true);
      assert.equal(await page.getByRole("combobox").isDisabled(), true);
      const cancel = page.getByRole("button", { name: "Cancel assignment", exact: true });
      if (assigned) assert.equal(await cancel.isDisabled(), true);
      else assert.equal(await cancel.count(), 0);
      assert.ok((await page.getByRole("status").innerText()).includes("reservation is provisional"));
      assert.equal(await page.getByRole("button", { name: "Escalate to operations", exact: true }).isEnabled(), true);
      await overflow();
      await page.screenshot({
        path: `${evidence}legacy-dispatch-${assigned ? "assigned" : "unassigned"}-${name}.png`,
        fullPage: true,
      });
    }
    await page.close();
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  assert.equal(
    requests.filter(
      (r) => r.method === "POST" && !r.path.endsWith("/appointments/manage"),
    ).length,
    0,
  );
  console.log(
    JSON.stringify({
      result: "PASS",
      viewports: [1440, 390],
      requests: requests.length,
      customerSyntheticPosts: requests.filter((r) => r.method === "POST")
        .length,
      dispatchMutationPosts: 0,
      pageErrors: errors,
      externalRequests: 0,
    }),
  );
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}
