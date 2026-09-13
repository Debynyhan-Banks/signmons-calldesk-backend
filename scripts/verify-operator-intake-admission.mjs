// Requires the parent verifier's disposable local database; never accepts a URL.
import assert from "node:assert/strict";
import { randomUUID, createHmac, createHash } from "node:crypto";
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
const require = createRequire(import.meta.url);
const {
  CustomerIntakeContinuationService: Intake,
} = require("../dist/communications/customer-intake-continuation.service.js");
const {
  CustomerConsentCredentials: Credentials,
} = require("../dist/communications/customer-consent-credentials.js");
const {
  ConversationMemoryCipher: Cipher,
} = require("../dist/logging/conversation-memory-cipher.service.js");
const {
  CustomerConsentResponseService: Responses,
} = require("../dist/communications/customer-consent-response.service.js");
const {
  CustomerConsentCaptureService: Capture,
} = require("../dist/communications/customer-consent-capture.service.js");
const {
  AppointmentEmailConsentEvidenceStore: Evidence,
} = require("../dist/communications/appointment-email-consent-evidence.js");
const {
  requestContextMiddleware,
  setAuthContext,
} = require("../dist/common/context/request-context.js");

export async function verifyOperatorIntakeAdmission({
  prisma,
  tenantId,
  otherTenantId,
  asOwner,
  organizationService,
  evidence,
}) {
  const [db] = await prisma.$queryRawUnsafe(
    "SELECT current_database() AS name, inet_server_addr() AS address",
  );
  assert.match(db.name, /^calldesk_org_[0-9a-f]{12}$/);
  assert.equal(db.address, null);
  const credentials = new Credentials({
    activeKeyId: "fixture",
    keys: { fixture: Buffer.alloc(32, 7) },
  });
  const cipher = new Cipher({ conversationDataEncryptionKey: "7".repeat(64) });
  const consent = new Evidence(cipher, {
    fingerprint: (tenant, email) => ({
      digest: createHmac("sha256", Buffer.alloc(32, 6))
        .update(JSON.stringify([tenant, email]))
        .digest("hex"),
      keyVersion: "fixture-only",
    }),
  });
  const responses = new Responses(prisma, cipher, credentials, consent);
  const capture = new Capture(prisma, cipher, credentials);
  const intake = new Intake(prisma, cipher, credentials);
  let credentialAccesses = 0;
  const noCredentials = new Proxy(
    {},
    {
      get() {
        credentialAccesses++;
        throw new Error("Operator credential access forbidden");
      },
    },
  );
  const operator = new Intake(
    prisma,
    cipher,
    noCredentials,
    undefined,
    consent,
  );
  const scoped = (fn, overrides = {}) =>
    new Promise((resolve, reject) =>
      requestContextMiddleware({ headers: {} }, {}, () => {
        setAuthContext({
          tenantId,
          userId: "integration:fixture",
          role: "webchat_integration",
          ...overrides,
        });
        Promise.resolve().then(fn).then(resolve, reject);
      }),
    );
  await prisma.serviceCategory.create({ data: { tenantId, name: "COOLING" } });
  const fresh = async (choice = "NOT_RECORDED") => {
    const session = await scoped(() => responses.start());
    if (choice !== "NOT_RECORDED") {
      await capture.capture({
        sessionToken: session.sessionToken,
        email: "fictional@example.invalid",
      });
      const prompt = await responses.prompt({
        sessionToken: session.sessionToken,
      });
      await responses.respond({
        sessionToken: session.sessionToken,
        promptToken: prompt.promptToken,
        response: choice,
        mailboxConfirmed: choice === "GRANTED",
      });
    }
    await intake.continueOrganization({
      sessionToken: session.sessionToken,
      interactionId: randomUUID(),
      message: "Do you repair heating?",
    });
    const draft = {
      customerName: "Fictional Admission Customer",
      phone: "+12025550173",
      address: "173 Fictional Lane",
      description: "Fictional service request",
      issueCategory: "COOLING",
      propertyType: "RESIDENTIAL",
      serviceIntent: "REPAIR",
    };
    const requestId = randomUUID();
    await intake.submitReview({
      sessionToken: session.sessionToken,
      requestId,
      expectedRevision: 1,
      draft,
      confirmed: true,
    });
    const review = await asOwner(() => operator.readReview({ requestId }));
    return {
      session,
      draft,
      input: {
        requestId,
        expectedOrganizationApprovedAt: review.organizationApprovedAt,
        review: {
          urgency: "STANDARD",
          reasonCode: "OPERATOR_REVIEWED_INTAKE",
          acknowledgeCustomerStatements: true,
        },
      },
    };
  };
  const counts = async () => ({
    jobs: await prisma.job.count(),
    addresses: await prisma.propertyAddress.count(),
    links: await prisma.conversationJobLink.count(),
    audit: await prisma.auditLog.count(),
    bindings: await prisma.appointmentEmailConsentBinding.count(),
  });
  const checks = [],
    baselineJobs = await prisma.job.count();
  const first = await fresh();
  const before = await counts();
  const [one, two] = await Promise.all([
    asOwner(() => operator.admitReview(first.input)),
    asOwner(() => operator.admitReview(first.input)),
  ]);
  assert.deepEqual(one, two);
  assert.equal(one.state, "ADMITTED");
  assert.equal(one.deliveryAuthorized, false);
  assert.equal(one.bookingAuthorized, false);
  const after = await counts();
  assert.equal(after.jobs, before.jobs + 1);
  assert.equal(after.addresses, before.addresses + 1);
  assert.equal(after.audit, before.audit + 1);
  assert.equal(after.links, before.links + 1);
  const job = await prisma.job.findUnique({ where: { id: one.jobId } });
  assert.equal(
    job.policySnapshot.intakeAdmission.requestId,
    first.input.requestId,
  );
  assert.equal(
    job.policySnapshot.intakeAdmission.organizationApprovedAt,
    first.input.expectedOrganizationApprovedAt,
  );
  assert.match(
    job.policySnapshot.intakeAdmission.organizationDigest,
    /^[0-9a-f]{64}$/,
  );
  assert.equal(
    job.policySnapshot.intakeAdmission.contactVerification,
    "NOT_VERIFIED",
  );
  assert.deepEqual(
    await asOwner(() =>
      new Intake(prisma, cipher, noCredentials, undefined, consent).admitReview(
        first.input,
      ),
    ),
    one,
  );
  assert.deepEqual(await counts(), after);
  await assert.rejects(
    intake.continueOrganization({
      sessionToken: first.session.sessionToken,
      interactionId: randomUUID(),
      message: "Another question",
    }),
  );
  await assert.rejects(
    asOwner(() =>
      operator.admitReview({
        ...first.input,
        review: { ...first.input.review, urgency: "HIGH" },
      }),
    ),
  );
  await assert.rejects(
    scoped(() => operator.admitReview(first.input), {
      role: "owner",
      userId: "different-owner",
    }),
  );
  checks.push(
    "concurrent exact operator admission creates one job; lost-ack/service-restart replay returns same receipt; changed actor/decision refuses",
  );
  checks.push(
    "request and organization binding persisted with job/audit/session close; no customer credential access",
  );
  for (const choice of ["DECLINED", "GRANTED"]) {
    const item = await fresh(choice);
    const receipt = await asOwner(() => operator.admitReview(item.input));
    assert.equal(receipt.consentEvidence, "BOUND");
    assert.equal(receipt.deliveryAuthorized, false);
    const stored = await prisma.job.findUnique({
      where: { id: receipt.jobId },
      include: { emailConsentBinding: true },
    });
    assert.ok(stored.emailConsentBinding);
    assert.equal(stored.policySnapshot.intakeAdmission.emailChoice, choice);
  }
  checks.push(
    "granted and declined histories bind atomically without becoming send permission; missing evidence remains NOT_RECORDED",
  );
  const failed = await fresh("GRANTED"),
    beforeFailed = await counts();
  const broken = new Intake(prisma, cipher, noCredentials, undefined, {
    bindJob: async () => {
      throw new Error("injected binding failure");
    },
  });
  await assert.rejects(asOwner(() => broken.admitReview(failed.input)));
  assert.deepEqual(await counts(), beforeFailed);
  assert.equal(
    (
      await asOwner(() =>
        operator.readReview({ requestId: failed.input.requestId }),
      )
    ).state,
    "PENDING_REVIEW",
  );
  checks.push(
    "binding failure rolls back job/address/link/audit/session outcome and leaves request reviewable",
  );
  const failAuditDb = new Proxy(prisma, {
    get(target, key) {
      if (key === "$transaction")
        return (fn, options) =>
          target.$transaction(
            (tx) =>
              fn(
                new Proxy(tx, {
                  get(t, k) {
                    return k === "auditLog"
                      ? {
                          create: async () => {
                            throw new Error("injected audit failure");
                          },
                        }
                      : Reflect.get(t, k);
                  },
                }),
              ),
            options,
          );
      return Reflect.get(target, key);
    },
  });
  await assert.rejects(
    asOwner(() =>
      new Intake(
        failAuditDb,
        cipher,
        noCredentials,
        undefined,
        consent,
      ).admitReview(failed.input),
    ),
  );
  assert.deepEqual(await counts(), beforeFailed);
  checks.push(
    "audit failure rolls back job and consent binding in real transaction",
  );
  for (const override of [
    { role: "technician", userId: "tech" },
    { role: "owner", userId: "other-owner", tenantId: otherTenantId },
  ])
    await assert.rejects(
      scoped(() => operator.admitReview(failed.input), override),
    );
  await assert.rejects(
    asOwner(() =>
      operator.admitReview({
        ...failed.input,
        sessionToken: failed.session.sessionToken,
      }),
    ),
  );
  assert.deepEqual(await counts(), beforeFailed);
  checks.push(
    "role, foreign tenant and customer-token injection refuse without writes",
  );
  const expired = await fresh();
  const event = await prisma.communicationContent.findUnique({
    where: {
      tenantId_communicationEventId: {
        tenantId,
        communicationEventId: expired.input.requestId,
      },
    },
  });
  await prisma.communicationContent.update({
    where: {
      tenantId_communicationEventId: {
        tenantId,
        communicationEventId: expired.input.requestId,
      },
    },
    data: { payload: { ...event.payload, expiresAt: Date.now() - 1 } },
  });
  const expiredBefore = await counts();
  await assert.rejects(asOwner(() => operator.admitReview(expired.input)));
  assert.deepEqual(await counts(), expiredBefore);
  checks.push("expired review cannot create a job");
  const old = await fresh();
  let state = await asOwner(() => organizationService.read());
  await asOwner(() =>
    organizationService.write(
      { expectedUpdatedAt: state.updatedAt, acknowledged: true },
      true,
    ),
  );
  const staleBefore = await counts();
  await assert.rejects(asOwner(() => operator.admitReview(old.input)));
  assert.deepEqual(await counts(), staleBefore);
  assert.equal(credentialAccesses, 0);
  assert.equal(await prisma.job.count(), baselineJobs + 3);
  checks.push(
    "new organization approval refuses old reviewed version without writes",
  );
  const audit = await prisma.auditLog.findMany({
    where: { action: "job.customer_intake_admitted", tenantId },
  });
  assert.ok(!JSON.stringify(audit).includes(first.draft.phone));
  assert.ok(!JSON.stringify(audit).includes(first.session.sessionToken));
  // P04 persistence-only proof: real reader/authority/database; verification
  // callbacks are explicitly injected. Not a live or full P03-provider proof.
  const {
    ControlledIntakeAuthority,
  } = require("../dist/communications/controlled-intake-authority.js");
  const tenant = await prisma.tenantOrganization.findUnique({
    where: { id: tenantId },
  });
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
  const payment = {
    version: 1,
    draft: paymentDraft,
    approved: {
      draft: paymentDraft,
      actorId: "fictional-owner",
      approvedAt: new Date().toISOString(),
    },
  };
  await prisma.tenantOrganization.update({
    where: { id: tenantId },
    data: {
      settings: { ...tenant.settings, organizationPaymentPolicyV1: payment },
    },
  });
  const organizationApproved =
    require("../dist/tenants/organization-profile.js").profile(
      tenant.settings.organizationProfileV1,
    ).approved;
  const paymentApproved =
    require("../dist/tenants/organization-payment-policy.js").profile(
      payment,
    ).approved;
  const category = await prisma.serviceCategory.findFirst({
    where: { tenantId, name: "COOLING" },
  });
  const hash = (value) =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const activation = {
    version: 1,
    enabled: true,
    tenantId,
    integrationId: "fixture",
    origin: "https://example.invalid",
    policyVersion: "p04-fixture",
    organizationApprovedAt: organizationApproved.approvedAt,
    organizationDigest: hash(organizationApproved),
    paymentApprovedAt: paymentApproved.approvedAt,
    paymentDigest: hash(paymentApproved),
    allowedServiceCategoryIds: [category.id],
    priorityPolicy: "AUTO_INTAKE_STANDARD_V1",
    validFrom: paymentApproved.approvedAt,
    validUntil: new Date(Date.now() + 60000).toISOString(),
    packetId: randomUUID(),
  };
  const controlled = new Intake(
    prisma,
    cipher,
    credentials,
    undefined,
    consent,
  );
  const authority = new ControlledIntakeAuthority(
    () => activation,
    (tx, scope) => controlled.readControlledCurrentState(tx, scope),
  );
  let failFinish = false,
    finishReached = false;
  const binding = {
    integrationId: "fixture",
    origin: "https://example.invalid",
    authority,
    capability: authority.issue(),
    verification: (reader) => ({
      run: async (input, consume) => ({
        status: "CONSUMED",
        value: await consume(
          (tx) =>
            reader(
              tx,
              credentials.verifySession(input.sessionToken),
              input.requestId,
            ).then(() => undefined),
          async () => {
            finishReached = true;
            if (failFinish) throw Error("fixture post-write expiry");
          },
        ),
      }),
    }),
  };
  const controlledInput = (fixture) => ({
    version: 2,
    confirmed: true,
    sessionToken: fixture.session.sessionToken,
    requestId: fixture.input.requestId,
    expectedRevision: 1,
    draft: {
      ...fixture.draft,
      address: "173 Fictional Lane, Example, OH 44101",
    },
    confirmedAddress: {
      street: "173 Fictional Lane",
      unit: "",
      city: "Example",
      postalCode: "44101",
    },
  });
  const cf = await fresh("GRANTED");
  const cs = controlledInput(cf),
    cb = await counts();
  const created = await controlled.submitControlled(cs, binding);
  assert.equal(created.status, "ADMITTED");
  assert.equal(created.paymentAuthorized, false);
  assert.equal(created.dispatchAuthorized, false);
  assert.equal(created.deliveryAuthorized, false);
  const cj = await prisma.job.findUnique({
    where: { id: created.jobId },
    include: { propertyAddress: true },
  });
  assert.equal(cj.urgency, "STANDARD");
  assert.equal(cj.propertyAddress.googlePlaceId, null);
  assert.equal(cj.propertyAddress.latitude, null);
  assert.equal(cj.propertyAddress.longitude, null);
  assert.equal(cj.policySnapshot.intakeAdmission.emailChoice, "GRANTED");
  const ca = await counts();
  assert.equal(ca.jobs, cb.jobs + 1);
  assert.equal(ca.bindings, cb.bindings + 1);
  const controlledAudit = await prisma.auditLog.findMany({
    where: { entityId: cj.id },
  });
  assert.equal(controlledAudit[0].actorType, "SYSTEM_AI");
  assert.equal(controlledAudit[0].actorId, "signmons-intake-admission-v1");
  for (const forbidden of [
    "humanReviewed",
    "OPERATOR_OVERRIDE",
    "currentProof",
    "county",
    "addressVerification",
    "fixtureOnly",
    cs.sessionToken,
  ])
    assert.ok(
      !JSON.stringify([cj.policySnapshot, controlledAudit]).includes(forbidden),
    );
  assert.deepEqual(
    Object.keys(cj.policySnapshot.intakeAdmission).sort(),
    [
      "version",
      "requestId",
      "submissionDigest",
      "transcriptRevision",
      "customerConfirmedAt",
      "actorId",
      "policyVersion",
      "organizationApprovedAt",
      "organizationDigest",
      "paymentApprovedAt",
      "paymentDigest",
      "priorityPolicy",
      "emailChoice",
    ].sort(),
  );
  const noProviderBinding = {
    ...binding,
    verification: () => {
      throw Error("Replay must not invoke verification");
    },
  };
  assert.deepEqual(
    await controlled.submitControlled(cs, noProviderBinding),
    created,
  );
  assert.deepEqual(
    await new Intake(
      prisma,
      cipher,
      credentials,
      undefined,
      consent,
    ).submitControlled(cs, noProviderBinding),
    created,
  );
  await assert.rejects(
    controlled.submitControlled(
      { ...cs, draft: { ...cs.draft, customerName: "Changed" } },
      noProviderBinding,
    ),
  );
  await assert.rejects(
    controlled.submitControlled(
      { ...cs, requestId: randomUUID() },
      noProviderBinding,
    ),
  );
  activation.enabled = false;
  await prisma.tenantOrganization.update({
    where: { id: tenantId },
    data: { settings: tenant.settings },
  });
  assert.deepEqual(
    await controlled.submitControlled(cs, noProviderBinding),
    created,
  );
  await prisma.tenantOrganization.update({
    where: { id: tenantId },
    data: {
      settings: { ...tenant.settings, organizationPaymentPolicyV1: payment },
    },
  });
  activation.enabled = true;
  assert.deepEqual(await counts(), ca);
  const raceFixture = controlledInput(await fresh());
  const raceBefore = await counts();
  const race = await Promise.allSettled([
    controlled.submitControlled(raceFixture, binding),
    controlled.submitControlled(raceFixture, binding),
  ]);
  assert.equal(race.filter((r) => r.status === "fulfilled").length, 2);
  assert.deepEqual(race[0].value, race[1].value);
  assert.equal((await counts()).jobs, raceBefore.jobs + 1);
  const lostInput = controlledInput(await fresh());
  const lostBefore = await counts();
  let acknowledgementLost = false;
  const lostPrisma = {
    $transaction: async (fn, ...args) => {
      const result = await prisma.$transaction(fn, ...args);
      if (!acknowledgementLost && result?.status === "ADMITTED") {
        acknowledgementLost = true;
        throw Error("fixture commit acknowledgement lost");
      }
      return result;
    },
  };
  const recovered = await new Intake(
    lostPrisma,
    cipher,
    credentials,
    undefined,
    consent,
  ).submitControlled(lostInput, binding);
  assert.equal(acknowledgementLost, true);
  assert.equal(recovered.status, "ADMITTED");
  assert.equal((await counts()).jobs, lostBefore.jobs + 1);
  assert.deepEqual(
    await controlled.submitControlled(lostInput, noProviderBinding),
    recovered,
  );
  for (const fault of ["audit", "consent", "finish"]) {
    const failedInput = controlledInput(await fresh("GRANTED"));
    const beforeFault = await counts();
    let faultReached = false;
    const faultPrisma = {
      $transaction: (fn, ...args) =>
        prisma.$transaction(
          (tx) =>
            fn(
              new Proxy(tx, {
                get(target, key) {
                  if (key === "auditLog" && fault === "audit")
                    return {
                      ...target.auditLog,
                      create: (args) => {
                        if (
                          args.data.action === "job.customer_intake_admitted"
                        ) {
                          faultReached = true;
                          throw Error("fixture audit failure");
                        }
                        return target.auditLog.create(args);
                      },
                    };
                  const v = target[key];
                  return typeof v === "function" ? v.bind(target) : v;
                },
              }),
            ),
          ...args,
        ),
    };
    const failureConsent =
      fault === "consent"
        ? {
            bindJob: async () => {
              faultReached = true;
              throw Error("fixture binding failure");
            },
          }
        : consent;
    const failingWriter = new Intake(
      faultPrisma,
      cipher,
      credentials,
      undefined,
      failureConsent,
    );
    failFinish = fault === "finish";
    finishReached = false;
    await assert.rejects(failingWriter.submitControlled(failedInput, binding));
    assert.ok(fault === "finish" ? finishReached : faultReached);
    assert.deepEqual(await counts(), beforeFault);
    const conversation = await prisma.conversation.findUnique({
      where: {
        id: credentials.verifySession(failedInput.sessionToken).conversationId,
      },
    });
    assert.equal(conversation.status, "ONGOING");
  }
  failFinish = false;
  checks.push(
    "P04 injected-verification writer: exact v2 record, SYSTEM_AI actor, granted-consent binding, one job and identical receipts under race; restart/exact replay without verification despite removed current policy; changed input refuses; audit/consent/post-write failure rollback",
  );
  await prisma.tenantOrganization.update({
    where: { id: tenantId },
    data: { settings: tenant.settings },
  });
  await writeFile(
    evidence + "/operator-admission-summary.json",
    JSON.stringify(
      {
        checks,
        credentialAccesses,
        newFictionalJobs: 6,
        providerCalls: 0,
        browserAdmission: false,
        identity: "fixture context; no production identity acceptance",
        bookingAuthorized: false,
        deliveryAuthorized: false,
      },
      null,
      2,
    ),
  );
  return checks;
}
