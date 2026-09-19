import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { manifest } from "./p06-migrate-once.mjs";
import { fixture } from "./fixtures/p06-runtime-packet.mjs";
import { classifyActivationSnapshot } from "./p06-r10-activation-diagnostic.mjs";

const OPERATION_ID = "4b284fb8-534b-4385-bc5e-1c7df364ce47";

async function valid() {
  const { packet } = fixture();
  const activation = packet.envelope.activation;
  const migrations = (await manifest()).map((file) => ({
    migration_name: file.name,
    checksum: file.sha256,
    finished_at: new Date("2026-01-01T00:00:00.000Z"),
    rolled_back_at: null,
  }));
  const settings = {
    organizationProfileV1: {
      version: 1,
      draft: {
        companyName: "Fixture HVAC",
        timezone: "America/New_York",
        hours: "Weekdays",
        services: "Repair",
        fallback: "A human will follow up.",
        greeting: "Hello.",
        tone: "concise",
        faqs: [{ question: "Hours?", answer: "Weekdays.", source: "fixture" }],
      },
      approved: null,
    },
    organizationPaymentPolicyV1: {
      version: 1,
      draft: {
        currency: "usd",
        serviceFeeRequired: true,
        serviceFeeCents: 9900,
        depositRequired: false,
        depositPolicy: { kind: "none" },
        emergencyFeePolicy: { kind: "none" },
        paymentGateMode: "fail_closed",
        webhookValidationRequired: true,
      },
      approved: null,
    },
    controlledRuntimeApproval: null,
    controlledPhoneApproval: null,
  };
  const organization = {
    draft: settings.organizationProfileV1.draft,
    actorId: "owner:fixture",
    approvedAt: activation.organizationApprovedAt,
  };
  const payment = {
    draft: settings.organizationPaymentPolicyV1.draft,
    actorId: "owner:fixture",
    approvedAt: activation.paymentApprovedAt,
  };
  settings.organizationProfileV1.approved = organization;
  settings.organizationPaymentPolicyV1.approved = payment;
  const { createHash } = await import("node:crypto");
  const sha = (value) =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex");
  activation.organizationDigest = sha(organization);
  activation.paymentDigest = sha(payment);
  return {
    packet,
    attemptedAt: activation.validFrom,
    snapshot: {
      identity: {
        name: "neondb",
        role: "neondb_owner",
        version: 180000,
      },
      migrations,
      tenant: {
        id: activation.tenantId,
        status: "ACTIVE",
        settings,
      },
      categoryIds: [...activation.allowedServiceCategoryIds],
      matchingOperationAudits: 0,
    },
  };
}

test("reports only the bounded success stage for matching synthetic state", async () => {
  const input = await valid();
  assert.deepEqual(
    await classifyActivationSnapshot(
      input.packet,
      OPERATION_ID,
      input.attemptedAt,
      input.snapshot,
    ),
    {
      status: "ACTIVATION_DIAGNOSTIC",
      outcome: "PASS",
      stage: "ACTIVATION_PREREQUISITES_MATCHED",
    },
  );
});

test("classifies each material activation prerequisite without row data", async () => {
  const cases = [
    ["DATABASE_IDENTITY", (x) => (x.snapshot.identity.role = "other")],
    ["MIGRATION_HISTORY", (x) => x.snapshot.migrations.pop()],
    ["TENANT_STATUS", (x) => (x.snapshot.tenant.status = "SUSPENDED")],
    [
      "PRIOR_APPROVAL_STATE",
      (x) =>
        (x.snapshot.tenant.settings.controlledRuntimeApproval = {
          enabled: true,
          digest: "a".repeat(64),
        }),
    ],
    [
      "OPERATION_ALREADY_RECORDED",
      (x) => (x.snapshot.matchingOperationAudits = 1),
    ],
    [
      "ACTIVATION_WINDOW_AT_ATTEMPT",
      (x) => (x.attemptedAt = "2020-01-01T00:00:00.000Z"),
    ],
    ["SERVICE_CATEGORY_BINDING", (x) => (x.snapshot.categoryIds = [])],
    [
      "ORGANIZATION_APPROVAL_BINDING",
      (x) => (x.packet.envelope.activation.organizationDigest = "f".repeat(64)),
    ],
    [
      "PAYMENT_APPROVAL_BINDING",
      (x) => (x.packet.envelope.activation.paymentDigest = "f".repeat(64)),
    ],
  ];
  for (const [stage, mutate] of cases) {
    const input = await valid();
    mutate(input);
    const answer = await classifyActivationSnapshot(
      input.packet,
      OPERATION_ID,
      input.attemptedAt,
      input.snapshot,
    );
    assert.deepEqual(answer, {
      status: "ACTIVATION_DIAGNOSTIC",
      outcome: "FAIL",
      stage,
    });
    assert.deepEqual(Object.keys(answer).sort(), [
      "outcome",
      "stage",
      "status",
    ]);
  }
});

test("direct CLI is inert", () => {
  const child = spawnSync(
    process.execPath,
    ["scripts/p06-r10-activation-diagnostic.mjs"],
    { encoding: "utf8" },
  );
  assert.equal(child.status, 1);
  assert.equal(child.stdout, "");
  assert.match(child.stderr, /no action performed/);
});
