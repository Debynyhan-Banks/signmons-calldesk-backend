import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  LocalAddressService,
} = require("../dist/communications/local-address.service.js");
export const ADDRESS_CATALOG = [
  { id: "fictional-in", address: "10 Fictional Lane", postalCode: "44119" },
  { id: "fictional-out", address: "20 Fictional Lane", postalCode: "99999" },
];
export async function verifyAddressJourney({
  page,
  prisma,
  cipher,
  credentials,
  token,
  requests,
  evidence,
}) {
  const scope = credentials.verifySession(token);
  const area = await prisma.serviceArea.create({
    data: {
      tenantId: scope.tenantId,
      name: "Fictional ZIP area",
      type: "ZIP",
      status: "ACTIVE",
      definition: { postalCodes: ["44119"] },
    },
  });
  await page.locator("#address").fill("Fictional");
  await page.locator("#addressUnit").fill("Unit A");
  const suggest = async () => {
    await page.locator("#addressSuggest").click();
    await page.waitForFunction(
      () => document.getElementById("addressCandidate").options.length === 3,
    );
  };
  const confirm = async (id) => {
    await page.locator("#addressCandidate").selectOption(id);
    await page.locator("#addressConfirmed").check();
    await page.locator("#addressConfirm").click();
  };
  await suggest();
  assert.equal(await page.locator("#addressConfirm").isEnabled(), false);
  await confirm("fictional-in");
  await page.locator("#retry").waitFor({ state: "visible" });
  await page.locator("#retry").click();
  await page
    .getByText("Service area: FIXTURE_IN_AREA", { exact: false })
    .waitFor();
  const confirms = requests.filter((r) => r.action === "confirm");
  assert.equal(confirms.length, 2);
  assert.deepEqual(confirms[0], confirms[1]);
  assert.equal(
    await prisma.auditLog.count({
      where: {
        entityId: scope.conversationId,
        action: "conversation.local_address_changed",
      },
    }),
    2,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .locator("#addressVerification")
    .screenshot({ path: evidence + "/address-journey-mobile.png" });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await page
    .locator("#addressVerification")
    .screenshot({ path: evidence + "/address-journey-desktop.png" });
  await page.locator("#addressUnit").fill("Unit B");
  assert.equal(await page.locator("#addressConfirm").isEnabled(), false);
  await suggest();
  await confirm("fictional-out");
  await page.getByText("Service area: OUT_OF_AREA", { exact: false }).waitFor();
  await prisma.serviceArea.update({
    where: { id: area.id },
    data: { definition: { postalCodes: ["99999"] } },
  });
  await page.locator("#addressRefresh").click();
  await page
    .getByText("service-area settings changed", { exact: false })
    .waitFor();
  assert.equal(await page.locator("#addressConfirm").isEnabled(), false);
  await suggest();
  await prisma.serviceArea.update({
    where: { id: area.id },
    data: { status: "INACTIVE" },
  });
  await confirm("fictional-out");
  await page
    .getByText("Address check refused or changed", { exact: false })
    .waitFor();
  await page.locator("#addressRefresh").click();
  await page
    .getByText("service-area settings changed", { exact: false })
    .waitFor();
  await suggest();
  await confirm("fictional-out");
  await page.getByText("Service area: UNKNOWN", { exact: false }).waitFor();
  await page
    .locator("#addressVerification")
    .screenshot({ path: evidence + "/address-coverage-unknown.png" });
  const service = new LocalAddressService(
    prisma,
    cipher,
    credentials,
    ADDRESS_CATALOG,
  );
  const status = {
    sessionToken: token,
    action: "status",
    expectedRevision: 0,
    operationId: randomUUID(),
    query: "",
    unit: "",
    candidateId: "",
    confirmed: false,
  };
  const current = await service.handle(status);
  const correction = {
    ...status,
    action: "suggest",
    expectedRevision: current.revision,
    operationId: randomUUID(),
    query: "Fictional",
    unit: "Unit C",
  };
  const before = await prisma.conversation.findUnique({
    where: { id: scope.conversationId },
  });
  const failing = {
    $transaction: (fn) =>
      prisma.$transaction((tx) =>
        fn(
          new Proxy(tx, {
            get(target, key) {
              if (key === "auditLog")
                return {
                  create: async () => {
                    throw Error("injected audit failure");
                  },
                };
              return Reflect.get(target, key);
            },
          }),
        ),
      ),
  };
  await assert.rejects(
    new LocalAddressService(
      failing,
      cipher,
      credentials,
      ADDRESS_CATALOG,
    ).handle(correction),
  );
  assert.deepEqual(
    await prisma.conversation.findUnique({
      where: { id: scope.conversationId },
    }),
    before,
  );
  const race = await Promise.allSettled([
    service.handle(correction),
    service.handle({
      ...correction,
      operationId: randomUUID(),
      unit: "Unit D",
    }),
  ]);
  assert.equal(race.filter((r) => r.status === "fulfilled").length, 1);
  const forged = credentials.issueSession({
    tenantId: scope.tenantId,
    conversationId: scope.conversationId,
    sessionId: randomUUID(),
  });
  await assert.rejects(service.handle({ ...status, sessionToken: forged }));
  const foreign = credentials.issueSession({
    tenantId: randomUUID(),
    conversationId: scope.conversationId,
    sessionId: scope.sessionId,
  });
  await assert.rejects(service.handle({ ...status, sessionToken: foreign }));
  await prisma.serviceArea.create({
    data: {
      tenantId: scope.tenantId,
      name: "Added fictional area",
      type: "ZIP",
      status: "ACTIVE",
      definition: { postalCodes: ["44119"] },
    },
  });
  assert.equal((await service.handle(status)).stale, true);
  await assert.rejects(service.handle({ ...status, extra: true }));
  const audits = await prisma.auditLog.findMany({
    where: {
      entityId: scope.conversationId,
      action: "conversation.local_address_changed",
    },
  });
  assert.ok(
    !JSON.stringify(audits).includes("Unit") &&
      !JSON.stringify(audits).includes("Fictional"),
  );
  assert.equal(
    await prisma.propertyAddress.count({ where: { tenantId: scope.tenantId } }),
    0,
  );
  assert.equal(
    await prisma.job.count({ where: { tenantId: scope.tenantId } }),
    0,
  );
  await page.locator("#forget").click();
  assert.equal(await page.locator("#addressUnit").inputValue(), "");
  const summary = {
    checks: [
      "fictional candidate confirmation and explicit active ZIP match",
      "lost acknowledgment exact replay writes once",
      "unit edit invalidates local selection; outside ZIP is OUT_OF_AREA",
      "area edits invalidate status and pending confirmation",
      "inactive geography yields UNKNOWN",
      "real audit rollback and concurrent corrections commit once",
      "forged session refuses; audit privacy; no master-address/job writes",
      "mobile desktop fit and private clear",
    ],
    liveProviderCalls: 0,
    addressAuthorized: false,
    bookingAuthorized: false,
    productionRegistered: false,
  };
  await writeFile(
    evidence + "/address-journey-summary.json",
    JSON.stringify(summary, null, 2),
  );
}
