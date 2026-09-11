import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { localCorrectionPort } from "./local-correction-port.mjs";
const require = createRequire(import.meta.url);
const {
  GoogleAddressAdapter,
} = require("../dist/communications/google-address.adapter.js");

export function correctionFixture(prisma, credentials) {
  let calls = 0;
  const port = localCorrectionPort({
    prisma,
    credentials,
    adapter: new GoogleAddressAdapter(async () => {
      if (++calls === 3) throw Error("synthetic unknown provider result");
      return {
        result: {
          verdict: {
            addressComplete: true,
            validationGranularity: "PREMISE",
            hasReplacedComponents: true,
          },
          address: {
            postalAddress: {
              regionCode: "US",
              administrativeArea: "OH",
              locality: "Example",
              postalCode: "44101",
              addressLines: ["123 Fictional Street"],
            },
            addressComponents: Object.entries({
              street_number: "123",
              route: "Fictional Street",
              locality: "Example",
              administrative_area_level_1: "Ohio",
              postal_code: "44101",
              country: "United States",
            }).map(([componentType, text]) => ({
              componentType,
              componentName: { text },
              confirmationLevel: "CONFIRMED",
            })),
          },
          uspsData: { dpvConfirmation: "Y" },
        },
        responseId: "must-not-reach-browser",
        geocode: { private: true },
      };
    }),
  });
  return { ...port, mockCalls: () => calls };
}

export async function verifyUncertainCorrectionJourney({
  page,
  prisma,
  credentials,
  evidence,
  mockCalls,
}) {
  await page.setViewportSize({ width: 390, height: 844 });
  let body;
  page.on("request", (req) => {
    if (
      req.url().endsWith("/customer-session/correction") &&
      req.postDataJSON().action === "propose"
    )
      body = req.postDataJSON();
  });
  await page.locator("#address").fill("123 Fictional St");
  await page.locator("#correctionCity").fill("Example");
  await page.locator("#correctionPostal").fill("44101");
  await page.locator("#correctionPropose").click();
  await page.waitForFunction(() =>
    document
      .querySelector("#correctionStatus")
      .textContent.startsWith("Outcome uncertain"),
  );
  const calls = mockCalls();
  assert.equal(calls, 3);
  await page.locator("#retry").click();
  await page.waitForFunction(() => !document.querySelector("#retry").disabled);
  assert.equal(mockCalls(), calls);
  assert.equal(await page.locator("#address").inputValue(), "123 Fictional St");
  assert.equal(await page.locator("#correctionConfirm").isEnabled(), false);
  const scope = credentials.verifySession(body.sessionToken);
  const rows = await prisma.addressVerificationOperation.findMany({
    where: { sessionId: scope.sessionId },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, "UNCERTAIN");
  assert.equal(rows[0].heldMicros, 10n);
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.screenshot({
    path: evidence + "/address-uncertain-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({
    path: evidence + "/address-uncertain-desktop.png",
    fullPage: true,
  });
  await page.locator("#forget").click();
  assert.equal(await page.locator("#address").inputValue(), "");
  await writeFile(
    evidence + "/address-uncertain-browser.json",
    JSON.stringify(
      {
        checks: [
          "unknown result retains draft and held cost",
          "exact retry uses same operation with no new mock call",
          "confirmation unavailable",
          "private reset",
          "mobile and desktop",
        ],
        liveProviderCalls: 0,
      },
      null,
      2,
    ),
  );
}

export async function verifyCorrectionJourney({
  page,
  evidence,
  prisma,
  credentials,
}) {
  await page.setViewportSize({ width: 390, height: 844 });
  const requests = [];
  page.on("request", (req) => {
    if (new URL(req.url()).pathname === "/customer-session/correction")
      requests.push(req.postDataJSON());
  });
  await page.locator("#address").fill("123 Fictional St");
  await page.locator("#correctionCity").fill("Example");
  await page.locator("#correctionPostal").fill("44101");
  assert.equal(await page.locator("#correctionConfirm").isEnabled(), false);
  await page.locator("#correctionPropose").click();
  await page.locator("#retry").waitFor({ state: "visible" });
  await page.locator("#retry").click();
  await page.waitForFunction(() =>
    document
      .querySelector("#correctionCandidate")
      .textContent.includes("123 Fictional Street"),
  );
  assert.equal(await page.locator("#correctionConfirm").isEnabled(), false);
  await page.locator("#correctionChecked").check();
  await page.locator("#correctionConfirm").click();
  await page.waitForFunction(() =>
    document
      .querySelector("#correctionStatus")
      .textContent.startsWith("Customer confirmed"),
  );
  const confirmation = requests.at(-1);
  assert.equal(confirmation.action, "confirm");
  assert.equal(await page.locator("#address").inputValue(), "123 Fictional St");
  await page.screenshot({
    path: evidence + "/correction-mobile.png",
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({
    path: evidence + "/correction-desktop.png",
    fullPage: true,
  });
  const replay = async (body) =>
    page.evaluate(async (body) => {
      const response = await fetch("/customer-session/correction", {
        method: "POST",
        credentials: "omit",
        headers: {
          "Content-Type": "application/json",
          "X-CallDesk-Request": "customer-intake-v1",
        },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    }, body);
  assert.equal((await replay(confirmation)).body.status, "CUSTOMER_CONFIRMED");
  assert.equal(
    (await replay({ ...confirmation, candidateId: "wrong" })).body.status,
    "REFUSED",
  );
  assert.equal(
    (
      await replay({
        ...confirmation,
        input: { ...confirmation.input, city: "Changed" },
      })
    ).body.status,
    "REFUSED",
  );
  const unknown = await replay({ ...confirmation, tenantId: "forged" });
  assert.equal(unknown.status, 400);
  const discarded = page.waitForResponse(
    (r) =>
      r.url().endsWith("/customer-session/correction") &&
      r.request().postDataJSON()?.action === "clear",
  );
  await page.locator("#correctionCity").fill("Changed");
  await discarded;
  assert.equal(await page.locator("#correctionConfirm").isEnabled(), false);
  assert.equal(await page.locator("#correctionCandidate").textContent(), "");
  await page.locator("#correctionCity").fill("Example");
  await page.locator("#correctionPropose").click();
  await page.waitForFunction(() =>
    document
      .querySelector("#correctionStatus")
      .textContent.startsWith("Correction refused"),
  );
  assert.equal(await page.locator("#address").inputValue(), "123 Fictional St");
  // Disposable DB only: simulate elapsed cooldown without sleeping or altering policy.
  const firstScope = credentials.verifySession(confirmation.sessionToken);
  await prisma.addressVerificationOperation.updateMany({
    where: { sessionId: firstScope.sessionId },
    data: { createdAt: new Date(Date.now() - 31000) },
  });
  await page.locator("#correctionPropose").click();
  await page.waitForFunction(() =>
    document
      .querySelector("#correctionCandidate")
      .textContent.includes("Fictional Street"),
  );
  assert.equal((await replay(confirmation)).body.status, "REFUSED");
  const replacement = requests.filter((r) => r.action === "propose").at(-1);
  const scope = credentials.verifySession(replacement.sessionToken);
  await prisma.conversation.update({
    where: { id: scope.conversationId },
    data: { status: "COMPLETED" },
  });
  const latest = await replay(replacement);
  assert.equal(latest.body.status, "REFUSED");
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
  await page.locator("#forget").click();
  assert.equal(await page.locator("#correctionCandidate").textContent(), "");
  await writeFile(
    evidence + "/correction-summary.json",
    JSON.stringify(
      {
        checks: [
          "protected existing customer journey",
          "exact correction displayed",
          "explicit confirmation required",
          "exact retry",
          "lost response exact retry reuses observed candidate",
          "30-second cooldown refusal retains draft",
          "tampered candidate and address refused",
          "unknown claims refused",
          "edit clears UI",
          "replacement refuses old candidate",
          "closed server session refuses further proposals",
          "private reset",
          "mobile and desktop screenshots",
          "no browser storage",
        ],
        liveProviderCalls: 0,
        addressVerified: false,
        county: "UNKNOWN",
        admissionAuthorized: false,
        productionRegistered: false,
        draftAutomaticallyRewritten: false,
      },
      null,
      2,
    ),
  );
}
