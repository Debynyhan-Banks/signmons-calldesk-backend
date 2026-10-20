// UI state tests of the existing journey page. Mock HTTP responses, no provider or database.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { readFile, mkdir, writeFile } from "node:fs/promises";
const serveLocal = process.argv.slice(2).join(" ") === "--serve-local";
assert.ok(
  process.argv.length === 2 || serveLocal,
  "Only --serve-local is accepted",
);
const sourceHtml = await readFile(
  new URL("./fixtures/customer-intake-journey.html", import.meta.url),
  "utf8",
);
const html = sourceHtml.replace(
  '<html lang="en">',
  '<html lang="en" data-controlled-intake="true">',
);
const script = await readFile(
  new URL("./fixtures/customer-intake-journey.js", import.meta.url),
);
function mockResponse(op, body, mode, submissionCount) {
  const denied = {
    paymentAuthorized: false,
    bookingAuthorized: false,
    dispatchAuthorized: false,
    deliveryAuthorized: false,
  };
  let value;
  if (op === "start")
    value = {
      sessionToken: "synthetic-ui-session",
      sessionCloseAvailable: true,
      verificationNotice: {
        noticeVersion: "synthetic-controlled-v1",
        noticeText: "Synthetic code request.",
      },
      expiresAt: new Date(
        Date.now() + (mode === "EXPIRING_SESSION" ? 60000 : 600000),
      ).toISOString(),
      deliveryAuthorized: false,
    };
  else if (op === "continue")
    value = {
      reply: "Please review your details.",
      revision: 1,
      deliveryAuthorized: false,
    };
  else if (op === "end")
    value = {
      state: "CLOSED",
      fixtureOnly: false,
      cleanupPending: false,
      deliveryAuthorized: false,
    };
  else if (op === "verify")
    value = {
      operationId: body.operationId,
      state: "OBSERVED",
      outcome:
        body.action === "START" || body.code === "123455"
          ? "PENDING"
          : [
                "PHONE_REFUSED",
                "PHONE_UNKNOWN",
                "PHONE_EXPIRED",
                "PHONE_UNAVAILABLE",
              ].includes(mode)
            ? mode.slice(6)
            : "APPROVED",
      phoneAccessAuthorized: false,
      bookingAuthorized: false,
      deliveryAuthorized: false,
    };
  else if (op === "draft") {
    if (mode === "DRAFT_UNCERTAIN") return undefined;
    value = {
      draft: body.draft,
      transcriptRevision: 1,
      emailChoice: "NOT_RECORDED",
      requiresHumanReview: true,
      urgencyAssessment: "NOT_PERFORMED",
      jobCreated: false,
      bookingAuthorized: false,
      deliveryAuthorized: false,
    };
  } else if (op === "submit") {
    if (
      ["LOST_ACK", "LOST_ACK_SETUP_FAILURE"].includes(mode) &&
      submissionCount === 1
    )
      return undefined;
    const diagnosticReasons = [
      "ADDRESS_REVIEW_UNAVAILABLE",
      "SERVICE_AREA_NOT_CONFIRMED",
      "OUTSIDE_SERVICE_AREA",
      "ADDRESS_CORRECTION_STATE_UNAVAILABLE",
    ];
    const state =
      [
        "LOST_ACK",
        "LOST_ACK_SETUP_FAILURE",
        "DELAYED_PREVIEW",
        "EDIT_REVIEW",
        "NATIVE_DUPLICATE",
      ].includes(mode) ||
      (["CORRECTION_REQUIRED", "CORRECTION_MANUAL"].includes(mode) &&
        submissionCount > 1)
        ? "ADMITTED"
        : ["CORRECTION_REQUIRED", "CORRECTION_MANUAL", "CORRECTION_UNSELECTABLE"].includes(mode)
          ? "CORRECTION_REQUIRED"
          : diagnosticReasons.includes(mode)
            ? "REFUSED"
            : mode;
    value = {
      status: state,
      requestId: body.requestId,
      jobCreated: state === "ADMITTED",
      ...denied,
      ...(state === "ADMITTED"
        ? {
            jobId: "11111111-1111-4111-8111-111111111111",
            state: "CREATED",
          }
        : {}),
      ...(state === "CORRECTION_REQUIRED"
        ? {
            correctionContinuation: "v1." + "a".repeat(80),
            candidate: {
              addressLines:
                mode === "CORRECTION_UNSELECTABLE"
                  ? ["X".repeat(151)]
                  : ["124 Fictional Lane", "Apt 2"],
              city: "Example",
              postalCode: "44101-1234",
              country: "US",
              state: "OH",
            },
          }
        : {}),
      ...(diagnosticReasons.includes(mode) ? { reason: mode } : {}),
    };
  } else throw Error("Unexpected UI operation " + op);
  return value;
}
const out = process.env.CONTROLLED_UI_EVIDENCE_DIR;
assert.ok(
  out && isAbsolute(out),
  "explicit absolute evidence directory required",
);
await mkdir(out, { recursive: true, mode: 0o700 });
const nativeMode = process.env.CONTROLLED_UI_MODE || "ADMITTED";
assert.ok(
  [
    "ADMITTED",
    "CORRECTION_REQUIRED",
    "CORRECTION_MANUAL",
    "REFUSED",
    "ADDRESS_REVIEW_UNAVAILABLE",
    "SERVICE_AREA_NOT_CONFIRMED",
    "OUTSIDE_SERVICE_AREA",
    "ADDRESS_CORRECTION_STATE_UNAVAILABLE",
    "UNCERTAIN",
    "LOST_ACK",
  ].includes(nativeMode),
);
const delayDraftMs = Number(process.env.CONTROLLED_UI_DELAY_DRAFT_MS || 0);
assert.ok(
  Number.isSafeInteger(delayDraftMs) &&
    delayDraftMs >= 0 &&
    delayDraftMs <= 3000,
);
const nativeState = {
  fixtureOnly: true,
  status: "STARTING",
  counters: {},
  submissionCount: 0,
  lastOutcome: null,
  errorClasses: [],
  realProviderCalls: 0,
  actualJobWrites: 0,
};
let url,
  evidenceWrite = Promise.resolve();
const saveNative = () => {
  const snapshot = JSON.stringify(nativeState, null, 2) + "\n";
  evidenceWrite = evidenceWrite.then(() =>
    writeFile(`${out}/serve-summary.json`, snapshot, { mode: 0o600 }),
  );
  return evidenceWrite;
};
const syntheticOnly = (op, body) => {
  assert.ok(body && typeof body === "object" && !Array.isArray(body));
  if (op !== "start") assert.equal(body.sessionToken, "synthetic-ui-session");
  if (op === "continue") assert.equal(body.message, "Cooling issue");
  if (op === "verify") {
    assert.equal(body.phone, "+12025550123");
    assert.ok(["START", "CHECK"].includes(body.action));
    assert.ok(["", "123455", "123456"].includes(body.code));
  }
  if (["draft", "submit"].includes(op)) {
    assert.equal(body.draft.customerName, "Fictional");
    assert.equal(body.draft.phone, "+12025550123");
    assert.equal(body.draft.description, "Cooling issue");
    assert.ok(
      [
        "123 Fictional Lane, Example, OH 44101",
        "124 Fictional Lane, Apt 2, Example, OH 44101-1234",
      ].includes(body.draft.address),
    );
    assert.equal(body.draft.issueCategory, "COOLING");
    assert.equal(body.draft.propertyType, "RESIDENTIAL");
    assert.equal(body.draft.serviceIntent, "REPAIR");
  }
};
const server = createServer(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  try {
    assert.equal(req.socket.remoteAddress, "127.0.0.1");
    assert.equal(req.headers.host, new URL(url).host);
    if (
      req.method === "GET" &&
      ["/", "/customer-intake", "/journey.js"].includes(req.url)
    ) {
      res.setHeader(
        "Content-Type",
        req.url === "/journey.js" ? "application/javascript" : "text/html",
      );
      res.end(req.url === "/journey.js" ? script : html);
      return;
    }
    if (req.method === "GET" && req.url === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }
    const match =
      /^\/customer-session\/(start|continue|verify|draft|submit|end)$/.exec(
        req.url,
      );
    if (!serveLocal || req.method !== "POST" || !match) {
      res.writeHead(404);
      res.end();
      return;
    }
    assert.equal(req.headers.origin, url);
    assert.equal(req.headers["x-calldesk-request"], "customer-intake-v1");
    assert.ok(req.headers["content-type"]?.startsWith("application/json"));
    let content = "";
    for await (const chunk of req) {
      content += chunk;
      assert.ok(Buffer.byteLength(content) <= 16384);
    }
    const body = JSON.parse(content),
      op = match[1];
    syntheticOnly(op, body);
    nativeState.counters[op] = (nativeState.counters[op] || 0) + 1;
    if (op === "submit") nativeState.submissionCount++;
    const value = mockResponse(
      op,
      body,
      nativeMode,
      nativeState.submissionCount,
    );
    nativeState.lastOutcome = value?.status || value?.state || op.toUpperCase();
    await saveNative();
    if (op === "draft" && delayDraftMs)
      await new Promise((resolve) => setTimeout(resolve, delayDraftMs));
    if (value === undefined) {
      res.destroy();
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(value));
  } catch {
    if (serveLocal) {
      nativeState.errorClasses.push("FIXTURE_REQUEST_REJECTED");
      await saveNative();
    }
    if (!res.headersSent) res.writeHead(400);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
url = `http://127.0.0.1:${server.address().port}`;
let browser;
if (serveLocal) {
  let timer;
  const stop = new Promise((resolve) => {
    timer = setTimeout(resolve, 600000);
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
    process.once("SIGHUP", resolve);
  });
  try {
    nativeState.status = "SERVING";
    await saveNative();
    const ready = {
      status: "LOCAL_SYNTHETIC_UI_READY",
      url,
      mode: nativeMode,
      lifetimeSeconds: 600,
      htmlSha256: createHash("sha256").update(html).digest("hex"),
      sourceHtmlSha256: createHash("sha256").update(sourceHtml).digest("hex"),
      scriptSha256: createHash("sha256").update(script).digest("hex"),
      fixtureOnly: true,
      realProviderCalls: 0,
      actualJobWrites: 0,
    };
    await writeFile(
      `${out}/serve-ready.json`,
      JSON.stringify(ready, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    console.log(JSON.stringify(ready));
    await stop;
  } finally {
    clearTimeout(timer);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    nativeState.status = "CLOSED";
    await saveNative();
  }
} else {
  const checks = [];
  try {
    const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
    browser = await chromium.launch({ headless: true });
    for (const width of [390, 1440]) {
      for (const mode of [
        "ADMITTED",
        "CORRECTION_REQUIRED",
        "CORRECTION_MANUAL",
        "CORRECTION_UNSELECTABLE",
        "REFUSED",
        "ADDRESS_REVIEW_UNAVAILABLE",
        "SERVICE_AREA_NOT_CONFIRMED",
        "OUTSIDE_SERVICE_AREA",
        "ADDRESS_CORRECTION_STATE_UNAVAILABLE",
        "UNCERTAIN",
        "LOST_ACK",
        "MALFORMED",
        "PHONE_REFUSED",
        "PHONE_UNKNOWN",
        "PHONE_EXPIRED",
        "PHONE_UNAVAILABLE",
        "PHONE_CHANGE",
        "PHONE_END",
        "DELAYED_PREVIEW",
        "EDIT_REVIEW",
        "NATIVE_DUPLICATE",
        "REQUEST_ID_FAILURE",
        "MISSING_REVIEWED_ADDRESS",
        "LOST_ACK_SETUP_FAILURE",
        "DRAFT_UNCERTAIN",
        "EXPIRING_SESSION",
      ]) {
        console.log(JSON.stringify({ fixtureCase: { width, mode } }));
        const context = await browser.newContext({
          viewport: { width, height: 1000 },
        });
        const page = await context.newPage();
        const errors = [],
          submissions = [],
          requests = [];
        let draftRequested, releaseDraft;
        const draftObserved = new Promise((resolve) => {
          draftRequested = resolve;
        });
        page.on("pageerror", (e) => errors.push(e.name));
        await page.route("**/customer-session/**", async (route) => {
          const op = new URL(route.request().url()).pathname.split("/").pop();
          const body = route.request().postDataJSON();
          requests.push({ op, body });
          if (op === "submit") submissions.push(body);
          const value = mockResponse(op, body, mode, submissions.length);
          if (value === undefined) return route.abort();
          if (op === "draft" && mode === "DELAYED_PREVIEW") {
            const released = new Promise((resolve) => {
              releaseDraft = resolve;
            });
            draftRequested();
            await released;
          }
          if (op === "submit" && mode === "NATIVE_DUPLICATE")
            await new Promise((resolve) => setTimeout(resolve, 150));
          await route.fulfill({
            contentType: "application/json",
            body: JSON.stringify(value),
          });
        });
        await page.goto(url);
        await page.locator("#start").click();
        await page.locator("#message").fill("Cooling issue");
        await page.locator("#continue").click();
        await page.locator("#skip").click();
        for (const [id, value] of Object.entries({
          customerName: "Fictional",
          phone: "+12025550123",
          controlledStreet: "123 Fictional Lane",
          controlledUnit: "",
          controlledCity: "Example",
          controlledPostal: "44101",
        }))
          await page.locator("#" + id).fill(value);
        for (const [id, value] of Object.entries({
          issueCategory: "COOLING",
          propertyType: "RESIDENTIAL",
          serviceIntent: "REPAIR",
        }))
          await page.locator("#" + id).selectOption(value);
        await page.locator("#reviewed").check();
        assert.match(
          await page.locator("#previewReadiness").innerText(),
          /complete the phone code check.*Private session expires at/i,
        );
        const assertBlocked = async () => {
          assert.equal(await page.locator("#draft").isDisabled(), true);
          const before = requests.filter((x) =>
            ["draft", "submit"].includes(x.op),
          ).length;
          await page.evaluate(() => {
            document.getElementById("draft").onclick();
            document.getElementById("submitReview").onclick();
          });
          assert.equal(
            requests.filter((x) => ["draft", "submit"].includes(x.op)).length,
            before,
          );
        };
        await assertBlocked();
        assert.equal(
          await page.locator("#controlledPhoneRequired").isVisible(),
          true,
        );
        await page.locator("#verifyNotice").click();
        await page.locator("#verifyRequested").check();
        await page.locator("#verifyStart").click();
        await page.waitForFunction(() =>
          document
            .getElementById("verifyStatus")
            .textContent.includes("Code check pending"),
        );
        await assertBlocked();
        await page.locator("#verifyCode").fill("123455");
        await page.locator("#verifyCheck").click();
        await page.waitForFunction(
          () =>
            document.getElementById("verifyCode").value === "" &&
            !document.getElementById("verifyCheck").disabled,
        );
        await assertBlocked();
        await page.locator("#verifyCode").fill("123456");
        await page.locator("#verifyCheck").click();
        if (
          [
            "PHONE_REFUSED",
            "PHONE_UNKNOWN",
            "PHONE_EXPIRED",
            "PHONE_UNAVAILABLE",
          ].includes(mode)
        ) {
          await page.waitForFunction(() =>
            /unavailable|unconfirmed/.test(
              document.getElementById("verifyStatus").textContent,
            ),
          );
          await assertBlocked();
          assert.equal(submissions.length, 0);
          assert.deepEqual(errors, []);
          checks.push({ width, mode, submitted: 0 });
          await context.close();
          continue;
        }
        await page.waitForFunction(() =>
          document
            .getElementById("verifyStatus")
            .textContent.includes("Code accepted"),
        );
        await page.locator("#reviewed").uncheck();
        assert.match(
          await page.locator("#previewReadiness").innerText(),
          /select I reviewed these details.*Private session expires at/i,
        );
        await page.locator("#reviewed").check();
        assert.match(
          await page.locator("#previewReadiness").innerText(),
          /Ready to preview: phone accepted and details reviewed.*Private session expires at/i,
        );
        assert.equal(await page.locator("#draft").isDisabled(), false);
        if (mode === "EXPIRING_SESSION") {
          assert.match(
            await page.locator("#previewReadiness").innerText(),
            /Less than 90 seconds remain/,
          );
          await page.evaluate(() => {
            const realNow = Date.now;
            Date.now = () => realNow() + 120000;
            document
              .getElementById("reviewed")
              .dispatchEvent(new Event("change"));
          });
          assert.match(
            await page.locator("#previewReadiness").innerText(),
            /private session expired/i,
          );
          await assertBlocked();
          assert.equal(submissions.length, 0);
          assert.deepEqual(errors, []);
          checks.push({ width, mode, submitted: 0 });
          await context.close();
          continue;
        }
        assert.equal(
          await page.locator("#controlledPhoneRequired").isHidden(),
          true,
        );
        if (mode === "MISSING_REVIEWED_ADDRESS") {
          // Synthetic inconsistency only: generic preview omits controlled address state.
          // No runtime debug hook and no claim that this caused the historical failure.
          await page.evaluate(() => {
            document.documentElement.dataset.controlledIntake = "false";
            document.getElementById("address").value =
              "123 Fictional Lane, Example, OH 44101";
          });
        }
        await page.locator("#draft").click();
        if (mode === "DRAFT_UNCERTAIN") {
          await page.waitForFunction(() =>
            document
              .getElementById("previewReadiness")
              .textContent.includes("previous operation outcome is pending"),
          );
          await assertBlocked();
          assert.equal(submissions.length, 0);
          assert.deepEqual(errors, []);
          checks.push({ width, mode, submitted: 0 });
          await context.close();
          continue;
        }
        if (mode === "DELAYED_PREVIEW") {
          await draftObserved;
          assert.equal(await page.locator("#draft").isDisabled(), true);
          assert.match(
            await page.locator("#previewReadiness").innerText(),
            /last request is still processing/,
          );
          await page.evaluate(() => {
            document.getElementById("draft").click();
            document.getElementById("submitReview").click();
          });
          assert.equal(submissions.length, 0);
          assert.equal(
            requests.filter((request) => request.op === "draft").length,
            1,
          );
          releaseDraft();
        }
        await page.locator("#preview").waitFor({ state: "visible" });
        if (mode === "MISSING_REVIEWED_ADDRESS") {
          await page.evaluate(() => {
            document.documentElement.dataset.controlledIntake = "true";
            document
              .getElementById("reviewed")
              .dispatchEvent(new Event("change"));
          });
        }
        if (mode === "EDIT_REVIEW") {
          await page.locator("#editDraft").click();
          await page.locator("#description").fill("Reviewed cooling issue");
          assert.equal(await page.locator("#reviewed").isChecked(), false);
          assert.equal(submissions.length, 0);
          await page.locator("#reviewed").check();
          await page.locator("#draft").click();
          await page.locator("#preview").waitFor({ state: "visible" });
          assert.match(
            await page.locator("#summary").innerText(),
            /Reviewed cooling issue/,
          );
          assert.equal(
            requests.filter((request) => request.op === "draft").length,
            2,
          );
        }
        if (mode === "PHONE_CHANGE" || mode === "PHONE_END") {
          if (mode === "PHONE_CHANGE") {
            await page.evaluate(() => {
              const p = document.getElementById("phone");
              p.value = "+12025550124";
              p.dispatchEvent(new Event("input", { bubbles: true }));
            });
            assert.equal(
              await page.locator("#controlledPreviewPhoneRequired").isVisible(),
              true,
            );
            // Restoring the old number cannot restore cleared acceptance.
            await page.evaluate(() => {
              document.getElementById("phone").value = "+12025550123";
            });
          } else {
            await page.locator("#editDraft").click();
            await page.locator("#verifyChange").click();
            await page.locator("#start").waitFor({ state: "visible" });
          }
          assert.equal(await page.locator("#submitReview").isDisabled(), true);
          await assertBlocked();
          assert.equal(submissions.length, 0);
          assert.deepEqual(errors, []);
          checks.push({ width, mode, submitted: 0 });
          await context.close();
          continue;
        }
        if (mode === "REQUEST_ID_FAILURE")
          await page.evaluate(() => {
            Object.defineProperty(crypto, "randomUUID", {
              configurable: true,
              value: () => {
                throw Error("Synthetic request-ID preparation failure");
              },
            });
          });
        if (mode === "NATIVE_DUPLICATE")
          await page.locator("#submitReview").dblclick();
        else await page.locator("#submitReview").click();
        if (["REQUEST_ID_FAILURE", "MISSING_REVIEWED_ADDRESS"].includes(mode)) {
          await page.evaluate(
            () => new Promise((resolve) => requestAnimationFrame(resolve)),
          );
          console.log(
            JSON.stringify({
              fixtureObservation: {
                width,
                mode,
                submitted: submissions.length,
                pageErrorCount: errors.length,
                feedbackChanged:
                  (await page.locator("#status").innerText()) !==
                  "Draft validated for review only. Nothing booked or sent.",
              },
            }),
          );
          assert.notEqual(
            await page.locator("#status").innerText(),
            "Draft validated for review only. Nothing booked or sent.",
            `${mode}: local preparation refusal must produce explicit feedback`,
          );
          assert.match(
            await page.locator("#status").innerText(),
            /draft.*retain|retain.*draft/i,
          );
          assert.equal(submissions.length, 0);
          assert.equal(
            await page.locator("#customerName").inputValue(),
            "Fictional",
          );
          assert.equal(
            await page.locator("#controlledStreet").inputValue(),
            "123 Fictional Lane",
          );
          assert.equal(await page.locator("#retry").isVisible(), false);
          assert.deepEqual(errors, []);
          checks.push({
            width,
            mode,
            submitted: 0,
            proof: "Injected local resilience only",
          });
          await context.close();
          continue;
        }
        await page.waitForFunction(
          () =>
            !document.querySelector("#status").textContent.includes("Working"),
        );
        await page.waitForFunction(() =>
          /Job created|No job created|Outcome unconfirmed|Submission outcome unavailable/.test(
            document.querySelector("#status").textContent,
          ),
        );
        assert.equal(submissions.length, 1);
        assert.equal(submissions[0].version, 2);
        assert.equal(
          submissions[0].draft.address,
          "123 Fictional Lane, Example, OH 44101",
        );
        assert.deepEqual(submissions[0].confirmedAddress, {
          street: "123 Fictional Lane",
          unit: "",
          city: "Example",
          postalCode: "44101",
        });
        if (
          [
            "ADDRESS_REVIEW_UNAVAILABLE",
            "SERVICE_AREA_NOT_CONFIRMED",
            "OUTSIDE_SERVICE_AREA",
            "ADDRESS_CORRECTION_STATE_UNAVAILABLE",
          ].includes(mode)
        ) {
          const feedback = await page.locator("#status").innerText();
          assert.match(feedback, /No job created/);
          assert.match(
            feedback,
            mode === "OUTSIDE_SERVICE_AREA"
              ? /outside the current service area/
              : mode === "SERVICE_AREA_NOT_CONFIRMED"
                ? /could not confirm.*service area/
                : mode === "ADDRESS_CORRECTION_STATE_UNAVAILABLE"
                  ? /correction review is no longer available/
                  : /could not confirm the address as entered/,
          );
          assert.equal(
            await page.locator("#controlledStreet").inputValue(),
            "123 Fictional Lane",
          );
          assert.equal(await page.locator("#reviewed").isChecked(), false);
        }
        if (["LOST_ACK", "LOST_ACK_SETUP_FAILURE"].includes(mode)) {
          if (mode === "LOST_ACK_SETUP_FAILURE") {
            await page.evaluate(() => {
              window.fixtureAbortController = window.AbortController;
              window.fixtureSetupFailures = 0;
              window.AbortController = class {
                constructor() {
                  window.fixtureSetupFailures++;
                  throw Error("Synthetic retry setup failure");
                }
              };
            });
            await page.locator("#retry").click();
            await page.waitForFunction(() => window.fixtureSetupFailures === 1);
            await page.evaluate(
              () => new Promise((resolve) => requestAnimationFrame(resolve)),
            );
            assert.equal(submissions.length, 1);
            assert.equal(await page.locator("#retry").isVisible(), true);
            assert.equal(await page.locator("#editDraft").isDisabled(), true);
            assert.ok(
              (await page.locator("#status").innerText()).includes(
                submissions[0].requestId,
              ),
            );
            assert.deepEqual(errors, []);
            await page.evaluate(() => {
              window.AbortController = window.fixtureAbortController;
              delete window.fixtureAbortController;
              delete window.fixtureSetupFailures;
            });
          }
          await page.locator("#retry").click();
          await page.locator("#submitted").waitFor({ state: "visible" });
          assert.deepEqual(submissions[1], submissions[0]);
        } else if (mode === "CORRECTION_UNSELECTABLE") {
          assert.equal(
            await page.locator("#controlledUseSuggestion").isHidden(),
            true,
          );
          assert.equal(submissions.length, 1);
        } else if (
          ["CORRECTION_REQUIRED", "CORRECTION_MANUAL"].includes(mode)
        ) {
          assert.match(
            await page.locator("#controlledSuggestion").textContent(),
            /124 Fictional/,
          );
          assert.equal(
            await page.locator("#controlledStreet").inputValue(),
            "123 Fictional Lane",
          );
          assert.equal(await page.locator("#reviewed").isChecked(), false);
          assert.equal(submissions.length, 1);
          await page.screenshot({
            path: `${out}/correction-selection-${width}.png`,
            fullPage: true,
          });
          if (mode === "CORRECTION_REQUIRED")
            await page.locator("#controlledUseSuggestion").click();
          else {
            await page.locator("#controlledStreet").fill("126 Fictional Lane");
            await page.locator("#controlledUnit").fill("Unit 3");
            await page.locator("#controlledPostal").fill("44101");
          }
          assert.equal(submissions.length, 1);
          assert.equal(
            await page.locator("#controlledStreet").inputValue(),
            mode === "CORRECTION_REQUIRED"
              ? "124 Fictional Lane"
              : "126 Fictional Lane",
          );
          assert.equal(
            await page.locator("#controlledUnit").inputValue(),
            mode === "CORRECTION_REQUIRED" ? "Apt 2" : "Unit 3",
          );
          assert.equal(
            await page.locator("#controlledPostal").inputValue(),
            mode === "CORRECTION_REQUIRED" ? "44101-1234" : "44101",
          );
          await page.locator("#reviewed").check();
          await page.locator("#draft").click();
          await page.locator("#submitReview").click();
          await page.locator("#submitted").waitFor({ state: "visible" });
          assert.equal(submissions.length, 2);
          assert.equal(
            submissions[1].confirmedAddress.street,
            mode === "CORRECTION_REQUIRED"
              ? "124 Fictional Lane"
              : "126 Fictional Lane",
          );
          assert.equal(
            submissions[1].confirmedAddress.unit,
            mode === "CORRECTION_REQUIRED" ? "Apt 2" : "Unit 3",
          );
          assert.equal(
            submissions[1].confirmedAddress.postalCode,
            mode === "CORRECTION_REQUIRED" ? "44101-1234" : "44101",
          );
          assert.notEqual(submissions[1].requestId, submissions[0].requestId);
          assert.equal(
            submissions[1].correctionContinuation,
            "v1." + "a".repeat(80),
          );
          assert.equal(
            Object.hasOwn(submissions[0], "correctionContinuation"),
            false,
          );
        } else if (["UNCERTAIN", "MALFORMED"].includes(mode)) {
          assert.equal(await page.locator("#retry").isVisible(), true);
          assert.equal(await page.locator("#editDraft").isDisabled(), true);
        }
        if (
          [
            "ADMITTED",
            "LOST_ACK",
            "LOST_ACK_SETUP_FAILURE",
            "DELAYED_PREVIEW",
            "EDIT_REVIEW",
            "NATIVE_DUPLICATE",
          ].includes(mode)
        )
          assert.match(
            await page.locator("#submittedHeading").textContent(),
            /does not confirm a booking/,
          );
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          true,
        );
        assert.equal(
          await page.evaluate(
            () => localStorage.length + sessionStorage.length,
          ),
          0,
        );
        assert.deepEqual(errors, []);
        await page.screenshot({
          path: `${out}/${mode}-${width}.png`,
          fullPage: true,
        });
        await page.reload();
        assert.equal(await page.locator("#start").isVisible(), true);
        assert.equal(await page.locator("#controlledStreet").inputValue(), "");
        checks.push({ width, mode, submitted: submissions.length });
        await context.close();
      }
    }
    await writeFile(
      `${out}/summary.json`,
      JSON.stringify(
        {
          checks,
          realProviderCalls: 0,
          actualJobWrites: 0,
          proof: "UI only; mocked transport outcomes",
        },
        null,
        2,
      ),
    );
    console.log(
      JSON.stringify({
        passed: checks.length,
        proof: "UI only; mocked transport outcomes",
        out,
      }),
    );
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    console.log(JSON.stringify({ fixtureClosed: true }));
  }
}
