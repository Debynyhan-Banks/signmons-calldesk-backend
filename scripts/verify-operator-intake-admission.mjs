// Requires the parent verifier's disposable local database; never accepts a URL.
import assert from "node:assert/strict";
import { randomUUID, createHmac, createHash } from "node:crypto";
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { verifyControlledIntakeConnectedBrowser } from "./verify-controlled-intake-connected-browser.mjs";
import { verifyControlledRuntime } from "./verify-controlled-runtime.mjs";
const require = createRequire(import.meta.url);
const { DedicatedEmailConsentFingerprint } = require("../dist/communications/email-consent-fingerprint.js");
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
  browser,
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
  const consent = new Evidence(cipher, new DedicatedEmailConsentFingerprint({key:Buffer.alloc(32,6),keyVersion:"synthetic-v1"}));
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
        setAuthContext(
          {
            tenantId,
            userId: "integration:fixture",
            role: "webchat_integration",
            ...overrides,
          },
          overrides.impersonatedTenantId,
        );
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
  await verifyControlledRuntime({prisma,cipher,activation,scoped,browser,evidence});
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
  const recoveryCounts = await counts();
  for (const role of ["owner", "admin", "dispatcher"]) {
    assert.deepEqual(
      await scoped(
        () => operator.readControlledReceipt({ requestId: cs.requestId }),
        { role, userId: "fictional-staff" },
      ),
      created,
    );
  }
  // Credentials are unavailable to this operator instance. Separately prove the
  // original customer token refuses at its exact expiry; recovery does not renew it.
  const originalClaims = credentials.verifySession(cs.sessionToken);
  assert.throws(() =>
    credentials.verifySession(cs.sessionToken, originalClaims.expiresAt),
  );
  assert.deepEqual(
    await asOwner(() =>
      operator.readControlledReceipt({ requestId: cs.requestId }),
    ),
    created,
  );
  for (const override of [
    { role: "technician" },
    { role: "webchat_integration" },
    { role: "owner", tenantId: otherTenantId },
    { role: "owner", impersonatedTenantId: tenantId },
  ]) {
    await assert.rejects(
      scoped(
        () => operator.readControlledReceipt({ requestId: cs.requestId }),
        override,
      ),
    );
  }
  await assert.rejects(
    asOwner(() => operator.readControlledReceipt({ requestId: randomUUID() })),
  );
  await assert.rejects(
    asOwner(() =>
      operator.readControlledReceipt({
        requestId: cs.requestId,
        sessionToken: cs.sessionToken,
      }),
    ),
  );
  const originalPolicy = cj.policySnapshot;
  await prisma.job.update({
    where: { id: cj.id },
    data: {
      policySnapshot: {
        ...originalPolicy,
        intakeAdmission: {
          ...originalPolicy.intakeAdmission,
          actorId: "fake-operator",
        },
      },
    },
  });
  await assert.rejects(
    asOwner(() => operator.readControlledReceipt({ requestId: cs.requestId })),
  );
  await prisma.job.update({
    where: { id: cj.id },
    data: { policySnapshot: originalPolicy },
  });
  assert.equal(credentialAccesses, 0);
  assert.deepEqual(await counts(), recoveryCounts);
  checks.push(
    "P04 operator receipt recovery: owner/admin/dispatcher only, no customer credential access, exact expiry refusal, foreign/impersonated/extra-token/malformed/missing refusal, no writes or providers",
  );
  checks.push(
    "P04 injected-verification writer: exact v2 record, SYSTEM_AI actor, granted-consent binding, one job and identical receipts under race; restart/exact replay without verification despite removed current policy; changed input refuses; audit/consent/post-write failure rollback",
  );
  // Final P04 connection: real service/ledger/reader/writer stack. Only external
  // SDK/fetch responses and local fixture pricing are synthetic; no positive
  // verification callback is substituted.
  const {
    DurableVerificationService,
  } = require("../dist/communications/durable-verification.service.js");
  const {
    TwilioVerifyAdapter,
  } = require("../dist/communications/twilio-verify.adapter.js");
  const {
    ControlledCustomerAdmission, controlledCustomerAdmissionDigest,
  } = require("../dist/communications/controlled-customer-admission.js");
  const {
    GoogleAddressOAuthTransport,
  } = require("../dist/communications/google-address-oauth.transport.js");
  const {
    ControlledIntakeComposition,
  } = require("../dist/communications/controlled-intake-composition.js");
  let connectedJobs = 0,
    syntheticPhoneCalls = 0,
    syntheticAddressCalls = 0;
  const connectedConversationIds = [];
  for (const scenario of [
    "missing-phone",
    "accepted",
    "outside",
    "unknown",
    "revoked",
    "browser-accepted-390",
    "browser-accepted-1440",
    "browser-outside-390",
    "browser-unknown-1440",
    "browser-outside-1440",
    "browser-unknown-390",
    "browser-correction-390",
    "browser-correction-1440",
  ]) {
    const browserCase = scenario.startsWith("browser-");
    const mode = browserCase ? scenario.split("-")[1] : scenario;
    const fixture = await fresh();
    // Browser cases use a new genuine, empty conversation; no fabricated transcript.
    if (browserCase) fixture.session = await scoped(() => responses.start());
    const connectedInput = controlledInput(fixture);
    const connectedScope = credentials.verifySession(
      connectedInput.sessionToken,
    );
    connectedConversationIds.push(connectedScope.conversationId);
    const phone = connectedInput.draft.phone,
      accountSid = "AC" + "a".repeat(32),
      serviceSid = "VA" + "b".repeat(32);
    const raw = (status) => ({
      status,
      accountSid,
      serviceSid,
      sid: "VE" + "c".repeat(32),
      to: phone,
      channel: "sms",
    });
    const adapter = new TwilioVerifyAdapter(
      { tenantId, accountSid, serviceSid },
      () => ({
        verify: {
          v2: {
            services: () => ({
              verifications: {
                create: async () => {
                  syntheticPhoneCalls++;
                  return raw("pending");
                },
              },
              verificationChecks: {
                create: async () => {
                  syntheticPhoneCalls++;
                  return raw("approved");
                },
              },
            }),
          },
        },
      }),
    );
    const phonePolicy = {
      packetId: randomUUID(), accountSid, serviceSid,
      tenantId,
      participantHmac: createHmac("sha256", Buffer.alloc(32, 8)).update(phone).digest("hex"),
      noticeVersion: "local-p04",
      rateVersion: "not-a-real-rate",
      startsAt: Date.now()-1000, expiresAt: Date.now()+60000,
      flowUpperBoundMicros: 10, accountCeilingMicros: 200,
    };
    const currentTenant = await prisma.tenantOrganization.findUniqueOrThrow({where:{id:tenantId}});
    await prisma.tenantOrganization.update({where:{id:tenantId},data:{settings:{...currentTenant.settings,controlledPhoneApproval:{enabled:true,digest:controlledCustomerAdmissionDigest(phonePolicy)}}}});
    const phoneBudget = new ControlledCustomerAdmission(phonePolicy);
    const durable = new DurableVerificationService(
      prisma,
      cipher,
      credentials,
      Buffer.alloc(32, 8),
      adapter,
      phoneBudget,
      undefined,
      async () => ({
        mode: "CONTROLLED_VERIFY_V1",
        version: "local-p04",
        accountSid,
        serviceSid,
        noticeVersion: "local-p04",
        businessPolicyVersion: organizationApproved.approvedAt,
        lifetimeMs: 1800000,
      }),
    );
    if (mode !== "missing-phone") {
      const start = {
        sessionToken: connectedInput.sessionToken,
        operationId: randomUUID(),
        kind: "START",
        phone,
        code: "",
        startOperationId: "",
      };
      await durable.execute(start, {
        requested: true,
        noticeVersion: "local-p04",
      });
      await durable.execute({
        ...start,
        operationId: randomUUID(),
        kind: "CHECK",
        code: "123456",
        startOperationId: start.operationId,
      });
    }
    const addressAccount = randomUUID();
    const addressPolicy = {
      mode: "CONTROLLED_ADDRESS_V1",
      execution: "CONTROLLED_8S_2_ATTEMPTS",
      approved: true,
      version: "local-p04",
      rateVersion: "not-a-real-rate",
      validUntil: Date.now() + 60000,
      costMicros: 10,
      account: { micros: 100, requests: 10 },
      tenant: { micros: 100, requests: 10 },
      session: { micros: 20, requests: 2 },
    };
    let sequenceCalls = 0;
    const transport = new GoogleAddressOAuthTransport(true, {
      token: async () => "synthetic-token",
      fetch: async (_url, options) => {
        const request = JSON.parse(options.body);
        assert.equal(request.previousResponseId, sequenceCalls++ === 0 ? undefined : "11111111-1111-4111-8111-111111111111");
        syntheticAddressCalls++;
        if (mode === "unknown") throw Error("synthetic transport uncertainty");
        if (mode === "revoked") activation.enabled = false;
        return new Response(
          JSON.stringify({
            responseId: "11111111-1111-4111-8111-111111111111",
            result: {
              verdict: {
                addressComplete: true,
                validationGranularity: "PREMISE",
              },
              address: {
                postalAddress: {
                  regionCode: "US",
                  administrativeArea: "OH",
                  locality: "Example",
                  postalCode: "44101",
                  addressLines: [
                    mode === "correction"
                      ? "174 Fictional Lane"
                      : "173 Fictional Lane",
                  ],
                },
                addressComponents: Object.entries({
                  street_number: mode === "correction" ? "174" : "173",
                  route: "Fictional Lane",
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
              uspsData: {
                dpvConfirmation: "Y",
                dpvCmra: "N",
                addressRecordType: "H",
                fipsCountyCode: mode === "outside" ? "093" : "035",
                county: mode === "outside" ? "Lorain" : "Cuyahoga",
              },
              metadata: { poBox: false },
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    });
    const composition = new ControlledIntakeComposition({
      prisma,
      credentials,
      intake: controlled,
      tenantId,
      integrationId: binding.integrationId,
      origin: binding.origin,
      authority,
      capability: binding.capability,
      phone: durable,
      transport,
      addressAccountId: addressAccount,
      readAddressPolicy: async (_tx, loaded) => {
        assert.equal(loaded.authorityScope.serviceCategoryId, category.id);
        return addressPolicy;
      },
    });
    const priorJobs = await prisma.job.count(),
      priorCalls = syntheticAddressCalls;
    if (mode === "missing-phone") {
      await assert.rejects(composition.submit(connectedInput));
      assert.equal(syntheticAddressCalls, priorCalls);
    } else if (mode === "revoked") {
      const outcome = await composition
        .submit(connectedInput)
        .catch(() => null);
      assert.notEqual(outcome?.status, "ADMITTED");
      activation.enabled = true;
    } else {
      const outcome = browserCase
        ? await verifyControlledIntakeConnectedBrowser({
            browser,
            prisma,
            credentials,
            session: fixture.session,
            tenantId,
            intake,
            responses,
            capture,
            composition,
            mode,
            width: Number(scenario.split("-")[2]),
            evidence,
          })
        : await composition.submit(connectedInput);
      if (mode === "accepted" || mode === "correction") {
        assert.equal(outcome.status, "ADMITTED");
        connectedJobs++;
        const calls = [syntheticPhoneCalls, syntheticAddressCalls];
        if (!browserCase)
          assert.deepEqual(await composition.submit(connectedInput), outcome);
        assert.deepEqual([syntheticPhoneCalls, syntheticAddressCalls], calls);
        const stored = await prisma.job.findUnique({
          where: { id: outcome.jobId },
        });
        const audits = await prisma.auditLog.findMany({
          where: { entityId: outcome.jobId },
        });
        for (const forbidden of [
          "11111111-1111-4111-8111-111111111111",
          "fipsCountyCode",
          "Cuyahoga",
          "currentProof",
          "fixtureOnly",
          "addressVerification",
        ])
          assert.ok(
            !JSON.stringify([stored.policySnapshot, audits]).includes(
              forbidden,
            ),
          );
      } else assert.equal(outcome.jobCreated, false);
    }
    assert.equal(
      await prisma.job.count(),
      priorJobs + (["accepted", "correction"].includes(mode) ? 1 : 0),
    );
    if (mode !== "missing-phone") {
      const operations = await prisma.addressVerificationOperation.findMany({
        where: { accountId: addressAccount },
      });
      assert.equal(operations.length, mode === "correction" ? 2 : 1);
      assert.ok(
        operations.every(
          (op) => op.heldMicros === 10n && op.state !== "CANCELLED",
        ),
      );
      assert.ok(
        !JSON.stringify(operations, (_key, value) =>
          typeof value === "bigint" ? value.toString() : value,
        ).includes("11111111-1111-4111-8111-111111111111"),
      );
    }
  }
  assert.equal(syntheticPhoneCalls, 24);
  assert.equal(syntheticAddressCalls, 14);
  const phoneLiabilities = await prisma.auditLog.findMany({
    where: {
      tenantId,
      entityId: { in: connectedConversationIds },
      action: "conversation.controlled_phone_held",
    },
  });
  assert.equal(phoneLiabilities.length, 12);
  assert.ok(
    phoneLiabilities.every((row) => row.metadata.reservedMicros === 10),
  );
  // Controlled holds remain intact until the parent drops its disposable database.
  checks.push(
    "P04/P05 actual ControlledIntakeComposition connects durable phone+budget, address ledger/transport, verification, current reader and writer: accepted one job, provider-free replay, missing phone/outside/unknown/revocation no job; held liability retained; synthetic external SDK/fetch only",
    "P05 connected existing page through HTTP mount and real transport/services/database: accepted with post-commit acknowledgment failure and exact retry, outside refusal, uncertain transport, explicit correction then admission at 390/1440; no added calls on replay, no browser storage, reload clears and no false booking",
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
        newFictionalJobs: 6 + connectedJobs,
        syntheticPhoneCalls,
        syntheticAddressCalls,
        providerCalls: 0,
        browserAdmission: true,
        connectedBrowserScenarios: 8,
        liveBrowserAcceptance: false,
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
