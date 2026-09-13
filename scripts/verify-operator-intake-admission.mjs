// Requires the parent verifier's disposable local database; never accepts a URL.
import assert from "node:assert/strict";
import { randomUUID, createHmac } from "node:crypto";
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
  await writeFile(
    evidence + "/operator-admission-summary.json",
    JSON.stringify(
      {
        checks,
        credentialAccesses,
        newFictionalJobs: 3,
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
