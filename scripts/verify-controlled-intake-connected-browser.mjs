// Called only by the existing guarded disposable database harness.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
const require = createRequire(import.meta.url);
const express = require("express");
const { customerIntakePage } = require("../dist/communications/customer-intake-page.js");
const {
  CustomerConsentBrowserTransport,
} = require("../dist/communications/customer-consent-browser-transport.js");
const {
  customerSessionHttp,
} = require("../dist/communications/customer-session-http.js");
const {
  LocalCustomerBrowserBudget,
} = require("../dist/communications/customer-consent-browser-budget.js");

export async function verifyControlledIntakeConnectedBrowser({
  browser,
  credentials,
  session,
  tenantId,
  intake,
  responses,
  capture,
  composition,
  mode,
  width,
  evidence,
}) {
  const app = express(),
    server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const requests = [],
    results = [],
    errors = [];
  let lose = mode === "accepted";
  const transport = new CustomerConsentBrowserTransport(
    { origin, tenantId, fixtureLoopback: true },
    {
      credentials,
      budget: new LocalCustomerBrowserBudget(),
      capture,
      responses: {
        start: async () => session,
        prompt: (v) => responses.prompt(v),
        respond: (v) => responses.respond(v),
      },
      continuation: { continue: (v) => intake.continueOrganization(v) },
      draft: intake,
      controlled: {
        submit: async (v) => {
          requests.push(v);
          const result = await composition.submit(v);
          results.push(result);
          return result;
        },
      },
    },
  );
  app.use((_req, res, next) => {
    const json = res.json.bind(res);
    res.json = (body) => {
      if (lose && body.status === "ADMITTED") {
        lose = false;
        // A closed socket can be transparently retried by Chromium. Use a
        // post-commit failed acknowledgment so the UI's explicit retry is tested.
        res.status(503);
        return json({ error: "Synthetic post-commit acknowledgment failure." });
      }
      return json(body);
    };
    next();
  });
  app.use(
    customerSessionHttp({ tenantId, integrationId: "fixture", transport }),
  );
  const html = (
    await readFile(
      new URL("./fixtures/customer-intake-journey.html", import.meta.url),
      "utf8",
    )
  ).replace(
    '<html lang="en">',
    '<html lang="en" data-controlled-intake="true">',
  );
  const js = await readFile(
    new URL("./fixtures/customer-intake-journey.js", import.meta.url),
  );
  app.use(customerIntakePage({ html, script: js.toString("utf8") }));
  const context = await browser.newContext({
    viewport: { width, height: 1000 },
  });
  let page;
  try {
    page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(origin + "/customer-intake");
    await page.locator("#start").click();
    await page.locator("#message").fill("Do you repair heating?");
    await page.locator("#continue").click();
    await page.locator("#skip").click();
    for (const [id, value] of Object.entries({
      customerName: "Fictional Admission Customer",
      phone: "+12025550173",
      controlledStreet: "173 Fictional Lane",
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
    if (mode === "accepted") {
      await page.locator("#retry").waitFor({ state: "visible" });
      assert.equal(results[0]?.status, "ADMITTED");
      await page.locator("#retry").click();
      await page.locator("#submitted").waitFor({ state: "visible" });
      assert.deepEqual(requests[1], requests[0]);
      assert.deepEqual(results[1], results[0]);
      assert.match(
        await page.locator("#submittedHeading").textContent(),
        /does not confirm a booking/,
      );
    } else if (mode === "correction") {
      await page.locator("#details").waitFor({ state: "visible" });
      assert.equal(results[0]?.status, "CORRECTION_REQUIRED");
      assert.equal(
        await page.locator("#controlledStreet").inputValue(),
        "173 Fictional Lane",
      );
      assert.match(
        await page.locator("#controlledSuggestion").textContent(),
        /174 Fictional Lane/,
      );
      await page.locator("#controlledStreet").fill("174 Fictional Lane");
      await page.locator("#reviewed").check();
      await page.locator("#draft").click();
      await page.locator("#submitReview").click();
      await page.locator("#submitted").waitFor({ state: "visible" });
      assert.equal(results[1]?.status, "ADMITTED");
      assert.notEqual(requests[1].requestId, requests[0].requestId);
      assert.equal(requests[1].confirmedAddress.street, "174 Fictional Lane");
    } else if (mode === "outside") {
      await page.locator("#details").waitFor({ state: "visible" });
      assert.equal(results[0]?.status, "REFUSED");
      assert.equal(
        await page.locator("#controlledStreet").inputValue(),
        "173 Fictional Lane",
      );
    } else {
      await page.locator("#retry").waitFor({ state: "visible" });
      assert.equal(results[0]?.status, "UNCERTAIN");
      assert.equal(await page.locator("#editDraft").isDisabled(), true);
    }
    assert.deepEqual(errors, []);
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
    await page.screenshot({
      path: `${evidence}/connected-${mode}-${width}.png`,
      fullPage: true,
    });
    await page.reload();
    assert.equal(await page.locator("#start").isVisible(), true);
    assert.equal(await page.locator("#controlledStreet").inputValue(), "");
    return mode === "correction" ? results[1] : results[0];
  } catch (error) {
    console.log(
      JSON.stringify({
        mode,
        width,
        statuses: results.map((r) => r.status),
        statusText: await page?.locator("#status").textContent(),
      }),
    );
    throw error;
  } finally {
    await context.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
