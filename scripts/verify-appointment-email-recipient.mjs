// Only called inside the parent-owned disposable Unix-socket PostgreSQL fixture.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);

export async function verifyAppointmentEmailRecipient({
  prisma,
  jobData,
  otherTenantId,
}) {
  const [db] = await prisma.$queryRawUnsafe(
    "SELECT current_database() AS name, inet_server_addr() AS address",
  );
  assert.match(db.name, /^calldesk_app013_intents_[0-9a-f]{12}$/);
  assert.equal(db.address, null);
  const {
    AppointmentEmailRecipientService,
  } = require("../dist/communications/appointment-email-recipient.service.js");
  const {
    ConversationsService,
  } = require("../dist/conversations/conversations.service.js");
  const {
    ConversationEmailService,
  } = require("../dist/conversations/conversation-email.service.js");
  const {
    ConversationMemoryCipher,
  } = require("../dist/logging/conversation-memory-cipher.service.js");
  const {
    SanitizationService,
  } = require("../dist/sanitization/sanitization.service.js");
  const {
    requestContextMiddleware,
    setAuthContext,
  } = require("../dist/common/context/request-context.js");
  const tenantId = jobData.tenantId;
  const cipher = new ConversationMemoryCipher({
    conversationDataEncryptionKey: "2".repeat(64),
  });
  const conversations = new ConversationsService(
    prisma,
    new SanitizationService(),
  );
  const capture = new ConversationEmailService(prisma, cipher);
  const reader = new AppointmentEmailRecipientService(prisma, cipher);
  const sessionId = randomUUID();
  const conversation = await conversations.ensureConversation(
    tenantId,
    sessionId,
  );
  await capture.observe(
    { tenantId, sessionId, conversationId: conversation.id },
    "Recipient@example.invalid",
  );
  const saved = await prisma.conversation.findUniqueOrThrow({
    where: { id: conversation.id },
  });
  const initial = {
    ...jobData,
    intakeSessionId: sessionId,
    calendarEventId: "synthetic-calendar-event",
    serviceWindowStart: new Date("2038-01-10T14:00:00.000Z"),
    serviceWindowEnd: new Date("2038-01-10T16:00:00.000Z"),
  };
  let job = await prisma.job.create({ data: initial });
  assert.notEqual(
    job.customerId,
    conversation.customerId,
    "Normal intake uses a placeholder customer",
  );
  const link = await prisma.conversationJobLink.create({
    data: {
      tenantId,
      jobId: job.id,
      jobTenantId: tenantId,
      conversationId: conversation.id,
      conversationTenantId: tenantId,
      relationType: "CREATED_FROM",
    },
  });
  const asActor = (fn, actorTenant = tenantId, role = "owner", impersonation) =>
    new Promise((resolve, reject) => {
      requestContextMiddleware({ headers: {} }, {}, () => {
        setAuthContext(
          { userId: "synthetic-reviewer", tenantId: actorTenant, role },
          impersonation,
        );
        Promise.resolve().then(fn).then(resolve, reject);
      });
    });
  const input = (kind = "confirmed") => ({
    jobId: job.id,
    kind,
    expectedJobUpdatedAt: job.updatedAt.toISOString(),
  });
  // Every invocation, including refusals, must leave retained business rows unchanged.
  const snapshot = async () => ({
    job: await prisma.job.findUnique({ where: { id: job.id } }),
    conversations: await prisma.conversation.findMany({
      where: { tenantId },
      orderBy: { id: "asc" },
    }),
    links: await prisma.conversationJobLink.findMany({
      where: { jobId: job.id },
      orderBy: { id: "asc" },
    }),
    audits: await prisma.auditLog.count(),
    events: await prisma.communicationEvent.count(),
    intents: await prisma.smsEnqueueIntent.count(),
    operations: await prisma.calendarOperation.count(),
  });
  let successfulReads = 0,
    refusedReads = 0;
  const check = async (fn, status) => {
    const before = await snapshot();
    if (status) {
      await assert.rejects(fn, (error) => {
        assert.equal(error.getStatus?.(), status);
        assert.doesNotMatch(
          error.message,
          /Recipient@|encryptedEmail|synthetic-calendar-event|SELECT|v1\./,
        );
        return true;
      });
      refusedReads++;
    } else {
      const result = await fn();
      assert.equal(result.recipient.email, "Recipient@example.invalid");
      assert.equal(result.recipient.source, "conversation_intake");
      assert.equal(result.recipient.ownershipVerified, false);
      assert.equal(result.deliveryAuthorized, false);
      assert.equal(result.snapshotOnly, true);
      assert.equal(result.sensitivity, "customer-private");
      assert.equal(result.tenantId, tenantId);
      assert.equal(result.jobUpdatedAt, job.updatedAt.toISOString());
      assert.doesNotMatch(
        JSON.stringify(result),
        /encryptedEmail|calendarEventId|collectedData|managementUrl/,
      );
      successfulReads++;
    }
    assert.deepEqual(await snapshot(), before);
  };
  const read = (kind) => asActor(() => reader.resolve(input(kind)));
  const patchJob = async (data) => {
    job = await prisma.job.update({ where: { id: job.id }, data });
  };
  await check(() => read());
  await check(() => read("rescheduled"));
  await check(() =>
    asActor(() =>
      reader.resolve({
        ...input(),
        tenantId: otherTenantId,
        email: "Wrong@example.invalid",
      }),
    ),
  );
  await check(() => asActor(() => reader.resolve(input()), tenantId, "admin"));
  await check(() => asActor(() => reader.resolve(input()), otherTenantId), 404);
  await check(
    () => asActor(() => reader.resolve(input()), tenantId, "tech"),
    403,
  );
  await check(
    () => asActor(() => reader.resolve(input()), tenantId, "admin", tenantId),
    403,
  );
  await check(() => reader.resolve(input()), 403);
  await check(
    () =>
      asActor(() =>
        reader.resolve({
          ...input(),
          expectedJobUpdatedAt: "2000-01-01T00:00:00.000Z",
        }),
      ),
    409,
  );
  for (const [delegate, id, data, restore, status] of [
    [
      prisma.tenantOrganization,
      tenantId,
      { status: "SUSPENDED" },
      { status: "ACTIVE" },
      404,
    ],
    [
      prisma.customer,
      job.customerId,
      { deletedAt: new Date() },
      { deletedAt: null },
      404,
    ],
    [
      prisma.customer,
      conversation.customerId,
      { deletedAt: new Date() },
      { deletedAt: null },
      409,
    ],
    [
      prisma.conversation,
      conversation.id,
      { deletedAt: new Date() },
      { deletedAt: null },
      409,
    ],
    [
      prisma.conversationJobLink,
      link.id,
      { tenantId: otherTenantId },
      { tenantId },
      409,
    ],
    [
      prisma.conversationJobLink,
      link.id,
      { relationType: "ABOUT" },
      { relationType: "CREATED_FROM" },
      409,
    ],
    [
      prisma.conversationJobLink,
      link.id,
      { relationType: "FOLLOW_UP" },
      { relationType: "CREATED_FROM" },
      409,
    ],
  ]) {
    await delegate.update({ where: { id }, data });
    await check(() => read(), status);
    await delegate.update({ where: { id }, data: restore });
  }
  for (const data of [
    { sessionId: "wrong", intakeEmail: saved.collectedData.intakeEmail },
    { sessionId },
    {
      sessionId,
      intakeEmail: { version: 1, status: "declined", askedAt: null },
    },
    {
      sessionId,
      intakeEmail: {
        ...saved.collectedData.intakeEmail,
        encryptedEmail: "bad",
      },
    },
    {
      sessionId,
      intakeEmail: { ...saved.collectedData.intakeEmail, version: 2 },
    },
  ]) {
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { collectedData: data },
    });
    await check(() => read(), 409);
  }
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { collectedData: saved.collectedData },
  });
  const wrongKey = new AppointmentEmailRecipientService(
    prisma,
    new ConversationMemoryCipher({
      conversationDataEncryptionKey: "3".repeat(64),
    }),
  );
  await check(() => asActor(() => wrongKey.resolve(input())), 409);
  const extraConversation = await conversations.ensureConversation(
    tenantId,
    randomUUID(),
  );
  const extra = await prisma.conversationJobLink.create({
    data: {
      tenantId,
      jobId: job.id,
      jobTenantId: tenantId,
      conversationId: extraConversation.id,
      conversationTenantId: tenantId,
      relationType: "ABOUT",
    },
  });
  await check(() => read()); // Non-origin associations are not candidates.
  await prisma.conversationJobLink.update({
    where: { id: extra.id },
    data: { relationType: "CREATED_FROM" },
  });
  await check(() => read(), 409); // Even an invalid second origin blocks selection.
  await prisma.conversationJobLink.delete({ where: { id: extra.id } });
  for (const [data, restore, status] of [
    [{ deletedAt: new Date() }, { deletedAt: null }, 404],
    [{ status: "CREATED" }, { status: "ACCEPTED" }, 409],
    [
      { calendarEventId: null },
      { calendarEventId: initial.calendarEventId },
      409,
    ],
    [{ intakeSessionId: null }, { intakeSessionId: sessionId }, 409],
  ]) {
    await patchJob(data);
    await check(() => read(), status);
    await patchJob(restore);
  }
  const op = await prisma.calendarOperation.create({
    data: {
      tenantId,
      jobId: job.id,
      action: "RESCHEDULE",
      status: "PENDING",
      calendarId: "fixture-calendar",
      calendarEventId: initial.calendarEventId,
      timeZone: "UTC",
      expectedUpdatedAt: new Date(job.updatedAt.getTime() - 1),
      claimedUpdatedAt: job.updatedAt,
      previousStatus: "ACCEPTED",
      previousCalendarEventId: initial.calendarEventId,
      previousWindowStart: initial.serviceWindowStart,
      previousWindowEnd: initial.serviceWindowEnd,
      desiredWindowStart: initial.serviceWindowStart,
      desiredWindowEnd: initial.serviceWindowEnd,
      desiredTimeText: "Synthetic arrival window",
    },
  });
  await check(() => read(), 409);
  await prisma.calendarOperation.delete({ where: { id: op.id } });
  await patchJob({
    status: "CANCELLED",
    calendarEventId: null,
    serviceWindowStart: null,
    serviceWindowEnd: null,
  });
  await check(() => read("cancelled")); // Structural only: no provider receipt is claimed.
  await check(() => read("confirmed"), 409);
  await patchJob({ calendarEventId: "" });
  await check(() => read("cancelled"), 409);
  await patchJob({ calendarEventId: null });
  const checks = [
    "recipient: actual retained capture and placeholder-to-job customer binding",
    "recipient: one-statement tenant/session/origin scope and no contact fallback",
    "recipient: auth, lifecycle, Calendar hold, stale and ambiguous origin refusals",
    "recipient: deleted/inactive records and malformed ciphertext fail closed",
    "recipient: private snapshot only, no ownership or delivery authorization",
    "recipient: all resolver invocations leave business rows and side-effect counts unchanged",
  ];
  const evidence = {
    result: "PASS",
    database: "disposable Unix-socket fixture",
    successfulReads,
    refusedReads,
    checks,
    providerCalls: 0,
    deliveryAuthorized: false,
    httpAuthenticationTested: false,
  };
  const directory =
    process.env.EMAIL_RECIPIENT_EVIDENCE_DIR ??
    fileURLToPath(
      new URL("../evidence/APP-013/email-recipient/", import.meta.url),
    );
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "database-summary.json"),
    JSON.stringify(evidence, null, 2) + "\n",
  );
  return checks;
}
