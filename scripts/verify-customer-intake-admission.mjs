// Local-only atomic admission proof. The parent owns and drops the disposable DB.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
const require = createRequire(import.meta.url);
const {
  CustomerIntakeContinuationService: Intake,
} = require("../dist/communications/customer-intake-continuation.service.js");
const {
  requestContextMiddleware,
  setAuthContext,
} = require("../dist/common/context/request-context.js");

export async function verifyCustomerIntakeAdmission({
  prisma,
  make,
  credentials,
  cipher,
  evidence,
  service,
  capture,
  tenantId,
  otherTenantId,
}) {
  const [db] = await prisma.$queryRawUnsafe(
    "SELECT current_database() AS name, inet_server_addr() AS address",
  );
  assert.match(db.name, /^calldesk_app013_intents_[0-9a-f]{12}$/);
  assert.equal(db.address, null);
  const checks = [];
  const category =
    (await prisma.serviceCategory.findFirst({
      where: { tenantId, name: "COOLING" },
    })) ??
    (await prisma.serviceCategory.create({
      data: { tenantId, name: "COOLING" },
    }));
  const intake = new Intake(
    prisma,
    cipher,
    credentials,
    { reply: async () => "Fictional reviewed intake reply." },
    evidence,
  );
  const asOperator = (fn, override = {}) =>
    new Promise((resolve, reject) => {
      requestContextMiddleware(
        { headers: { "x-request-id": randomUUID() } },
        {},
        () => {
          setAuthContext({
            tenantId: override.tenantId ?? tenantId,
            role: override.role ?? "dispatcher",
            userId: override.userId ?? "fixture-operator",
          });
          Promise.resolve().then(fn).then(resolve, reject);
        },
      );
    });
  const draft = {
    customerName: "Fictional Admission Customer",
    phone: "+12025550991",
    address: "991 Fictional Review Lane",
    description: "Fictional cooling system is not cooling.",
    issueCategory: "COOLING",
    propertyType: "RESIDENTIAL",
    serviceIntent: "REPAIR",
  };
  const request = (session, override = {}) => ({
    sessionToken: session.sessionToken,
    expectedRevision: 1,
    draft: { ...draft, phone: override.phone ?? draft.phone },
    review: {
      urgency: override.urgency ?? "HIGH",
      reasonCode: "OPERATOR_REVIEWED_INTAKE",
      acknowledgeCustomerStatements: true,
    },
  });
  const newSession = async () => {
    const session = await make(false);
    await intake.continue({
      sessionToken: session.sessionToken,
      interactionId: randomUUID(),
      message: "Fictional cooling intake statement.",
    });
    return session;
  };

  const firstSession = await newSession();
  const firstRequest = request(firstSession);
  const before = {
    payments: await prisma.payment.count(),
    calendar: await prisma.calendarOperation.count(),
    sms: await prisma.smsEnqueueIntent.count(),
    email: await prisma.appointmentEmailIntent.count(),
  };
  const receipt = await asOperator(() => intake.admitDraft(firstRequest));
  assert.deepEqual(receipt, {
    jobId: receipt.jobId,
    status: "CREATED",
    urgency: "HIGH",
    transcriptRevision: 1,
    humanReviewed: true,
    consentEvidence: "NOT_RECORDED",
    jobCreated: true,
    bookingAuthorized: false,
    deliveryAuthorized: false,
  });
  const job = await prisma.job.findUniqueOrThrow({
    where: { id: receipt.jobId },
    include: {
      customer: true,
      propertyAddress: true,
      serviceCategory: true,
      conversationLinks: true,
    },
  });
  assert.equal(job.intakeSessionId, firstSession.claims.sessionId);
  assert.equal(job.customer.fullName, draft.customerName);
  assert.equal(job.customer.phone, draft.phone);
  assert.equal(job.propertyAddress.formattedAddress, draft.address);
  assert.equal(job.serviceCategory.tenantId, category.tenantId);
  assert.equal(job.serviceCategory.name, "COOLING");
  assert.equal(job.description, draft.description);
  assert.equal(job.conversationLinks.length, 1);
  assert.equal(
    job.conversationLinks[0].conversationId,
    firstSession.claims.conversationId,
  );
  const conversation = await prisma.conversation.findUniqueOrThrow({
    where: { id: firstSession.claims.conversationId },
  });
  assert.equal(conversation.status, "COMPLETED");
  assert.equal(conversation.currentFSMState, "JOB_CREATED");
  await assert.rejects(
    capture.capture({
      sessionToken: firstSession.sessionToken,
      email: "AfterAdmission@example.invalid",
    }),
  );
  await assert.rejects(
    service.prompt({ sessionToken: firstSession.sessionToken }),
  );
  const audit = await prisma.auditLog.findFirstOrThrow({
    where: { entityId: job.id, action: "job.customer_intake_admitted" },
  });
  assert.equal(audit.actorType, "USER");
  assert.equal(audit.actorId, "fixture-operator");
  assert.ok(!JSON.stringify(audit.metadata).includes(draft.customerName));
  assert.ok(!JSON.stringify(audit.metadata).includes(draft.phone));
  assert.ok(!JSON.stringify(audit.metadata).includes(draft.address));
  assert.ok(!JSON.stringify(job.policySnapshot).includes(draft.phone));
  assert.deepEqual(
    {
      payments: await prisma.payment.count(),
      calendar: await prisma.calendarOperation.count(),
      sms: await prisma.smsEnqueueIntent.count(),
      email: await prisma.appointmentEmailIntent.count(),
    },
    before,
  );
  checks.push(
    "reviewed draft atomically creates exact tenant job/customer/address/link/audit and closes session",
    "admission exposes no booking/delivery authority and creates no payment, Calendar, SMS or email work",
    "audit and policy binding omit customer name, phone and address",
    "closed admitted session refuses later email capture or consent prompt",
  );

  const counts = async () => ({
    jobs: await prisma.job.count({
      where: { intakeSessionId: firstSession.claims.sessionId },
    }),
    links: await prisma.conversationJobLink.count({
      where: { conversationId: firstSession.claims.conversationId },
    }),
    audits: await prisma.auditLog.count({
      where: { entityId: job.id, action: "job.customer_intake_admitted" },
    }),
  });
  const admittedCounts = await counts();
  assert.deepEqual(
    await asOperator(() => intake.admitDraft(firstRequest)),
    receipt,
  );
  assert.deepEqual(await counts(), admittedCounts);
  await assert.rejects(
    asOperator(() =>
      intake.admitDraft(request(firstSession, { urgency: "STANDARD" })),
    ),
  );
  assert.deepEqual(await counts(), admittedCounts);
  checks.push(
    "exact lost-ack replay is idempotent; changed review cannot adopt the job",
  );

  const concurrentSession = await newSession();
  const concurrentRequest = request(concurrentSession, {
    phone: "+12025550992",
  });
  const concurrent = await Promise.all([
    asOperator(() => intake.admitDraft(concurrentRequest)),
    asOperator(() => intake.admitDraft(concurrentRequest)),
  ]);
  assert.deepEqual(concurrent[0], concurrent[1]);
  assert.equal(
    await prisma.job.count({
      where: { intakeSessionId: concurrentSession.claims.sessionId },
    }),
    1,
  );
  assert.equal(
    await prisma.auditLog.count({
      where: {
        entityId: concurrent[0].jobId,
        action: "job.customer_intake_admitted",
      },
    }),
    1,
  );
  checks.push(
    "concurrent identical admission serializes to one job, link and review audit",
  );

  const consentSession = await make(true);
  const prompt = await service.prompt({
    sessionToken: consentSession.sessionToken,
  });
  await service.respond({
    sessionToken: consentSession.sessionToken,
    promptToken: prompt.promptToken,
    response: "DECLINED",
    mailboxConfirmed: false,
  });
  await intake.continue({
    sessionToken: consentSession.sessionToken,
    interactionId: randomUUID(),
    message: "Fictional declined-email intake statement.",
  });
  const consentReceipt = await asOperator(() =>
    intake.admitDraft(
      request(consentSession, { phone: "+12025550993", urgency: "STANDARD" }),
    ),
  );
  assert.equal(consentReceipt.consentEvidence, "BOUND");
  const binding = await prisma.appointmentEmailConsentBinding.findUniqueOrThrow(
    {
      where: { jobId: consentReceipt.jobId },
      include: { scope: { include: { evidence: true } } },
    },
  );
  assert.equal(
    binding.scope.conversationId,
    consentSession.claims.conversationId,
  );
  assert.equal(binding.scope.evidence.at(-1).decision, "DECLINED");
  checks.push(
    "existing grant/decline ledger association binds atomically without becoming delivery authority",
  );

  const rollbackSession = await make(true);
  const rollbackPrompt = await service.prompt({
    sessionToken: rollbackSession.sessionToken,
  });
  await service.respond({
    sessionToken: rollbackSession.sessionToken,
    promptToken: rollbackPrompt.promptToken,
    response: "GRANTED",
    mailboxConfirmed: true,
  });
  const broken = new Intake(
    prisma,
    cipher,
    credentials,
    { reply: async () => "Fictional reviewed intake reply." },
    {
      bindJob: async (tx, input) => {
        await evidence.bindJob(tx, input);
        throw new Error("PRIVATE_BINDING_FAILURE");
      },
    },
  );
  await broken.continue({
    sessionToken: rollbackSession.sessionToken,
    interactionId: randomUUID(),
    message: "Fictional rollback intake statement.",
  });
  await assert.rejects(
    asOperator(() =>
      broken.admitDraft(request(rollbackSession, { phone: "+12025550994" })),
    ),
    /outcome is unconfirmed/,
  );
  assert.equal(
    await prisma.job.count({
      where: { intakeSessionId: rollbackSession.claims.sessionId },
    }),
    0,
  );
  assert.equal(
    await prisma.conversationJobLink.count({
      where: { conversationId: rollbackSession.claims.conversationId },
    }),
    0,
  );
  assert.equal(
    (
      await prisma.conversation.findUniqueOrThrow({
        where: { id: rollbackSession.claims.conversationId },
      })
    ).status,
    "ONGOING",
  );
  assert.equal(
    await prisma.appointmentEmailConsentBinding.count({
      where: {
        scope: { conversationId: rollbackSession.claims.conversationId },
      },
    }),
    0,
  );
  checks.push(
    "binding failure rolls back job, link, audit, consent binding and session closure",
  );

  const refusedSession = await newSession();
  const refusedRequest = request(refusedSession, { phone: "+12025550995" });
  await assert.rejects(
    asOperator(() => intake.admitDraft(refusedRequest), { role: "tech" }),
  );
  await assert.rejects(
    asOperator(() => intake.admitDraft(refusedRequest), {
      tenantId: otherTenantId,
    }),
  );
  await assert.rejects(
    asOperator(() =>
      intake.admitDraft({
        ...refusedRequest,
        expectedRevision: 2,
      }),
    ),
  );
  await assert.rejects(
    asOperator(() =>
      intake.admitDraft({
        ...refusedRequest,
        draft: { ...refusedRequest.draft, issueCategory: "BOILER" },
      }),
    ),
  );
  assert.equal(
    await prisma.job.count({
      where: { intakeSessionId: refusedSession.claims.sessionId },
    }),
    0,
  );
  checks.push(
    "role, tenant, transcript and unsupported tenant-category refusals leave no job",
  );

  const out =
    process.env.CUSTOMER_INTAKE_ADMISSION_EVIDENCE_DIR ??
    join(process.cwd(), "evidence/APP-013/customer-intake-admission");
  await mkdir(out, { recursive: true });
  await writeFile(
    join(out, "summary.json"),
    JSON.stringify(
      {
        result: "PASS",
        checks,
        checkCount: checks.length,
        providerCalls: 0,
        productionActions: 0,
        newMigrations: 0,
        jobStatus: "CREATED",
        bookingAuthorized: false,
        deliveryAuthorized: false,
        limits: [
          "Unregistered local service; no production controller, module or browser admission route",
          "Customer statements and address/contact remain unverified; human-reviewed urgency only",
          "No preferred window, Calendar, payment, dispatch, notification, provider or sending action",
        ],
      },
      null,
      2,
    ) + "\n",
  );
  return checks;
}
