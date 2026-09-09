// Disposable fixture only; no AppModule, model/provider calls or real customer data.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const require = createRequire(import.meta.url);

export async function verifyConversationEmail({
  prisma,
  tenantId,
  otherTenantId,
}) {
  const [db] = await prisma.$queryRawUnsafe(
    "SELECT current_database() AS name, inet_server_addr() AS address",
  );
  assert.match(db.name, /^calldesk_app013_intents_[0-9a-f]{12}$/);
  assert.equal(db.address, null);
  const {
      ConversationsService,
    } = require("../dist/conversations/conversations.service.js"),
    {
      ConversationEmailService,
      EMAIL_QUESTION,
    } = require("../dist/conversations/conversation-email.service.js"),
    {
      ConversationMemoryCipher,
    } = require("../dist/logging/conversation-memory-cipher.service.js"),
    {
      SanitizationService,
    } = require("../dist/sanitization/sanitization.service.js"),
    { CallLogService } = require("../dist/logging/call-log.service.js"),
    { JobsService } = require("../dist/jobs/jobs.service.js"),
    { AiService } = require("../dist/ai/ai.service.js"),
    { LifeSafetyService } = require("../dist/ai/safety/life-safety.service.js"),
    { CREATE_JOB_TOOL } = require("../dist/jobs/tools/create-job.tool.js");
  const sanitizer = new SanitizationService(),
    config = {
      conversationDataEncryptionKey: "2".repeat(64),
      aiMaxTokens: 800,
    },
    cipher = new ConversationMemoryCipher(config),
    conversations = new ConversationsService(prisma, sanitizer),
    email = new ConversationEmailService(prisma, cipher),
    logs = new CallLogService(prisma, sanitizer, cipher);
  const sessionId = `email-${randomUUID()}`;
  const parallel = await Promise.all(
    Array.from({ length: 4 }, () =>
      conversations.ensureConversation(tenantId, sessionId),
    ),
  );
  assert.equal(new Set(parallel.map((c) => c.id)).size, 1);
  const scope = { tenantId, sessionId, conversationId: parallel[0].id };
  assert.equal(
    (
      await Promise.all(
        Array.from({ length: 4 }, () => email.requestOnce(scope)),
      )
    ).filter(Boolean).length,
    1,
  );
  assert.equal(
    await prisma.auditLog.count({
      where: {
        tenantId,
        entityId: scope.conversationId,
        action: "conversation.email_asked",
      },
    }),
    1,
  );
  await Promise.all([
    email.observe(scope, "First@example.com"),
    email.observe(scope, "Second@example.com"),
  ]);
  const saved = await prisma.conversation.findUniqueOrThrow({
      where: { id: scope.conversationId },
    }),
    captured = saved.collectedData.intakeEmail;
  assert.ok(
    ["First@example.com", "Second@example.com"].includes(
      cipher.decrypt(captured.encryptedEmail),
    ),
  );
  assert.equal(
    await prisma.auditLog.count({
      where: {
        tenantId,
        entityId: scope.conversationId,
        action: "conversation.email_captured",
      },
    }),
    1,
  );
  const fresh = new ConversationEmailService(
    prisma,
    new ConversationMemoryCipher(config),
  );
  const restarted = spawnSync(
    process.execPath,
    [
      fileURLToPath(
        new URL("./verify-email-capture-restart.mjs", import.meta.url),
      ),
      db.name,
      tenantId,
      scope.conversationId,
      sessionId,
    ],
    { timeout: 15000, encoding: "utf8" },
  );
  assert.equal(restarted.status, 0, "Fresh-process capture check failed");
  assert.equal(await fresh.requestOnce(scope), false);
  await fresh.observe(scope, "Replacement@example.com");
  assert.deepEqual(
    (
      await prisma.conversation.findUniqueOrThrow({
        where: { id: scope.conversationId },
      })
    ).collectedData,
    saved.collectedData,
  );
  for (const bad of [
    { ...scope, tenantId: otherTenantId },
    { ...scope, sessionId: "other-session" },
  ])
    await assert.rejects(() => email.observe(bad, "Wrong@example.com"));
  const rollbackSession = `rollback-${randomUUID()}`,
    rollbackConversation = await conversations.ensureConversation(
      tenantId,
      rollbackSession,
    ),
    rollbackScope = {
      tenantId,
      sessionId: rollbackSession,
      conversationId: rollbackConversation.id,
    };
  const failing = new ConversationEmailService(
    {
      $transaction: (fn) =>
        prisma.$transaction((tx) =>
          fn({
            ...tx,
            auditLog: {
              create: async () => {
                throw new Error("private capture failure");
              },
            },
          }),
        ),
    },
    cipher,
  );
  await assert.rejects(() =>
    failing.observe(rollbackScope, "Rollback@example.com"),
  );
  assert.deepEqual(
    (
      await prisma.conversation.findUniqueOrThrow({
        where: { id: rollbackConversation.id },
      })
    ).collectedData,
    rollbackConversation.collectedData,
  );
  const ackLoss = new ConversationEmailService(
    {
      $transaction: async (fn) => {
        await prisma.$transaction(fn);
        throw new Error("ack lost");
      },
    },
    cipher,
  );
  await assert.rejects(() =>
    ackLoss.observe(rollbackScope, "Retained@example.com"),
  );
  assert.equal(await fresh.requestOnce(rollbackScope), false);
  assert.equal(
    await prisma.auditLog.count({
      where: {
        tenantId,
        entityId: rollbackConversation.id,
        action: "conversation.email_captured",
      },
    }),
    1,
  );
  await prisma.conversation.update({
    where: { id: rollbackConversation.id },
    data: { deletedAt: new Date() },
  });
  await assert.rejects(() => fresh.observe(rollbackScope, "Wrong@example.com"));
  const duplicateSession = `duplicate-${randomUUID()}`,
    duplicate = await conversations.ensureConversation(
      tenantId,
      duplicateSession,
    );
  await prisma.conversation.create({
    data: {
      tenantId,
      customerId: duplicate.customerId,
      customerTenantId: tenantId,
      channel: "WEBCHAT",
      status: "ONGOING",
      currentFSMState: "TRIAGE",
      collectedData: { sessionId: duplicateSession },
    },
  });
  await assert.rejects(() =>
    conversations.ensureConversation(tenantId, duplicateSession),
  );

  let modelCalls = 0,
    notificationRequests = 0;
  const notification = {
    enqueueJobCreated() {
      notificationRequests++;
    },
    enqueueOrphanedIntake() {
      throw new Error("unexpected orphan");
    },
  };
  const jobs = new JobsService(prisma, sanitizer, notification),
    logging = { log() {}, warn() {}, error() {} };
  const payload = {
    customerName: "Synthetic Email Customer",
    phone: "+15555550987",
    address: "123 Fixture Street, Test City 44101",
    issueCategory: "HEATING",
    urgency: "STANDARD",
    description: "Furnace not working",
    propertyType: "RESIDENTIAL",
    serviceIntent: "REPAIR",
  };
  const model = {
    createCompletion: async () => {
      modelCalls++;
      return {
        id: "synthetic-completion",
        model: "fixture",
        choices: [
          {
            message: {
              role: "assistant",
              tool_calls: [
                {
                  id: "synthetic-tool",
                  type: "function",
                  function: {
                    name: "create_job",
                    arguments: JSON.stringify(payload),
                  },
                },
              ],
            },
          },
        ],
      };
    },
  };
  const ai = new AiService(
    model,
    {
      handle(error) {
        throw error;
      },
    },
    logging,
    sanitizer,
    { getEnabledToolsForTenant: () => [CREATE_JOB_TOOL] },
    jobs,
    {
      getTenantContext: async () => ({
        prompt: "Fictional contractor intake only.",
      }),
    },
    logs,
    conversations,
    new LifeSafetyService(),
    { isInstantBookingEligible: () => false },
    notification,
    config,
    email,
  );
  const full =
    "My name is Synthetic Customer. My phone is 5555550987. My service address is 123 Fixture Street 44101. My furnace is not working and needs repair at my residential home.";
  const flowSession = `flow-${randomUUID()}`;
  const asked = await ai.triage(tenantId, flowSession, full);
  assert.deepEqual(asked, { status: "reply", reply: EMAIL_QUESTION });
  assert.equal(modelCalls, 0);
  const completed = await ai.triage(
    tenantId,
    flowSession,
    "My email is Intake@example.com",
  );
  assert.equal(completed.status, "job_created");
  assert.equal(modelCalls, 1);
  const linked = await prisma.conversationJobLink.findFirstOrThrow({
    where: { tenantId, jobId: completed.job.id },
    include: { conversation: true, job: { include: { customer: true } } },
  });
  assert.equal(
    cipher.decrypt(
      linked.conversation.collectedData.intakeEmail.encryptedEmail,
    ),
    "Intake@example.com",
  );
  assert.equal(linked.job.customer.email, null);
  assert.equal(JSON.stringify(completed).includes("Intake@example.com"), false);
  // A retry after transcript closure still uses persistent email state and existing job id.
  const retried = await ai.triage(tenantId, flowSession, "Continue");
  assert.equal(retried.status, "job_created");
  assert.equal(retried.job.id, completed.job.id);
  const skipSession = `skip-${randomUUID()}`;
  assert.equal(
    (await ai.triage(tenantId, skipSession, full)).reply,
    EMAIL_QUESTION,
  );
  assert.equal(
    (await ai.triage(tenantId, skipSession, "skip")).status,
    "job_created",
  );
  const skipConversation = await conversations.ensureConversation(
    tenantId,
    skipSession,
  );
  assert.equal(skipConversation.collectedData.intakeEmail.status, "declined");
  const volunteerSession = `volunteer-${randomUUID()}`;
  assert.equal(
    (
      await ai.triage(
        tenantId,
        volunteerSession,
        full + " My email is Volunteered@example.com.",
      )
    ).status,
    "job_created",
  );
  const audits = await prisma.auditLog.findMany({
    where: { tenantId, action: { startsWith: "conversation.email_" } },
  });
  assert.equal(JSON.stringify(audits).includes("@"), false);
  const content = await prisma.communicationContent.findMany({
    where: { tenantId },
    select: { payload: true },
  });
  // Ordinary transcript fields are redacted; raw memory is only inside encrypted fields.
  for (const row of content)
    assert.equal(
      JSON.stringify(row.payload).includes("Intake@example.com"),
      false,
    );
  const result = {
    result: "PASS",
    real: [
      "serialized conversation creation",
      "encrypted capture and audit transactions",
      "AiService orchestration",
      "JobsService",
      "CallLogService",
      "tenant-scoped conversation/job links",
      "disposable PostgreSQL",
    ],
    synthetic: [
      "scripted model",
      "tenant prompt",
      "notification sink",
      "no Calendar availability",
    ],
    checks: [
      "concurrent first session yields one conversation",
      "one prompt reservation under concurrent requests",
      "first captured value wins",
      "fresh service and closed-history retries do not re-ask",
      "separate Node process retains encrypted capture without another question",
      "cross-tenant/session/deleted refusal",
      "legacy duplicate session refuses",
      "audit rollback",
      "lost commit acknowledgment preserves capture once",
      "optional email prompt before model/job creation",
      "capture linked to actual created job without customer-master overwrite",
      "skip continues job creation",
      "volunteered email avoids prompt",
      "no address in public job response or audit metadata",
    ],
    modelCalls,
    notificationRequests,
    providerCalls: 0,
    newMigrations: 0,
  };
  const evidence =
    process.env.EMAIL_CAPTURE_EVIDENCE_DIR ??
    "/private/tmp/signmons-email-capture-proof";
  await mkdir(evidence, { recursive: true });
  await writeFile(
    join(evidence, "summary.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
  return [
    "one-time optional email: real encrypted persistence, concurrent prompt/capture, rollback/ack-loss and AI-to-job link proof",
  ];
}
