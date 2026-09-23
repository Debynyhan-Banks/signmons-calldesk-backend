// UI state tests of the existing journey page. Mock HTTP responses, no provider or database.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const html = (
  await readFile(
    new URL("./fixtures/customer-intake-journey.html", import.meta.url),
    "utf8",
  )
).replace('<html lang="en">', '<html lang="en" data-controlled-intake="true">');
const script = await readFile(
  new URL("./fixtures/customer-intake-journey.js", import.meta.url),
);
const server = createServer((req, res) => {
  res.setHeader(
    "Content-Type",
    req.url === "/journey.js" ? "application/javascript" : "text/html",
  );
  res.end(req.url === "/journey.js" ? script : html);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const out = process.env.CONTROLLED_UI_EVIDENCE_DIR;
assert.ok(out, "explicit evidence directory required");
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
const checks = [];
try {
  for (const width of [390, 1440]) {
    for (const mode of [
      "ADMITTED",
      "CORRECTION_REQUIRED",
      "CORRECTION_UNSELECTABLE",
      "REFUSED",
      "UNCERTAIN",
      "LOST_ACK",
      "MALFORMED",
      "PHONE_REFUSED",
      "PHONE_UNKNOWN",
      "PHONE_EXPIRED",
      "PHONE_UNAVAILABLE",
      "PHONE_CHANGE",
      "PHONE_END",
    ]) {
      const context = await browser.newContext({
        viewport: { width, height: 1000 },
      });
      const page = await context.newPage();
      const errors = [],
        submissions = [],
        requests = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.route("**/customer-session/**", async (route) => {
        const op = new URL(route.request().url()).pathname.split("/").pop();
        const body = route.request().postDataJSON();
        requests.push({ op, body });
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
            expiresAt: new Date(Date.now() + 600000).toISOString(),
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
        else if (op === "draft")
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
        else if (op === "submit") {
          submissions.push(body);
          if (mode === "LOST_ACK" && submissions.length === 1)
            return route.abort();
          const state =
            mode === "LOST_ACK" ||
            (mode === "CORRECTION_REQUIRED" && submissions.length > 1)
              ? "ADMITTED"
              : mode === "CORRECTION_UNSELECTABLE"
                ? "CORRECTION_REQUIRED"
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
          };
        } else throw Error("Unexpected UI operation " + op);
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
      assert.equal(
        await page.locator("#controlledPhoneRequired").isHidden(),
        true,
      );
      await page.locator("#draft").click();
      await page.locator("#preview").waitFor({ state: "visible" });
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
      await page.evaluate(() => {
        document.getElementById("submitReview").onclick();
        document.getElementById("submitReview").onclick();
      });
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
      if (mode === "LOST_ACK") {
        await page.locator("#retry").click();
        await page.locator("#submitted").waitFor({ state: "visible" });
        assert.deepEqual(submissions[1], submissions[0]);
      } else if (mode === "CORRECTION_UNSELECTABLE") {
        assert.equal(
          await page.locator("#controlledUseSuggestion").isHidden(),
          true,
        );
        assert.equal(submissions.length, 1);
      } else if (mode === "CORRECTION_REQUIRED") {
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
        await page.locator("#controlledUseSuggestion").click();
        assert.equal(submissions.length, 1);
        assert.equal(
          await page.locator("#controlledStreet").inputValue(),
          "124 Fictional Lane",
        );
        assert.equal(
          await page.locator("#controlledUnit").inputValue(),
          "Apt 2",
        );
        assert.equal(
          await page.locator("#controlledPostal").inputValue(),
          "44101-1234",
        );
        await page.locator("#reviewed").check();
        await page.locator("#draft").click();
        await page.locator("#submitReview").click();
        await page.locator("#submitted").waitFor({ state: "visible" });
        assert.equal(submissions.length, 2);
        assert.equal(
          submissions[1].confirmedAddress.street,
          "124 Fictional Lane",
        );
        assert.equal(submissions[1].confirmedAddress.unit, "Apt 2");
        assert.equal(submissions[1].confirmedAddress.postalCode, "44101-1234");
        assert.notEqual(submissions[1].requestId, submissions[0].requestId);
      } else if (["UNCERTAIN", "MALFORMED"].includes(mode)) {
        assert.equal(await page.locator("#retry").isVisible(), true);
        assert.equal(await page.locator("#editDraft").isDisabled(), true);
      }
      if (["ADMITTED", "LOST_ACK"].includes(mode))
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
        await page.evaluate(() => localStorage.length + sessionStorage.length),
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
  await browser.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
