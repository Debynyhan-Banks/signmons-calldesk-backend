import { randomUUID } from "node:crypto";
import { BadRequestException } from "@nestjs/common";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CustomerIntakeContinuationService,
  PROTECTED_INTAKE_TURN,
} from "./customer-intake-continuation.service";
import { CustomerConsentCredentials } from "./customer-consent-credentials";
import { lockCustomerConsentSession } from "./customer-consent-session-lock";
import { ConversationMemoryCipher } from "../logging/conversation-memory-cipher.service";
import appConfig from "../config/app.config";
import {
  requestContextMiddleware,
  setAuthContext,
} from "../common/context/request-context";
jest.mock("./customer-consent-session-lock", () => ({
  lockCustomerConsentSession: jest.fn(),
}));

describe("inactive credential-bound transcript continuation", () => {
  const credentials = new CustomerConsentCredentials({
    activeKeyId: "fixture",
    keys: { fixture: Buffer.alloc(32, 9) },
  });
  const cipher = new ConversationMemoryCipher({
    conversationDataEncryptionKey: "1".repeat(64),
  } as ReturnType<typeof appConfig>);
  const scope = {
    tenantId: randomUUID(),
    sessionId: randomUUID(),
    conversationId: randomUUID(),
  };
  const input = () => ({
    sessionToken: credentials.issueSession(scope),
    interactionId: randomUUID(),
    message: "Fictional private intake text",
  });
  const tx = {
    communicationEvent: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    conversationJobLink: { count: jest.fn(), create: jest.fn() },
    job: { findUnique: jest.fn(), create: jest.fn() },
    serviceCategory: { findFirst: jest.fn() },
    customer: { upsert: jest.fn() },
    propertyAddress: { create: jest.fn() },
    conversation: { updateMany: jest.fn() },
    auditLog: { create: jest.fn() },
    appointmentEmailConsentScope: { findUnique: jest.fn() },
    appointmentEmailConsentEvidence: { findFirst: jest.fn() },
  };
  const transaction = jest.fn(),
    reply = jest.fn(),
    bindJob = jest.fn();
  const service = (collaborator = true) =>
    new CustomerIntakeContinuationService(
      { $transaction: transaction },
      cipher,
      credentials,
      collaborator ? { reply } : undefined,
      { bindJob },
    );
  const saved = (id = randomUUID(), revision = 1) => ({
    id,
    channel: "WEBCHAT",
    direction: "INBOUND",
    provider: "OTHER",
    status: "RECEIVED",
    content: {
      payload: {
        version: 1,
        type: PROTECTED_INTAKE_TURN,
        sessionId: scope.sessionId,
        revision,
        encryptedInput: cipher.encrypt("Fictional private intake text"),
        encryptedReply: cipher.encrypt("Scripted private reply"),
      },
    },
  });
  beforeEach(() => {
    jest.resetAllMocks();
    jest.mocked(lockCustomerConsentSession).mockResolvedValue({
      status: "ONGOING",
      sessionId: scope.sessionId,
      marker: 1,
      capture: null,
      hasCapture: false,
    });
    tx.communicationEvent.findMany.mockResolvedValue([]);
    tx.communicationEvent.findUnique.mockResolvedValue(null);
    tx.conversationJobLink.count.mockResolvedValue(0);
    tx.conversationJobLink.create.mockResolvedValue({
      id: "33333333-3333-4333-8333-333333333333",
    });
    tx.communicationEvent.create.mockResolvedValue({});
    tx.auditLog.create.mockResolvedValue({});
    tx.job.findUnique.mockResolvedValue(null);
    tx.job.create.mockResolvedValue({
      id: "44444444-4444-4444-8444-444444444444",
      status: "CREATED",
      urgency: "HIGH",
    });
    tx.serviceCategory.findFirst.mockResolvedValue({
      id: "55555555-5555-4555-8555-555555555555",
    });
    tx.customer.upsert.mockResolvedValue({
      id: "66666666-6666-4666-8666-666666666666",
      deletedAt: null,
    });
    tx.propertyAddress.create.mockResolvedValue({
      id: "77777777-7777-4777-8777-777777777777",
    });
    tx.conversation.updateMany.mockResolvedValue({ count: 1 });
    bindJob.mockResolvedValue({});
    reply.mockResolvedValue("Scripted private reply");
    transaction.mockImplementation((fn: (client: typeof tx) => unknown) =>
      fn(tx),
    );
  });
  it.each([
    {},
    { sessionId: "legacy" },
    {
      sessionToken: "integration-secret",
      interactionId: randomUUID(),
      message: "text",
    },
    { sessionToken: "", interactionId: "bad", message: "text" },
  ])(
    "refuses missing/forged/caller-ID input %# before database",
    async (value) => {
      await expect(
        service().continue(value as ReturnType<typeof input>),
      ).rejects.toThrow();
      expect(transaction).not.toHaveBeenCalled();
    },
  );
  it.each(["", " ", "x".repeat(2001), "bad\u0000text"])(
    "rejects invalid message %# before database",
    async (message) => {
      await expect(
        service().continue({ ...input(), message }),
      ).rejects.toThrow();
      expect(transaction).not.toHaveBeenCalled();
    },
  );
  it("rejects caller-provided tenant/history/reply overrides", async () => {
    await expect(
      service().continue({ ...input(), tenantId: scope.tenantId } as ReturnType<
        typeof input
      >),
    ).rejects.toThrow();
    expect(transaction).not.toHaveBeenCalled();
  });
  it("runs scripted reply outside transactions, then writes encrypted pair and audit", async () => {
    let inTransaction = false;
    transaction.mockImplementation(
      async (fn: (client: typeof tx) => Promise<unknown>) => {
        inTransaction = true;
        try {
          return await fn(tx);
        } finally {
          inTransaction = false;
        }
      },
    );
    reply.mockImplementation(() => {
      expect(inTransaction).toBe(false);
      return Promise.resolve("Scripted private reply");
    });
    expect(await service().continue(input())).toEqual({
      reply: "Scripted private reply",
      revision: 1,
      deliveryAuthorized: false,
    });
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(tx.communicationEvent.create).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(
      JSON.stringify(tx.communicationEvent.create.mock.calls),
    ).not.toContain("Fictional private intake text");
    expect(
      JSON.stringify(tx.communicationEvent.create.mock.calls),
    ).not.toContain("Scripted private reply");
    expect(JSON.stringify(tx.auditLog.create.mock.calls)).not.toContain(
      "private",
    );
    expect((transaction.mock.calls as unknown[][])[0][1]).toEqual({
      maxWait: 2000,
      timeout: 5000,
    });
  });
  it("missing collaborator refuses after ownership check without a write", async () => {
    await expect(service(false).continue(input())).rejects.toThrow(
      "unconfirmed",
    );
    expect(tx.communicationEvent.create).not.toHaveBeenCalled();
  });
  it.each(["", "x".repeat(2001), null])(
    "refuses invalid scripted reply %# without writes",
    async (value) => {
      reply.mockResolvedValue(value);
      await expect(service().continue(input())).rejects.toThrow("unconfirmed");
      expect(tx.communicationEvent.create).not.toHaveBeenCalled();
    },
  );
  it("replays the original committed turn without invoking a collaborator", async () => {
    const request = input();
    tx.communicationEvent.findMany.mockResolvedValue([
      saved(request.interactionId),
    ]);
    expect(await service(false).continue(request)).toEqual({
      reply: "Scripted private reply",
      revision: 1,
      deliveryAuthorized: false,
    });
    expect(reply).not.toHaveBeenCalled();
    expect(tx.communicationEvent.create).not.toHaveBeenCalled();
    await expect(
      service().continue({ ...request, message: "changed" }),
    ).rejects.toThrow("changed");
  });
  it("refuses event ID collision rather than adopting another history", async () => {
    tx.communicationEvent.findUnique.mockResolvedValue({ id: "occupied" });
    await expect(service().continue(input())).rejects.toThrow("changed");
    expect(reply).not.toHaveBeenCalled();
  });
  it.each(["COMPLETED", "ABANDONED"])(
    "refuses non-ongoing status %s before collaborator",
    async (status) => {
      jest.mocked(lockCustomerConsentSession).mockResolvedValue({
        status,
        sessionId: scope.sessionId,
        marker: 1,
        capture: null,
        hasCapture: false,
      });
      await expect(service().continue(input())).rejects.toThrow("changed");
      expect(reply).not.toHaveBeenCalled();
    },
  );
  it("refuses job-linked sessions", async () => {
    tx.conversationJobLink.count.mockResolvedValue(1);
    await expect(service().continue(input())).rejects.toThrow("changed");
    expect(reply).not.toHaveBeenCalled();
  });
  it.each([0, 2, 1.5])(
    "refuses invalid/gapped history revision %s",
    async (revision) => {
      tx.communicationEvent.findMany.mockResolvedValue([
        saved(randomUUID(), revision),
      ]);
      await expect(service().continue(input())).rejects.toThrow("changed");
      expect(reply).not.toHaveBeenCalled();
    },
  );
  it("refuses corrupted encrypted history without plaintext fallback", async () => {
    const row = saved();
    row.content.payload.encryptedInput = "unreadable";
    tx.communicationEvent.findMany.mockResolvedValue([row]);
    await expect(service().continue(input())).rejects.toThrow("changed");
    expect(reply).not.toHaveBeenCalled();
  });
  it("caps stored history at twenty turns", async () => {
    tx.communicationEvent.findMany.mockResolvedValue(
      Array.from({ length: 20 }, (_, i) => saved(randomUUID(), i + 1)),
    );
    await expect(service().continue(input())).rejects.toThrow("changed");
    expect(reply).not.toHaveBeenCalled();
  });
  it("refuses a competing history after the scripted reply, without saving stale output", async () => {
    reply.mockImplementation(() => {
      tx.communicationEvent.findMany.mockResolvedValue([saved()]);
      return Promise.resolve("stale response");
    });
    await expect(service().continue(input())).rejects.toThrow("changed");
    expect(tx.communicationEvent.create).not.toHaveBeenCalled();
  });
  it("sanitizes collaborator/storage errors", async () => {
    reply.mockRejectedValueOnce(new Error("PRIVATE_CONTENT"));
    await expect(service().continue(input())).rejects.toThrow("unconfirmed");
    reply.mockRejectedValueOnce(new BadRequestException("PRIVATE_REPLY"));
    await expect(service().continue(input())).rejects.toThrow("unconfirmed");
    tx.auditLog.create.mockRejectedValueOnce(new Error("PRIVATE_DATABASE"));
    await expect(service().continue(input())).rejects.toThrow("unconfirmed");
  });
  const draft = {
    customerName: "Fictional Customer",
    phone: "+12025550123",
    address: "123 Fictional Lane",
    description: "Cooling issue",
    issueCategory: "COOLING",
    propertyType: "RESIDENTIAL",
    serviceIntent: "REPAIR",
  };
  const preview = () => ({
    sessionToken: input().sessionToken,
    expectedRevision: 1,
    draft,
  });
  const admission = () => ({
    sessionToken: input().sessionToken,
    expectedRevision: 1,
    draft,
    review: {
      urgency: "HIGH",
      reasonCode: "OPERATOR_REVIEWED_INTAKE",
      acknowledgeCustomerStatements: true,
    },
  });
  const asOperator = <T>(
    action: () => Promise<T>,
    override: { tenantId?: string; role?: string; userId?: string } = {},
  ) =>
    new Promise<T>((resolve, reject) => {
      requestContextMiddleware({ headers: {} } as never, {} as never, () => {
        setAuthContext({
          tenantId: override.tenantId ?? scope.tenantId,
          role: override.role ?? "dispatcher",
          userId: override.userId ?? "fixture-operator",
        });
        action().then(resolve, reject);
      });
    });
  it("validates a read-only draft without requiring consent or writing any records", async () => {
    tx.communicationEvent.findMany.mockResolvedValue([saved()]);
    tx.appointmentEmailConsentScope.findUnique.mockResolvedValue(null);
    const result = await service().previewDraft(preview());
    expect(result).toEqual({
      draft,
      transcriptRevision: 1,
      emailChoice: "NOT_RECORDED",
      urgencyAssessment: "NOT_PERFORMED",
      requiresHumanReview: true,
      jobCreated: false,
      bookingAuthorized: false,
      deliveryAuthorized: false,
    });
    expect(reply).not.toHaveBeenCalled();
    expect(tx.communicationEvent.create).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
  it.each(["GRANTED", "DECLINED", "REVOKED"])(
    "projects historical email choice %s without treating it as sending authority",
    async (decision) => {
      tx.communicationEvent.findMany.mockResolvedValue([saved()]);
      tx.appointmentEmailConsentScope.findUnique.mockResolvedValue({
        id: "scope",
        sessionId: scope.sessionId,
      });
      tx.appointmentEmailConsentEvidence.findFirst.mockResolvedValue({
        decision,
      });
      expect((await service().previewDraft(preview())).emailChoice).toBe(
        decision,
      );
    },
  );
  it.each([
    { phone: "555-1234" },
    { customerName: " " },
    { address: "x".repeat(201) },
    { description: "bad\u0000data" },
    { issueCategory: "UNKNOWN" },
    { propertyType: "OTHER" },
    { serviceIntent: "BOOK_NOW" },
    { urgency: "STANDARD" },
    { email: "private@example.invalid" },
  ])(
    "refuses malformed or authority-bearing draft %# before database",
    async (override) => {
      await expect(
        service().previewDraft({
          ...preview(),
          draft: { ...draft, ...override },
        }),
      ).rejects.toThrow();
      expect(transaction).not.toHaveBeenCalled();
    },
  );
  it.each([0, 2, 1.5])(
    "refuses missing/stale draft revision %s",
    async (expectedRevision) => {
      tx.communicationEvent.findMany.mockResolvedValue([saved()]);
      await expect(
        service().previewDraft({ ...preview(), expectedRevision }),
      ).rejects.toThrow();
      expect(tx.auditLog.create).not.toHaveBeenCalled();
    },
  );
  it("refuses a foreign session consent scope", async () => {
    tx.communicationEvent.findMany.mockResolvedValue([saved()]);
    tx.appointmentEmailConsentScope.findUnique.mockResolvedValue({
      id: "scope",
      sessionId: randomUUID(),
    });
    await expect(service().previewDraft(preview())).rejects.toThrow("changed");
  });
  it("refuses forged draft credential before database", async () => {
    await expect(
      service().previewDraft({ ...preview(), sessionToken: "raw-session" }),
    ).rejects.toThrow();
    expect(transaction).not.toHaveBeenCalled();
  });
  it("sanitizes draft database errors", async () => {
    transaction.mockRejectedValue(new Error("PRIVATE"));
    await expect(service().previewDraft(preview())).rejects.toThrow(
      "Intake draft unavailable.",
    );
  });
  it("atomically admits an exact reviewed draft without booking or delivery authority", async () => {
    tx.communicationEvent.findMany.mockResolvedValue([saved()]);
    tx.appointmentEmailConsentScope.findUnique.mockResolvedValue(null);
    expect(await asOperator(() => service().admitDraft(admission()))).toEqual({
      jobId: "44444444-4444-4444-8444-444444444444",
      status: "CREATED",
      urgency: "HIGH",
      transcriptRevision: 1,
      humanReviewed: true,
      consentEvidence: "NOT_RECORDED",
      jobCreated: true,
      bookingAuthorized: false,
      deliveryAuthorized: false,
    });
    expect(tx.job.create).toHaveBeenCalledTimes(1);
    expect(tx.conversationJobLink.create).toHaveBeenCalledTimes(1);
    expect(tx.conversation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: "COMPLETED", currentFSMState: "JOB_CREATED" },
      }),
    );
    expect(bindJob).not.toHaveBeenCalled();
    const writes = JSON.stringify([
      tx.job.create.mock.calls,
      tx.auditLog.create.mock.calls,
    ]);
    expect(writes).not.toContain(draft.customerName);
    expect(writes).not.toContain(draft.phone);
    expect(writes).not.toContain(draft.address);
    expect(writes).toContain("HUMAN_INTAKE_REVIEW");
  });
  it.each(["owner", "admin", "dispatcher"])(
    "allows verified %s admission review",
    async (role) => {
      tx.communicationEvent.findMany.mockResolvedValue([saved()]);
      tx.appointmentEmailConsentScope.findUnique.mockResolvedValue(null);
      await expect(
        asOperator(() => service().admitDraft(admission()), { role }),
      ).resolves.toMatchObject({ jobCreated: true });
    },
  );
  it.each([undefined, "tech", "webchat_integration"])(
    "refuses untrusted admission role %s before database",
    async (role) => {
      const action = () => service().admitDraft(admission());
      await expect(
        role ? asOperator(action, { role }) : action(),
      ).rejects.toThrow("verified owner");
      expect(transaction).not.toHaveBeenCalled();
    },
  );
  it("refuses operator/customer tenant mismatch before database", async () => {
    await expect(
      asOperator(() => service().admitDraft(admission()), {
        tenantId: randomUUID(),
      }),
    ).rejects.toThrow("unavailable");
    expect(transaction).not.toHaveBeenCalled();
  });
  it.each([
    { acknowledgeCustomerStatements: false },
    { reasonCode: "FREE_TEXT" },
    { urgency: "UNKNOWN" },
    { extra: true },
  ])("refuses malformed or non-explicit human review %#", async (override) => {
    await expect(
      asOperator(() =>
        service().admitDraft({
          ...admission(),
          review: { ...admission().review, ...override },
        }),
      ),
    ).rejects.toThrow("Invalid intake review");
    expect(transaction).not.toHaveBeenCalled();
  });
  it("binds existing consent evidence in the same admission transaction", async () => {
    tx.communicationEvent.findMany.mockResolvedValue([saved()]);
    tx.appointmentEmailConsentScope.findUnique.mockResolvedValue({
      id: "88888888-8888-4888-8888-888888888888",
      sessionId: scope.sessionId,
    });
    tx.appointmentEmailConsentEvidence.findFirst.mockResolvedValue({
      decision: "DECLINED",
    });
    await expect(
      asOperator(() => service().admitDraft(admission())),
    ).resolves.toMatchObject({ consentEvidence: "BOUND" });
    expect(bindJob).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        tenantId: scope.tenantId,
        conversationId: scope.conversationId,
        jobId: "44444444-4444-4444-8444-444444444444",
      }),
    );
  });
  it("fails closed before job creation for stale transcript or unsupported category", async () => {
    tx.communicationEvent.findMany.mockResolvedValue([]);
    await expect(
      asOperator(() => service().admitDraft(admission())),
    ).rejects.toThrow("changed");
    expect(tx.job.create).not.toHaveBeenCalled();
    jest.clearAllMocks();
    jest.mocked(lockCustomerConsentSession).mockResolvedValue({
      status: "ONGOING",
      sessionId: scope.sessionId,
      marker: 1,
      capture: null,
      hasCapture: false,
    });
    transaction.mockImplementation((fn: (client: typeof tx) => unknown) =>
      fn(tx),
    );
    tx.job.findUnique.mockResolvedValue(null);
    tx.communicationEvent.findMany.mockResolvedValue([saved()]);
    tx.conversationJobLink.count.mockResolvedValue(0);
    tx.appointmentEmailConsentScope.findUnique.mockResolvedValue(null);
    tx.serviceCategory.findFirst.mockResolvedValue(null);
    await expect(
      asOperator(() => service().admitDraft(admission())),
    ).rejects.toThrow("not available");
    expect(tx.customer.upsert).not.toHaveBeenCalled();
  });
  it("replays only the exact admitted request without duplicate writes", async () => {
    const request = admission();
    tx.communicationEvent.findMany.mockResolvedValue([saved()]);
    tx.appointmentEmailConsentScope.findUnique.mockResolvedValue(null);
    const first = await asOperator(() => service().admitDraft(request));
    const [createInput] = tx.job.create.mock.calls[0] as unknown as [
      { data: { policySnapshot: object } },
    ];
    const policy = createInput.data.policySnapshot;
    jest.clearAllMocks();
    jest.mocked(lockCustomerConsentSession).mockResolvedValue({
      status: "COMPLETED",
      sessionId: scope.sessionId,
      marker: 1,
      capture: null,
      hasCapture: false,
    });
    transaction.mockImplementation((fn: (client: typeof tx) => unknown) =>
      fn(tx),
    );
    tx.job.findUnique.mockResolvedValue({
      id: first.jobId,
      status: "CREATED",
      urgency: "HIGH",
      policySnapshot: policy,
      deletedAt: null,
      conversationLinks: [{ id: "link" }],
      emailConsentBinding: null,
    });
    await expect(
      asOperator(() => service().admitDraft(request)),
    ).resolves.toEqual(first);
    expect(tx.job.create).not.toHaveBeenCalled();
    await expect(
      asOperator(() =>
        service().admitDraft({
          ...request,
          review: { ...request.review, urgency: "STANDARD" },
        }),
      ),
    ).rejects.toThrow("changed");
  });
  it("rolls back if session close or consent binding cannot be confirmed", async () => {
    tx.communicationEvent.findMany.mockResolvedValue([saved()]);
    tx.appointmentEmailConsentScope.findUnique.mockResolvedValue(null);
    tx.conversation.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      asOperator(() => service().admitDraft(admission())),
    ).rejects.toThrow("changed");
    jest.clearAllMocks();
    jest.mocked(lockCustomerConsentSession).mockResolvedValue({
      status: "ONGOING",
      sessionId: scope.sessionId,
      marker: 1,
      capture: null,
      hasCapture: false,
    });
    transaction.mockImplementation((fn: (client: typeof tx) => unknown) =>
      fn(tx),
    );
    tx.job.findUnique.mockResolvedValue(null);
    tx.communicationEvent.findMany.mockResolvedValue([saved()]);
    tx.conversationJobLink.count.mockResolvedValue(0);
    tx.appointmentEmailConsentScope.findUnique.mockResolvedValue({
      id: "88888888-8888-4888-8888-888888888888",
      sessionId: scope.sessionId,
    });
    tx.appointmentEmailConsentEvidence.findFirst.mockResolvedValue({
      decision: "GRANTED",
    });
    tx.serviceCategory.findFirst.mockResolvedValue({ id: randomUUID() });
    tx.customer.upsert.mockResolvedValue({ id: randomUUID(), deletedAt: null });
    tx.propertyAddress.create.mockResolvedValue({ id: randomUUID() });
    tx.job.create.mockResolvedValue({
      id: randomUUID(),
      status: "CREATED",
      urgency: "HIGH",
    });
    tx.conversationJobLink.create.mockResolvedValue({ id: randomUUID() });
    bindJob.mockRejectedValue(new Error("private binding failure"));
    await expect(
      asOperator(() => service().admitDraft(admission())),
    ).rejects.toThrow("outcome is unconfirmed");
  });
  it("remains unregistered in production", () => {
    for (const file of ["communications.module.ts"])
      expect(readFileSync(join(__dirname, file), "utf8")).not.toContain(
        "CustomerIntakeContinuation",
      );
  });
});
