import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const require = createRequire(import.meta.url);
const {
  CustomerIntakeContinuationService: Intake,
} = require("../dist/communications/customer-intake-continuation.service.js");
const {
  requestContextMiddleware,
  setAuthContext,
} = require("../dist/common/context/request-context.js");
export async function verifyCustomerIntakeReviewRequest({
  prisma,
  make,
  credentials,
  cipher,
  tenantId,
  otherTenantId,
}) {
  const [db] = await prisma.$queryRawUnsafe(
    "SELECT current_database() AS name, inet_server_addr() AS address",
  );
  assert.match(db.name, /^calldesk_app013_intents_[0-9a-f]{12}$/);
  assert.equal(db.address, null);
  const checks = [];
  const asOperator = (fn, overrides = {}) =>
    new Promise((resolve, reject) =>
      requestContextMiddleware({ headers: {} }, {}, () => {
        setAuthContext({
          tenantId,
          role: "dispatcher",
          userId: "fictional-reviewer",
          ...overrides,
        });
        Promise.resolve().then(fn).then(resolve, reject);
      }),
    );
  const intake = new Intake(prisma, cipher, credentials, {
    reply: async () => "Fictional private reply.",
  });
  const draft = {
    customerName: "Private Review Customer",
    phone: "+12025550981",
    address: "981 Fictional Lane",
    description: "Fictional cooling issue.",
    issueCategory: "COOLING",
    propertyType: "RESIDENTIAL",
    serviceIntent: "REPAIR",
  };
  const snapshot = async () => ({
    jobs: await prisma.job.findMany({ orderBy: { id: "asc" } }),
    intents: await prisma.appointmentEmailIntent.findMany({
      orderBy: { id: "asc" },
    }),
    bindings: await prisma.appointmentEmailConsentBinding.findMany({
      orderBy: { scopeId: "asc" },
    }),
    consent: await prisma.appointmentEmailConsentEvidence.findMany({
      orderBy: { id: "asc" },
    }),
  });
  const baseline = await snapshot();
  const fresh = async () => {
    const session = await make(false);
    await intake.continue({
      sessionToken: session.sessionToken,
      interactionId: randomUUID(),
      message: "Fictional review request issue.",
    });
    return {
      session,
      request: {
        sessionToken: session.sessionToken,
        requestId: randomUUID(),
        expectedRevision: 1,
        draft,
        confirmed: true,
      },
    };
  };
  const a = await fresh(),
    receipt = await intake.submitReview(a.request);
  const stored = await prisma.communicationEvent.findUnique({
    where: { id: a.request.requestId },
    include: { content: true },
  });
  assert.equal(receipt.state, "PENDING_REVIEW");
  assert.equal(receipt.jobCreated, false);
  assert.equal(receipt.deliveryAuthorized, false);
  assert.equal(
    stored.content.payload.expiresAt,
    credentials.verifySession(a.session.sessionToken).expiresAt,
  );
  assert.deepEqual(
    JSON.parse(cipher.decrypt(stored.content.payload.encryptedDraft)),
    draft,
  );
  assert.ok(!JSON.stringify(stored).includes(a.session.sessionToken));
  assert.ok(!JSON.stringify(stored).includes(draft.phone));
  const audit = () =>
    prisma.auditLog.findMany({
      where: {
        entityId: a.session.claims.conversationId,
        action: "conversation.intake_review_requested",
      },
    });
  assert.equal((await audit()).length, 1);
  assert.ok(!JSON.stringify(await audit()).includes(draft.customerName));
  checks.push(
    "customer submission commits one encrypted draft/event/audit with original expiry and no bearer storage",
  );
  assert.deepEqual(
    await new Intake(prisma, cipher, credentials).submitReview(a.request),
    receipt,
  );
  assert.equal((await audit()).length, 1);
  await assert.rejects(
    intake.submitReview({
      ...a.request,
      draft: { ...draft, description: "Changed" },
    }),
  );
  await assert.rejects(
    intake.submitReview({ ...a.request, requestId: randomUUID() }),
  );
  checks.push(
    "fresh-instance exact replay preserves one request/audit; replacement or second request refuses",
  );
  const noCredentials = new Proxy(credentials, {
    get() {
      throw Error("Operator must not use customer credentials");
    },
  });
  const operator = new Intake(prisma, cipher, noCredentials);
  const review = await asOperator(() =>
    operator.readReview({ requestId: receipt.requestId }),
  );
  assert.deepEqual(review.draft, draft);
  assert.equal(review.urgencyAssessment, "NOT_PERFORMED");
  assert.ok(!JSON.stringify(review).includes(a.session.claims.sessionId));
  assert.ok(!JSON.stringify(review).includes(a.session.sessionToken));
  assert.deepEqual(await snapshot(), baseline);
  checks.push(
    "operator reads by request ID with own verified identity and zero access to any customer credential method",
  );
  for (const role of ["technician", "customer", "webchat_integration"])
    await assert.rejects(
      asOperator(() => operator.readReview({ requestId: receipt.requestId }), {
        role,
      }),
    );
  await assert.rejects(
    asOperator(() => operator.readReview({ requestId: receipt.requestId }), {
      tenantId: otherTenantId,
    }),
  );
  await assert.rejects(
    asOperator(() =>
      operator.readReview({
        requestId: receipt.requestId,
        sessionToken: a.session.sessionToken,
      }),
    ),
  );
  checks.push(
    "wrong role/tenant and customer bearer in operator DTO refuse without job or consent mutation",
  );
  const b = await fresh();
  const both = await Promise.all([
    intake.submitReview(b.request),
    intake.submitReview(b.request),
  ]);
  assert.deepEqual(both[0], both[1]);
  assert.equal(
    await prisma.auditLog.count({
      where: {
        entityId: b.session.claims.conversationId,
        action: "conversation.intake_review_requested",
      },
    }),
    1,
  );
  checks.push(
    "concurrent identical submissions serialize to one durable request and receipt",
  );
  const c = await fresh();
  const broken = {
    $transaction: (fn, options) =>
      prisma.$transaction(
        (tx) =>
          fn(
            new Proxy(tx, {
              get(target, prop) {
                if (prop === "auditLog")
                  return {
                    create: async (data) => {
                      await target.auditLog.create(data);
                      throw Error("PRIVATE_FAILURE");
                    },
                  };
                return target[prop];
              },
            }),
          ),
        options,
      ),
  };
  await assert.rejects(
    new Intake(broken, cipher, credentials).submitReview(c.request),
    /unconfirmed/,
  );
  assert.equal(
    await prisma.communicationEvent.count({
      where: { id: c.request.requestId },
    }),
    0,
  );
  assert.equal(
    await prisma.auditLog.count({
      where: {
        entityId: c.session.claims.conversationId,
        action: "conversation.intake_review_requested",
      },
    }),
    0,
  );
  checks.push(
    "failure after actual encrypted content/event/audit writes rolls back submission atomically",
  );
  const d = await fresh();
  const lost = {
    $transaction: async (fn, options) => {
      await prisma.$transaction(fn, options);
      throw Error("LOST_ACK");
    },
  };
  await assert.rejects(
    new Intake(lost, cipher, credentials).submitReview(d.request),
    /unconfirmed/,
  );
  assert.equal(
    (await intake.submitReview(d.request)).requestId,
    d.request.requestId,
  );
  checks.push(
    "lost post-commit acknowledgment recovers only through original exact customer request",
  );
  await intake.continue({
    sessionToken: a.session.sessionToken,
    interactionId: randomUUID(),
    message: "Newer fictional details.",
  });
  await assert.rejects(
    asOperator(() => operator.readReview({ requestId: receipt.requestId })),
    /changed/,
  );
  checks.push(
    "new transcript invalidates pending review rather than silently reviewing stale statements",
  );
  const oldNow = Date.now;
  try {
    Date.now = () => oldNow() + 900001;
    await assert.rejects(
      asOperator(() => operator.readReview({ requestId: d.request.requestId })),
      /changed/,
    );
  } finally {
    Date.now = oldNow;
  }
  checks.push(
    "operator review expires with original session deadline without renewing or reconstructing a bearer",
  );
  await prisma.conversation.update({
    where: { id: d.session.claims.conversationId },
    data: { status: "COMPLETED" },
  });
  await assert.rejects(
    asOperator(() => operator.readReview({ requestId: d.request.requestId })),
    /changed/,
  );
  assert.deepEqual(await snapshot(), baseline);
  checks.push(
    "closed-session refusal and unchanged jobs/consent/bindings/intents; no admission or delivery authority",
  );
  const out =
    process.env.CUSTOMER_INTAKE_REVIEW_EVIDENCE_DIR ??
    join(process.cwd(), "evidence/APP-013/customer-intake-review-request");
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
        jobCreated: false,
        bookingAuthorized: false,
        deliveryAuthorized: false,
        limits: [
          "Inactive submit/read foundation only; no operator admission or browser/UI integration",
          "Expires at original session deadline; no renewal, replacement or withdrawal flow",
          "Application serialization, not new database immutability/retention constraints",
        ],
      },
      null,
      2,
    ) + "\n",
  );
}
