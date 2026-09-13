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
      "REFUSED",
      "UNCERTAIN",
      "LOST_ACK",
      "MALFORMED",
    ]) {
      const context = await browser.newContext({
        viewport: { width, height: 1000 },
      });
      const page = await context.newPage();
      const errors = [],
        submissions = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.route("**/customer-session/**", async (route) => {
        const op = new URL(route.request().url()).pathname.split("/").pop();
        const body = route.request().postDataJSON();
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
            expiresAt: new Date(Date.now() + 600000).toISOString(),
            deliveryAuthorized: false,
          };
        else if (op === "continue")
          value = {
            reply: "Please review your details.",
            revision: 1,
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
          const state = mode === "LOST_ACK" ? "ADMITTED" : mode;
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
                    addressLines: ["124 Fictional Lane"],
                    city: "Example",
                    postalCode: "44101",
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
      await page.locator("#draft").click();
      await page.locator("#submitReview").click();
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
        await page.locator("#controlledStreet").fill("124 Fictional Lane");
        await page.locator("#reviewed").check();
        await page.locator("#draft").click();
        await page.locator("#submitReview").click();
        await page.locator("#details").waitFor({ state: "visible" });
        assert.equal(submissions.length, 2);
        assert.equal(
          submissions[1].confirmedAddress.street,
          "124 Fictional Lane",
        );
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
