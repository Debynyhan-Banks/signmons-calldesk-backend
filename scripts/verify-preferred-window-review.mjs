import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
const require = createRequire(import.meta.url);
const {
  PreferredWindowReviewService: Review,
} = require("../dist/jobs/preferred-window-review.service.js");
export async function verifyPreferredWindow({
  prisma,
  reviewer,
  origin,
  evidence,
  jobId,
  asOwner,
  failingDb,
}) {
  const [db] = await prisma.$queryRawUnsafe(
    "SELECT current_database() AS name, inet_server_addr() AS address",
  );
  assert.match(db.name, /^calldesk_org_[0-9a-f]{12}$/);
  assert.equal(db.address, null);
  const before = await prisma.job.findUnique({ where: { id: jobId } });
  const input = {
    jobId,
    expectedUpdatedAt: before.updatedAt.toISOString(),
    preference: "Weekday afternoons, customer local time; call to arrange.",
    acknowledged: true,
  };
  await assert.rejects(asOwner(() => new Review(failingDb).save(input)));
  assert.deepEqual(
    await prisma.job.findUnique({ where: { id: jobId } }),
    before,
  );
  const requests = [];
  reviewer.on("request", (r) => {
    if (r.url().endsWith("/preferred-window-review/save"))
      requests.push(r.postData());
  });
  await reviewer.locator("#openReadiness").click();
  await reviewer.locator("#windowReview").waitFor({ state: "visible" });
  await reviewer.locator("#windowPreference").fill(input.preference);
  assert.equal(await reviewer.locator("#saveWindow").isDisabled(), true);
  await reviewer.locator("#windowAck").check();
  await reviewer.locator("#saveWindow").click();
  await reviewer.locator("#retryWindow").waitFor({ state: "visible" });
  await reviewer.waitForFunction(
    () => !document.getElementById("retryWindow").disabled,
  );
  assert.equal(await reviewer.locator("#windowPreference").isDisabled(), true);
  await reviewer.locator("#retryWindow").click();
  await reviewer.waitForFunction(() =>
    document
      .getElementById("status")
      .textContent.includes("Customer preference saved"),
  );
  assert.equal(requests.length, 2);
  assert.equal(requests[0], requests[1]);
  const saved = await prisma.job.findUnique({ where: { id: jobId } });
  assert.equal(saved.preferredTimeText, input.preference);
  assert.equal(saved.status, "CREATED");
  assert.equal(saved.calendarEventId, null);
  assert.equal(saved.serviceWindowStart, null);
  assert.equal(saved.serviceWindowEnd, null);
  assert.deepEqual(saved.pricingSnapshot, before.pricingSnapshot);
  assert.deepEqual(
    saved.policySnapshot.paymentPolicyBinding,
    before.policySnapshot.paymentPolicyBinding,
  );
  assert.deepEqual(
    saved.policySnapshot.intakeAdmission,
    before.policySnapshot.intakeAdmission,
  );
  let audits = await prisma.auditLog.findMany({
    where: { entityId: jobId, action: "job.preferred_window_reviewed" },
  });
  assert.equal(audits.length, 1);
  assert.ok(!JSON.stringify(audits).includes(input.preference));
  await reviewer.locator("#openReadiness").click();
  await reviewer.waitForFunction(() =>
    document
      .getElementById("readinessFacts")
      .textContent.includes("Weekday afternoons"),
  );
  assert.equal(
    await reviewer.locator("#windowPreference").inputValue(),
    input.preference,
  );
  assert.equal(await reviewer.locator("#windowAck").isChecked(), false);
  const facts = await reviewer.locator("#readinessFacts").innerText();
  assert.ok(!facts.includes("Preferred service window is missing"));
  assert.ok(facts.includes("Required payment has not been requested"));
  assert.ok(facts.includes("Customer contact is not verified"));
  assert.ok(facts.includes("Service address is not verified"));
  await reviewer.locator("#result").screenshot({
    path: evidence + "/preferred-window-mobile.png",
  });
  await reviewer.setViewportSize({ width: 1280, height: 1000 });
  await reviewer.locator("#result").screenshot({
    path: evidence + "/preferred-window-desktop.png",
  });
  await reviewer.setViewportSize({ width: 390, height: 844 });
  const post = (body, token = "fixture-owner") =>
    fetch(origin + "/preferred-window-review/save", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  assert.equal(
    (await post({ ...input, preference: "Different stale preference" })).status,
    409,
  );
  assert.equal((await post(input, "fixture-tech")).status, 403);
  assert.equal((await post(input, "fixture-other")).status, 404);
  assert.equal((await post(input, "bad")).status, 401);
  assert.equal((await post({ ...input, bookingAuthorized: true })).status, 400);
  const correction = {
    ...input,
    expectedUpdatedAt: saved.updatedAt.toISOString(),
    preference: "Friday afternoons, customer local time; call to arrange.",
  };
  const pair = await Promise.all([post(correction), post(correction)]);
  for (const response of pair) {
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
  }
  audits = await prisma.auditLog.findMany({
    where: { entityId: jobId, action: "job.preferred_window_reviewed" },
  });
  assert.equal(audits.length, 2);
  assert.equal(await prisma.payment.count(), 0);
  await reviewer.locator("#openReadiness").click();
  await reviewer.waitForFunction(() =>
    document
      .getElementById("readinessFacts")
      .textContent.includes("Friday afternoons"),
  );
  assert.equal(
    await reviewer.locator("#windowPreference").inputValue(),
    correction.preference,
  );
  const summary = {
    checks: [
      "actual operator browser save and lost-response exact retry",
      "real audit failure rolls back preference and job version",
      "fresh reload removes only missing preference blocker",
      "stale and foreign/role/authority inputs refuse",
      "concurrent identical correction commits once",
    ],
    bookingAuthorized: false,
    deliveryAuthorized: false,
    availabilityChecked: false,
    calendarWindowsUnchanged: true,
    pricingAndPolicyPreserved: true,
    auditRows: 2,
    paymentRecords: 0,
    productionRegistered: false,
  };
  await writeFile(
    evidence + "/preferred-window-summary.json",
    JSON.stringify(summary, null, 2),
  );
  return summary.checks;
}
