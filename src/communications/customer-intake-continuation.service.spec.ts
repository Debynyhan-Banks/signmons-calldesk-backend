import { randomUUID, createHash } from "node:crypto";
import { BadRequestException } from "@nestjs/common";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CustomerIntakeContinuationService,
  PROTECTED_INTAKE_TURN,
  PROTECTED_INTAKE_REVIEW,
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
    tenantOrganization: { findFirst: jest.fn() },
    communicationEvent: {
      findFirst: jest.fn(),
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
  const organization = () => {
    const facts = {
      companyName: "Fictional Service",
      timezone: "UTC",
      hours: "Weekdays",
      services: "Heating",
      fallback: "Contact our office for human help.",
      greeting: "Welcome.",
      tone: "warm",
      faqs: [
        {
          question: "Do you service heating?",
          answer: "Yes, we service heating.",
          source: "Owner",
        },
      ],
    };
    return {
      settings: {
        organizationProfileV1: {
          version: 1,
          draft: { ...facts, greeting: "UNAPPROVED" },
          approved: {
            draft: facts,
            actorId: "owner",
            approvedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      },
    };
  };
  it("uses only approved tenant facts for a protected customer turn without a collaborator", async () => {
    tx.tenantOrganization.findFirst.mockResolvedValue(organization());
    const result = await service(false).continueOrganization({
      ...input(),
      message: "Do you service heating?",
    });
    expect(result.reply).toContain("Yes, we service heating.");
    expect(result.reply).not.toContain("UNAPPROVED");
    expect(reply).not.toHaveBeenCalled();
    expect(tx.communicationEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          content: {
            create: expect.objectContaining({
              payload: expect.objectContaining({
                version: 2,
                organizationApprovedAt: "2026-01-01T00:00:00.000Z",
                organizationDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
              }),
            }),
          },
        }),
      }),
    );
  });
  it("returns approved human-contact fallback without creating any task", async () => {
    tx.tenantOrganization.findFirst.mockResolvedValue(organization());
    expect(
      (await service(false).continueOrganization(input())).reply,
    ).toContain("Contact our office");
    expect(tx.job.create).not.toHaveBeenCalled();
  });
  it("handles longer multiline intake as fallback without changing its encrypted input", async () => {
    tx.tenantOrganization.findFirst.mockResolvedValue(organization());
    expect(
      (
        await service(false).continueOrganization({
          ...input(),
          message: "Customer details\n" + "x".repeat(300),
        })
      ).reply,
    ).toContain("Contact our office");
  });
  it.each([
    null,
    { settings: {} },
    { settings: { organizationProfileV1: null } },
  ])("refuses absent or invalid approved organization %j", async (row) => {
    tx.tenantOrganization.findFirst.mockResolvedValue(row);
    await expect(
      service(false).continueOrganization(input()),
    ).rejects.toThrow();
    expect(tx.communicationEvent.create).not.toHaveBeenCalled();
  });
  it("refuses approval changes between read and encrypted write", async () => {
    const changed = organization();
    changed.settings.organizationProfileV1.approved.draft.greeting =
      "Changed approval";
    tx.tenantOrganization.findFirst
      .mockResolvedValueOnce(organization())
      .mockResolvedValue(changed);
    await expect(service(false).continueOrganization(input())).rejects.toThrow(
      "changed",
    );
    expect(tx.communicationEvent.create).not.toHaveBeenCalled();
  });
  it("does not adopt a preexisting scripted conversation into organization mode", async () => {
    tx.communicationEvent.findMany.mockResolvedValue([saved()]);
    await expect(service(false).continueOrganization(input())).rejects.toThrow(
      "changed",
    );
  });
  it("rejects caller-provided organization version before persistence", async () => {
    await expect(
      service(false).continueOrganization({
        ...input(),
        organizationApprovedAt: "forged",
      } as ReturnType<typeof input>),
    ).rejects.toThrow();
    expect(transaction).not.toHaveBeenCalled();
  });
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
  const submission = () => ({
    sessionToken: input().sessionToken,
    requestId: randomUUID(),
    expectedRevision: 1,
    draft,
    confirmed: true,
  });
  function setupReview(request = submission()) {
    const turn = saved();
    tx.communicationEvent.findMany.mockImplementation(
      (query: {
        where: { content?: { is?: { payload?: { equals?: string } } } };
      }) =>
        Promise.resolve(
          query.where.content?.is?.payload?.equals === PROTECTED_INTAKE_REVIEW
            ? []
            : [turn],
        ),
    );
    const row = {
      conversationId: scope.conversationId,
      createdAt: new Date(),
      channel: "WEBCHAT",
      direction: "INBOUND",
      provider: "OTHER",
      status: "RECEIVED",
      content: {
        tenantId: scope.tenantId,
        payload: {
          type: PROTECTED_INTAKE_REVIEW,
          version: 1,
          sessionId: scope.sessionId,
          expiresAt: credentials.verifySession(request.sessionToken).expiresAt,
          transcriptRevision: 1,
          transcriptDigest: createHash("sha256")
            .update(JSON.stringify([turn]))
            .digest("hex"),
          encryptedDraft: cipher.encrypt(JSON.stringify(draft)),
        },
      },
    };
    tx.communicationEvent.findFirst.mockResolvedValue(row);
    return { request, row, turn };
  }
  it("persists an encrypted customer review request and audit without a bearer or job", async () => {
    const { request } = setupReview();
    const result = await service().submitReview(request);
    expect(result.state).toBe("PENDING_REVIEW");
    expect(result.jobCreated).toBe(false);
    const serialized = JSON.stringify(tx.communicationEvent.create.mock.calls);
    expect(serialized).not.toContain(request.sessionToken);
    expect(serialized).not.toContain(draft.phone);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(tx.job.create).not.toHaveBeenCalled();
  });
  it.each([
    { confirmed: false },
    { expectedRevision: 0 },
    { requestId: "raw" },
    { sessionToken: "forged" },
    { actorId: "operator" },
    { review: { urgency: "HIGH" } },
  ])(
    "refuses invalid customer submission %# before persistence",
    async (override) => {
      await expect(
        service().submitReview({ ...submission(), ...override }),
      ).rejects.toThrow();
      expect(tx.communicationEvent.create).not.toHaveBeenCalled();
    },
  );
  it("replays the same durable submission without another audit", async () => {
    const { request, turn } = setupReview();
    tx.communicationEvent.findMany
      .mockResolvedValueOnce([turn])
      .mockResolvedValueOnce([{ id: request.requestId }]);
    expect((await service().submitReview(request)).requestId).toBe(
      request.requestId,
    );
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
  it("refuses replacement draft under an existing request", async () => {
    const { request, turn } = setupReview();
    tx.communicationEvent.findMany
      .mockResolvedValueOnce([turn])
      .mockResolvedValueOnce([{ id: request.requestId }]);
    await expect(
      service().submitReview({
        ...request,
        draft: { ...draft, customerName: "Replacement" },
      }),
    ).rejects.toThrow("changed");
  });
  it("operator review uses no customer credential method and returns no session identity", async () => {
    const { request } = setupReview();
    const verify = jest.spyOn(credentials, "verifySession");
    verify.mockClear();
    try {
      const result = await asOperator(() =>
        service().readReview({ requestId: request.requestId }),
      );
      expect(result.draft).toEqual(draft);
      expect(verify).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain(scope.sessionId);
      expect(JSON.stringify(result)).not.toContain(request.sessionToken);
      expect(tx.auditLog.create).not.toHaveBeenCalled();
    } finally {
      verify.mockRestore();
    }
  });
  it.each(["technician", "webchat_integration", "customer", ""])(
    "refuses operator read role %s before database",
    async (role) => {
      await expect(
        asOperator(() => service().readReview({ requestId: randomUUID() }), {
          role,
        }),
      ).rejects.toThrow();
      expect(transaction).not.toHaveBeenCalled();
    },
  );
  it("rejects a customer token or draft supplied in the operator DTO", async () => {
    await expect(
      asOperator(() => service().readReview({ ...submission() })),
    ).rejects.toThrow();
    expect(transaction).not.toHaveBeenCalled();
  });
  it.each(["expired", "ciphertext", "digest", "session", "type"])(
    "refuses changed or invalid durable review %s",
    async (kind) => {
      const { request, row } = setupReview();
      if (kind === "expired") row.content.payload.expiresAt = Date.now() - 1;
      if (kind === "ciphertext") row.content.payload.encryptedDraft = "bad";
      if (kind === "digest")
        row.content.payload.transcriptDigest = "0".repeat(64);
      if (kind === "session") row.content.payload.sessionId = "bad";
      if (kind === "type") row.content.payload.type = "message";
      await expect(
        asOperator(() =>
          service().readReview({ requestId: request.requestId }),
        ),
      ).rejects.toThrow();
    },
  );
  it("refuses missing/foreign request uniformly and scopes its query to the operator tenant", async () => {
    tx.communicationEvent.findFirst.mockResolvedValue(null);
    await expect(
      asOperator(() => service().readReview({ requestId: randomUUID() })),
    ).rejects.toThrow("changed");
    expect(tx.communicationEvent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: scope.tenantId }),
      }),
    );
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
