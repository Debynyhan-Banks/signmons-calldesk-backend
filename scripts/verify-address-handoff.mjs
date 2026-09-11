import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  requestContextMiddleware,
  setAuthContext,
} = require("../dist/common/context/request-context.js");
const {
  CustomerIntakeContinuationService,
} = require("../dist/communications/customer-intake-continuation.service.js");
const {
  LocalAddressService,
} = require("../dist/communications/local-address.service.js");

export async function verifyAddressHandoff({
  page,
  prisma,
  cipher,
  credentials,
  intake,
  browser,
  token,
  evidence,
  catalog,
}) {
  const scope = credentials.verifySession(token);
  const asOperator = (fn, tenantId = scope.tenantId, role = "dispatcher") =>
    new Promise((resolve, reject) =>
      requestContextMiddleware({ headers: {} }, {}, () => {
        setAuthContext({ tenantId, role, userId: "fictional-operator" });
        Promise.resolve().then(fn).then(resolve, reject);
      }),
    );
  const draft = Object.fromEntries(
    (await page.locator("#summary").innerText())
      .split("\n")
      .slice(0, 7)
      .map((line) => {
        const i = line.indexOf(": ");
        return [line.slice(0, i), line.slice(i + 2)];
      }),
  );
  // Read request fields directly from this fictional browser; no persistent token evidence.
  const addressSelection = await page.evaluate(() => ({
    candidateId: document.getElementById("addressCandidate").value,
    query: document.getElementById("address").value.trim(),
    unit: document.getElementById("addressUnit").value.trim(),
  }));
  const local = new LocalAddressService(prisma, cipher, credentials, catalog);
  const state = await local.handle({
    action: "status",
    operationId: randomUUID(),
    expectedRevision: 0,
    sessionToken: token,
    query: "",
    unit: "",
    candidateId: "",
    confirmed: false,
  });
  addressSelection.revision = state.revision;
  const input = {
    sessionToken: token,
    requestId: randomUUID(),
    expectedRevision: 1,
    draft,
    confirmed: true,
    addressSelection,
  };
  const count = () =>
    prisma.communicationEvent.count({
      where: {
        conversationId: scope.conversationId,
        content: {
          is: {
            payload: { path: ["type"], equals: "protected_intake_review_v1" },
          },
        },
      },
    });
  const failing = {
    $transaction: (fn) =>
      prisma.$transaction((tx) =>
        fn(
          new Proxy(tx, {
            get(target, key) {
              if (key === "auditLog")
                return {
                  ...target.auditLog,
                  create: async () => {
                    throw Error("fictional rollback");
                  },
                };
              return Reflect.get(target, key);
            },
          }),
        ),
      ),
  };
  const broken = new CustomerIntakeContinuationService(
    failing,
    cipher,
    credentials,
    undefined,
    undefined,
    local,
  );
  await assert.rejects(broken.submitReview(input));
  assert.equal(await count(), 0);
  for (const override of [
    { revision: state.revision - 1 },
    { unit: "changed" },
    { candidateId: "fictional-out" },
  ])
    await assert.rejects(
      intake.submitReview({
        ...input,
        addressSelection: { ...addressSelection, ...override },
      }),
    );
  assert.equal(await count(), 0);
  await page.evaluate(() => {
    document.documentElement.dataset.reviewSubmit = "true";
    document.getElementById("submitReview").hidden = false;
  });
  const outgoing = page.waitForRequest((r) =>
    r.url().endsWith("/customer-session/submit"),
  );
  await page.locator("#submitReview").click();
  const submitted = (await outgoing).postDataJSON();
  await page.locator("#retry").waitFor({ state: "visible" });
  await page.locator("#retry").click();
  await page.locator("#submitted").waitFor({ state: "visible" });
  assert.equal(await count(), 1);
  assert.equal(
    await prisma.auditLog.count({
      where: {
        entityId: scope.conversationId,
        action: "conversation.intake_review_requested",
      },
    }),
    1,
  );
  const replay = await Promise.all([
    intake.submitReview(submitted),
    intake.submitReview(submitted),
  ]);
  assert.equal(replay[0].requestId, replay[1].requestId);
  await assert.rejects(
    intake.submitReview({ ...submitted, addressSelection: undefined }),
  );
  const row = await prisma.communicationContent.findFirst({
    where: { communicationEvent: { id: submitted.requestId } },
  });
  assert.ok(row);
  assert.ok(
    !JSON.stringify(row.payload).includes("Fictional Lane") &&
      !JSON.stringify(row.payload).includes(token),
  );
  const saved = await asOperator(() =>
    intake.readReview({ requestId: submitted.requestId }),
  );
  assert.equal(saved.localAddress.address, draft.address);
  assert.equal(saved.addressSnapshotCurrent, false);
  await assert.rejects(
    asOperator(
      () => intake.readReview({ requestId: submitted.requestId }),
      randomUUID(),
    ),
  );
  await assert.rejects(
    asOperator(
      () => intake.readReview({ requestId: submitted.requestId }),
      scope.tenantId,
      "technician",
    ),
  );
  await prisma.serviceArea.create({
    data: {
      tenantId: scope.tenantId,
      name: "Later policy",
      type: "ZIP",
      status: "ACTIVE",
      definition: { postalCodes: ["88888"] },
    },
  });
  await assert.rejects(intake.submitReview(submitted));
  assert.deepEqual(
    (
      await asOperator(() =>
        intake.readReview({ requestId: submitted.requestId }),
      )
    ).localAddress,
    saved.localAddress,
  );
  await assert.rejects(
    asOperator(() =>
      intake.admitReview({
        requestId: submitted.requestId,
        expectedOrganizationApprovedAt: new Date().toISOString(),
        review: {
          urgency: "STANDARD",
          acknowledgeCustomerStatements: true,
          reasonCode: "OPERATOR_REVIEWED_INTAKE",
        },
      }),
    ),
  );
  assert.equal(
    await prisma.job.count({ where: { tenantId: scope.tenantId } }),
    0,
  );
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  try {
    // Local fixture browser adapter; real role-scoped service read, no live server/token.
    await context.route("**/*", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/")
        return route.fulfill({
          contentType: "text/html",
          body: await readFile(
            new URL("./fixtures/operator-intake-review.html", import.meta.url),
            "utf8",
          ),
        });
      if (path === "/operator-review.js")
        return route.fulfill({
          contentType: "application/javascript",
          body: await readFile(
            new URL("./fixtures/operator-intake-review.js", import.meta.url),
            "utf8",
          ),
        });
      if (path === "/intake-review-request/read")
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify(
            await asOperator(() =>
              intake.readReview(route.request().postDataJSON()),
            ),
          ),
        });
      return route.abort();
    });
    const operator = await context.newPage();
    await operator.goto("http://address-review.invalid/");
    await operator.locator("#operatorToken").fill("fictional-local-only");
    await operator.locator("#requestId").fill(submitted.requestId);
    await operator.locator("#load").click();
    await operator
      .getByText("Historical local test coverage", { exact: false })
      .waitFor();
    assert.equal(await operator.locator("#approve").isEnabled(), false);
    assert.equal(await operator.locator("#urgency").isEnabled(), false);
    assert.equal(await operator.locator("#ack").isEnabled(), false);
    assert.equal(
      await operator.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await operator
      .locator("#review")
      .screenshot({ path: evidence + "/address-handoff-mobile.png" });
    await operator.setViewportSize({ width: 1280, height: 900 });
    await operator
      .locator("#review")
      .screenshot({ path: evidence + "/address-handoff-desktop.png" });
  } finally {
    await context.close();
  }
  await writeFile(
    evidence + "/address-handoff-summary.json",
    JSON.stringify(
      {
        checks: [
          "atomic encrypted save and audit rollback",
          "exact revision/unit/candidate binding",
          "lost acknowledgment and concurrent replay save once",
          "omitted evidence cannot downgrade replay",
          "historical role-isolated operator read",
          "policy changes refuse replay but preserve historical display",
          "no job admission and mobile/desktop operator warning",
        ],
        liveProviderCalls: 0,
        newJobs: 0,
      },
      null,
      2,
    ),
  );
}
