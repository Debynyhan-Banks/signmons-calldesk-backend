// Fictional U01 inputs; never a deployable run packet.
import { randomUUID, createHash, createHmac } from "node:crypto";
import { TARGET } from "../p06-backup-once.mjs";
export function fixture() {
  const now = Date.now(),
    from = now - 1000,
    until = now + 600000;
  const approvedAt = new Date(now - 2000).toISOString();
  const draft = {
    companyName: "Fictional HVAC",
    timezone: "America/New_York",
    hours: "Weekdays",
    services: "Cooling",
    fallback: "Contact office",
    greeting: "Hello",
    tone: "warm",
    faqs: [
      {
        question: "Do you cool homes?",
        answer: "Yes.",
        source: "Fictional owner",
      },
    ],
  };
  const paymentDraft = {
    currency: "usd",
    serviceFeeRequired: true,
    serviceFeeCents: 100,
    depositRequired: false,
    depositPolicy: { kind: "none" },
    emergencyFeePolicy: { kind: "none" },
    paymentGateMode: "fail_closed",
    webhookValidationRequired: true,
  };
  const organization = {
    version: 1,
    draft,
    approved: { draft, actorId: "fictional-owner", approvedAt },
  };
  const payment = {
    version: 1,
    draft: paymentDraft,
    approved: { draft: paymentDraft, actorId: "fictional-owner", approvedAt },
  };
  const hash = (v) =>
    createHash("sha256").update(JSON.stringify(v)).digest("hex");
  const tenantId = randomUUID(),
    packetId = randomUUID(),
    categoryId = randomUUID();
  const ref = (name) =>
    `projects/signmons/secrets/fictional-${name}/versions/1`;
  const envelope = {
    version: 1,
    enabled: true,
    project: "signmons",
    service: "signmons-calldesk-staging",
    configuration: "signmons-calldesk-staging",
    revision: "signmons-calldesk-staging-fictional",
    origin: "https://fictional.invalid",
    activation: {
      version: 1,
      enabled: true,
      tenantId,
      integrationId: "fictional",
      origin: "https://fictional.invalid",
      policyVersion: "fixture-v1",
      organizationApprovedAt: approvedAt,
      organizationDigest: hash(organization.approved),
      paymentApprovedAt: approvedAt,
      paymentDigest: hash(payment.approved),
      allowedServiceCategoryIds: [categoryId],
      priorityPolicy: "AUTO_INTAKE_STANDARD_V1",
      validFrom: new Date(from).toISOString(),
      validUntil: new Date(until).toISOString(),
      packetId,
    },
    phone: {
      packetId,
      tenantId,
      accountSid: "AC" + "a".repeat(32),
      serviceSid: "VA" + "b".repeat(32),
      participantHmac: createHmac("sha256", Buffer.alloc(32, 2))
        .update("+12165550123")
        .digest("hex"),
      noticeVersion: "fixture",
      rateVersion: "fixture",
      startsAt: from,
      expiresAt: until,
      flowUpperBoundMicros: 10,
      accountCeilingMicros: 100,
    },
    addressAccountId: randomUUID(),
    addressPolicy: {
      mode: "CONTROLLED_ADDRESS_V1",
      approved: true,
      version: "fixture",
      rateVersion: "fixture",
      validUntil: until,
      costMicros: 1,
      account: { micros: 2, requests: 2 },
      tenant: { micros: 2, requests: 2 },
      session: { micros: 2, requests: 2 },
      execution: "CONTROLLED_8S_2_ATTEMPTS",
    },
    browserBudget: {
      packetId,
      tenantId,
      validFrom: from,
      validUntil: until,
      total: 20,
      tenant: 20,
      session: 15,
      starts: 1,
      inFlight: 2,
    },
    secrets: {
      activeKeyId: "a",
      sessionKeys: { a: ref("session") },
      digestKey: ref("digest"),
      fingerprintKey: ref("fingerprint"),
      fingerprintKeyVersion: "fixture",
      twilioToken: ref("token"),
    },
  };
  const facts = {
    nodeEnv: "production",
    project: envelope.project,
    service: envelope.service,
    configuration: envelope.configuration,
    revision: envelope.revision,
    port: "8080",
    flags: Object.fromEntries(
      [
        "DEV_AUTH_ENABLED",
        "SCHEDULING_ENABLED",
        "STRIPE_WEBHOOK_LIVEMODE",
        "SMS_DELIVERY_ENABLED",
        "BACKGROUND_WORKERS_ENABLED",
        "STAGING_PHONE_TEST_ENABLED",
      ].map((x) => [x, "false"]),
    ),
  };
  return {
    packet: {
      version: 1,
      sourceRevision: "a".repeat(40),
      target: { ...TARGET, role: "neondb_owner" },
      envelope,
      facts,
      bundleResource: "projects/signmons/secrets/fictional-bundle",
      forbiddenResources: ["projects/signmons/secrets/fictional-encryption"],
    },
    values: {
      [ref("session")]: "01".repeat(32),
      [ref("digest")]: "02".repeat(32),
      [ref("fingerprint")]: "03".repeat(32),
      [ref("token")]: "04".repeat(16),
    },
    settings: {
      keep: "untouched",
      organizationProfileV1: organization,
      organizationPaymentPolicyV1: payment,
    },
    categoryId,
  };
}
export function authorization(review, action) {
  return {
    owner: "Debynyhan Banks",
    action,
    operationId: randomUUID(),
    packetDigest: review.packetDigest,
    sourceRevision: review.p.sourceRevision,
    startUtc: new Date(Date.now() - 1000).toISOString(),
    endUtc: new Date(Date.now() + 600000).toISOString(),
  };
}
