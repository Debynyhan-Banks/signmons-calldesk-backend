import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { localCorrectionPort } from "./local-correction-port.mjs";
const require = createRequire(import.meta.url);
const {
  GoogleAddressAdapter,
} = require("../dist/communications/google-address.adapter.js");

export function correctionFixture(prisma, credentials) {
  return localCorrectionPort({
    prisma,
    credentials,
    adapter: new GoogleAddressAdapter(async () => ({
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
    })),
  });
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
  await page.locator("#correctionCity").fill("Changed");
  assert.equal(await page.locator("#correctionConfirm").isEnabled(), false);
  assert.equal(await page.locator("#correctionCandidate").textContent(), "");
  await page.locator("#correctionCity").fill("Example");
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
