import { jest } from "@jest/globals";
import { AiService } from "../ai.service";
import { SanitizationService } from "../../sanitization/sanitization.service";
import { CallLogService } from "../../logging/call-log.service";
import type { IAiProvider } from "../interfaces/ai-provider.interface";
import type {
  IJobRepository,
  JobRecord,
} from "../../jobs/interfaces/job-repository.interface";
import { AiErrorHandler } from "../ai-error.handler";
import { LoggingService } from "../../logging/logging.service";
import type { TenantsService } from "../../tenants/interfaces/tenants-service.interface";
import { AiProviderService } from "../providers/ai-provider.service";
import type { IAiProviderClient } from "../providers/ai-provider.interface";
import appConfig from "../../config/app.config";
import { ToolSelectorService } from "../tools/tool-selector.service";
import { ConversationsService } from "../../conversations/conversations.service";
import { LifeSafetyService } from "../safety/life-safety.service";
import { BadRequestException } from "@nestjs/common";
import { CREATE_JOB_TOOL } from "../../jobs/tools/create-job.tool";
import type { JobNotificationService } from "../../jobs/job-notification.service";

jest.mock("fs", () => ({
  readFileSync: jest.fn(() => "System prompt"),
  existsSync: jest.fn(() => true),
}));

class ToolSelectorStub {
  getEnabledToolsForTenant = jest
    .fn<(tenantId: string) => unknown[]>()
    .mockReturnValue([]);
}

describe("AiService", () => {
  const tenantId = "8cf1e75e-14e7-4d4f-afd1-b4416a832ba1";
  const sessionId = "test-session";

  let aiProvider: jest.Mocked<IAiProvider>;
  let errorHandler: jest.Mocked<AiErrorHandler>;
  let loggingService: jest.Mocked<LoggingService>;
  let sanitizationService: SanitizationService;
  let toolSelector: ToolSelectorService;
  let jobsRepository: jest.Mocked<IJobRepository>;
  let tenantsService: jest.Mocked<TenantsService>;
  let callLogService: jest.Mocked<CallLogService>;
  let conversationsService: jest.Mocked<ConversationsService>;
  let jobNotificationService: jest.Mocked<JobNotificationService>;
  let schedulingService: {
    isInstantBookingEligible: jest.Mock;
    getAvailableSlots: jest.Mock;
  };
  let config: ReturnType<typeof appConfig>;
  let service: AiService;

  beforeEach(() => {
    aiProvider = {
      createCompletion: jest.fn(),
    } as unknown as jest.Mocked<IAiProvider>;
    errorHandler = {
      handle: jest.fn(),
    } as unknown as jest.Mocked<AiErrorHandler>;
    loggingService = {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as jest.Mocked<LoggingService>;
    sanitizationService = new SanitizationService();
    toolSelector = new ToolSelectorStub() as unknown as ToolSelectorService;
    jobsRepository = {
      createJobFromToolCall: jest.fn(),
      listJobs: jest.fn(),
    } as unknown as jest.Mocked<IJobRepository>;
    tenantsService = {
      getTenantContext: jest.fn(),
      createTenant: jest.fn(),
    } as unknown as jest.Mocked<TenantsService>;
    tenantsService.getTenantContext.mockResolvedValue({
      tenantId,
      displayName: "Demo Contractor",
      instructions: "Collect caller details and determine urgency.",
      prompt: "You are acting for Demo Contractor.",
    });
    callLogService = {
      createLog: jest.fn(),
      getRecentMessages: jest.fn(),
      clearSession: jest.fn(),
    } as unknown as jest.Mocked<CallLogService>;
    callLogService.getRecentMessages.mockResolvedValue([]);
    conversationsService = {
      ensureConversation: jest.fn(),
      linkJobToConversation: jest.fn(),
    } as unknown as jest.Mocked<ConversationsService>;
    conversationsService.ensureConversation.mockResolvedValue({
      id: "conversation-1",
    } as never);
    jobNotificationService = {
      enqueueOrphanedIntake: jest.fn(),
      enqueueJobCreated: jest.fn(),
    } as unknown as jest.Mocked<JobNotificationService>;
    schedulingService = {
      isInstantBookingEligible: jest.fn().mockReturnValue(false),
      getAvailableSlots: jest.fn(),
    };
    config = {
      environment: "test",
      openAiApiKey: "test",
      enablePreviewModel: false,
      enabledTools: [],
      aiMaxTokens: 800,
      aiMaxToolCalls: 1,
      aiTimeoutMs: 15000,
      aiMaxRetries: 1,
      port: 3000,
      databaseUrl: "postgres://user:pass@localhost:5432/db",
      adminApiToken: "token",
      devAuthEnabled: true,
      devAuthSecret: "dev-auth-secret",
      identityIssuer: "http://localhost",
      identityAudience: "signmons",
      corsOrigins: ["http://localhost:3000"],
      openAiModel: "gpt-4o-mini",
      webchatIntegrations: [],
      conversationDataEncryptionKey: "0".repeat(64),
    };

    service = new AiService(
      aiProvider,
      errorHandler,
      loggingService,
      sanitizationService,
      toolSelector,
      jobsRepository,
      tenantsService,
      callLogService,
      conversationsService,
      new LifeSafetyService(),
      schedulingService as never,
      jobNotificationService,
      config,
    );
  });

  it("returns AI reply and logs conversation", async () => {
    aiProvider.createCompletion.mockResolvedValue({
      id: "resp-1",
      choices: [
        {
          message: { role: "assistant", content: "Hello there!" },
        },
      ],
    } as never);

    const response = await service.triage(
      tenantId,
      sessionId,
      "Hello there, I need help.",
    );

    expect(response).toEqual({ status: "reply", reply: "Hello there!" });
    expect(callLogService.createLog).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        sessionId,
        conversationId: "conversation-1",
        transcript: "Hello there, I need help.",
        aiResponse: "Hello there!",
        metadata: expect.objectContaining({ openAIResponseId: "resp-1" }),
      }),
    );
  });

  it("returns deterministic safety guidance without calling the AI provider", async () => {
    const response = await service.triage(
      tenantId,
      sessionId,
      "I smell gas near the furnace.",
    );

    expect(response).toMatchObject({
      status: "safety_escalation",
      requiresHumanHandoff: true,
      emergencyServicesRecommended: true,
    });
    expect(aiProvider.createCompletion).not.toHaveBeenCalled();
  });

  it("routes create_job tool calls to the job repository", async () => {
    aiProvider.createCompletion.mockResolvedValue({
      id: "resp-2",
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: {
                  name: "create_job",
                  arguments: JSON.stringify({
                    customerName: "Alice",
                    phone: "123",
                    issueCategory: "HEATING",
                    urgency: "EMERGENCY",
                  }),
                },
              },
            ],
          },
        },
      ],
    } as never);

    const jobRecord: JobRecord = {
      id: "job-1",
      tenantId,
      customerName: "Alice",
      phone: "123",
      issueCategory: "HEATING",
      urgency: "EMERGENCY",
      status: "PENDING" as const,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    jobsRepository.createJobFromToolCall.mockResolvedValue(jobRecord);

    const response = await service.triage(tenantId, sessionId, "Create job.");

    expect(response).toEqual({
      status: "job_created",
      job: jobRecord,
      message:
        "Service request received — reference JOB1. Eternity will follow up using the contact information provided.",
    });
    expect(jobsRepository.createJobFromToolCall).toHaveBeenCalledWith({
      tenantId,
      sessionId,
      rawArgs: expect.any(String),
      deferInitialNotification: true,
    });
    expect(callLogService.createLog).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        sessionId,
        jobId: jobRecord.id,
        conversationId: "conversation-1",
        metadata: expect.objectContaining({ toolName: "create_job" }),
      }),
    );
    expect(conversationsService.linkJobToConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        conversationId: "conversation-1",
        jobId: jobRecord.id,
      }),
    );
    expect(callLogService.clearSession).toHaveBeenCalledWith(
      tenantId,
      sessionId,
      "conversation-1",
    );
    expect(jobNotificationService.enqueueJobCreated).toHaveBeenCalledWith(
      jobRecord,
    );
  });

  it("retains opener details and forces job creation after the residential answer", async () => {
    (
      toolSelector.getEnabledToolsForTenant as jest.MockedFunction<
        ToolSelectorService["getEnabledToolsForTenant"]
      >
    ).mockReturnValue([CREATE_JOB_TOOL]);
    callLogService.getRecentMessages.mockResolvedValue([
      {
        role: "user",
        content: "Hello this is Debynyhan Banks, my AC is blowing hot air.",
        createdAt: new Date("2026-08-30T12:00:00Z"),
      },
      {
        role: "assistant",
        content: "What is the best callback number?",
        createdAt: new Date("2026-08-30T12:00:01Z"),
      },
      {
        role: "user",
        content: "216-703-3183",
        createdAt: new Date("2026-08-30T12:00:02Z"),
      },
      {
        role: "assistant",
        content: "What is the service address?",
        createdAt: new Date("2026-08-30T12:00:03Z"),
      },
      {
        role: "user",
        content: "2009 East 200th Street, Euclid, Ohio 44119",
        createdAt: new Date("2026-08-30T12:00:04Z"),
      },
    ]);
    aiProvider.createCompletion.mockResolvedValue({
      id: "resp-memory-job",
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call-memory-job",
                type: "function",
                function: {
                  name: "create_job",
                  arguments: JSON.stringify({
                    customerName: "Debynyhan Banks",
                    phone: "216-703-3183",
                    address: "2009 East 200th Street, Euclid, Ohio 44119",
                    issueCategory: "COOLING",
                    urgency: "STANDARD",
                    description: "AC is blowing hot air",
                    propertyType: "RESIDENTIAL",
                    serviceIntent: "REPAIR",
                  }),
                },
              },
            ],
          },
        },
      ],
    } as never);
    const jobRecord: JobRecord = {
      id: "memory-job-1",
      tenantId,
      customerName: "Debynyhan Banks",
      phone: "+12167033183",
      address: "2009 East 200th Street, Euclid, Ohio 44119",
      issueCategory: "COOLING",
      urgency: "STANDARD",
      description: "AC is blowing hot air",
      propertyType: "RESIDENTIAL",
      serviceIntent: "REPAIR",
      status: "CREATED",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    jobsRepository.createJobFromToolCall.mockResolvedValue(jobRecord);

    await service.triage(tenantId, sessionId, "Residential");

    expect(callLogService.getRecentMessages).toHaveBeenCalledWith(
      tenantId,
      sessionId,
      40,
    );
    expect(aiProvider.createCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        toolChoice: {
          type: "function",
          function: { name: "create_job" },
        },
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "system",
            content: expect.stringContaining("Already supplied"),
          }),
        ]),
      }),
    );
  });

  it("blocks a priority question and asks only for the next missing field", async () => {
    callLogService.getRecentMessages.mockResolvedValue([
      {
        role: "user",
        content: "Hello, this is Marti. My AC is blowing hot air.",
        createdAt: new Date("2026-08-30T12:00:00Z"),
      },
      {
        role: "assistant",
        content: "What is the best callback number?",
        createdAt: new Date("2026-08-30T12:00:01Z"),
      },
      {
        role: "user",
        content: "216-555-2222",
        createdAt: new Date("2026-08-30T12:00:02Z"),
      },
      {
        role: "assistant",
        content: "What is the service address?",
        createdAt: new Date("2026-08-30T12:00:03Z"),
      },
      {
        role: "user",
        content: "2009 East 200th Street, Euclid, Ohio 44119",
        createdAt: new Date("2026-08-30T12:00:04Z"),
      },
    ]);
    aiProvider.createCompletion.mockResolvedValue({
      id: "resp-repeat-priority",
      choices: [
        {
          message: {
            role: "assistant",
            content:
              "Is this an emergency, high priority, or a standard request?",
          },
        },
      ],
    } as never);

    const response = await service.triage(tenantId, sessionId, "Thanks");

    expect(response).toEqual({
      status: "reply",
      reply:
        "Is the service location a home, a business, or a managed property?",
    });
    expect(loggingService.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "ai_repeat_question_blocked" }),
      AiService.name,
    );
  });

  it("sends only the appointment email path when live slots are offered", async () => {
    aiProvider.createCompletion.mockResolvedValue({
      id: "resp-availability-job",
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call-availability-job",
                type: "function",
                function: {
                  name: "create_job",
                  arguments: JSON.stringify({
                    customerName: "Alice",
                    phone: "2165551212",
                    address: "1 Main Street, Euclid, Ohio 44119",
                    issueCategory: "COOLING",
                    urgency: "STANDARD",
                    description: "AC blowing hot air",
                    propertyType: "RESIDENTIAL",
                    serviceIntent: "REPAIR",
                  }),
                },
              },
            ],
          },
        },
      ],
    } as never);
    const jobRecord: JobRecord = {
      id: "slot-job-1",
      tenantId,
      customerName: "Alice",
      phone: "+12165551212",
      address: "1 Main Street, Euclid, Ohio 44119",
      issueCategory: "COOLING",
      urgency: "STANDARD",
      description: "AC blowing hot air",
      propertyType: "RESIDENTIAL",
      serviceIntent: "REPAIR",
      status: "CREATED",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    jobsRepository.createJobFromToolCall.mockResolvedValue(jobRecord);
    schedulingService.isInstantBookingEligible.mockReturnValue(true);
    schedulingService.getAvailableSlots.mockResolvedValue([
      {
        token: "slot-token",
        start: "2026-08-31T12:00:00.000Z",
        end: "2026-08-31T15:00:00.000Z",
        label: "Mon, Aug 31, 8–11 AM",
      },
    ]);

    const response = await service.triage(tenantId, sessionId, "Create job");

    expect(response).toMatchObject({ status: "availability" });
    expect(jobNotificationService.enqueueJobCreated).not.toHaveBeenCalled();
  });

  it("forces job creation when the assistant claims a completed intake without calling the tool", async () => {
    (
      toolSelector.getEnabledToolsForTenant as jest.MockedFunction<
        ToolSelectorService["getEnabledToolsForTenant"]
      >
    ).mockReturnValue([CREATE_JOB_TOOL]);
    aiProvider.createCompletion
      .mockResolvedValueOnce({
        id: "resp-unsubmitted",
        model: "gpt-4o-mini",
        choices: [
          {
            message: {
              role: "assistant",
              content:
                "Just to confirm, I have: Name: Debynyhan Banks; Phone: received; Address: received; Issue: furnace blowing cold air; Property Type: Residential; Service Intent: Repair. I will pass this information to our human team for follow-up.",
            },
          },
        ],
      } as never)
      .mockResolvedValueOnce({
        id: "resp-forced-job",
        model: "gpt-4o-mini",
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call-forced-job",
                  type: "function",
                  function: {
                    name: "create_job",
                    arguments: JSON.stringify({
                      customerName: "Debynyhan Banks",
                      phone: "216-703-3183",
                      address: "2099 W Recher Ave, Euclid, OH 44119",
                      issueCategory: "HEATING",
                      urgency: "STANDARD",
                      description: "Furnace is blowing cold air",
                      propertyType: "RESIDENTIAL",
                      serviceIntent: "REPAIR",
                    }),
                  },
                },
              ],
            },
          },
        ],
      } as never);
    const jobRecord: JobRecord = {
      id: "a1b2c3d4-e5f6-4789-9012-345678901234",
      tenantId,
      customerName: "Debynyhan Banks",
      phone: "+12167033183",
      address: "2099 W Recher Ave, Euclid, OH 44119",
      issueCategory: "HEATING",
      urgency: "STANDARD",
      description: "Furnace is blowing cold air",
      propertyType: "RESIDENTIAL",
      serviceIntent: "REPAIR",
      status: "CREATED",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    jobsRepository.createJobFromToolCall.mockResolvedValue(jobRecord);

    const response = await service.triage(tenantId, sessionId, "Repair");

    expect(response).toMatchObject({
      status: "job_created",
      job: jobRecord,
      message: expect.stringContaining("A1B2C3D4"),
    });
    expect(aiProvider.createCompletion).toHaveBeenCalledTimes(2);
    expect(aiProvider.createCompletion).toHaveBeenLastCalledWith(
      expect.objectContaining({
        tools: [CREATE_JOB_TOOL],
        toolChoice: {
          type: "function",
          function: { name: "create_job" },
        },
      }),
    );
    expect(loggingService.log).toHaveBeenCalledWith(
      expect.objectContaining({ event: "intake_auto_finalized" }),
      AiService.name,
    );
  });

  it("states that the request was not saved and alerts operations when forced creation fails", async () => {
    (
      toolSelector.getEnabledToolsForTenant as jest.MockedFunction<
        ToolSelectorService["getEnabledToolsForTenant"]
      >
    ).mockReturnValue([CREATE_JOB_TOOL]);
    aiProvider.createCompletion
      .mockResolvedValueOnce({
        id: "resp-unsubmitted",
        choices: [
          {
            message: {
              role: "assistant",
              content:
                "Just to confirm, I have: Name: Debynyhan Banks; Phone: received; Address: received; Issue: furnace blowing cold air; Property Type: Residential; Service Intent: Repair. We received your request and our team will follow up.",
            },
          },
        ],
      } as never)
      .mockRejectedValueOnce(new Error("provider unavailable"));

    const response = await service.triage(tenantId, sessionId, "Repair");

    expect(response).toMatchObject({
      status: "needs_correction",
      reply: expect.stringContaining("has not been sent"),
    });
    expect(jobNotificationService.enqueueOrphanedIntake).toHaveBeenCalledWith(
      sessionId,
      expect.stringContaining("provider unavailable"),
    );
    expect(loggingService.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "orphaned_intake_detected" }),
      AiService.name,
    );
  });

  it("does not force a job from an unsupported follow-up promise without confirmed fields", async () => {
    (
      toolSelector.getEnabledToolsForTenant as jest.MockedFunction<
        ToolSelectorService["getEnabledToolsForTenant"]
      >
    ).mockReturnValue([CREATE_JOB_TOOL]);
    aiProvider.createCompletion.mockResolvedValue({
      id: "resp-premature-follow-up",
      choices: [
        {
          message: {
            role: "assistant",
            content: "Our team will follow up with you soon.",
          },
        },
      ],
    } as never);

    const response = await service.triage(tenantId, sessionId, "I need help");

    expect(response).toMatchObject({
      status: "needs_correction",
      reply: expect.stringContaining("has not been sent"),
    });
    expect(aiProvider.createCompletion).toHaveBeenCalledTimes(1);
    expect(jobsRepository.createJobFromToolCall).not.toHaveBeenCalled();
    expect(jobNotificationService.enqueueOrphanedIntake).toHaveBeenCalled();
  });

  it("turns invalid job fields into a recoverable correction question", async () => {
    aiProvider.createCompletion.mockResolvedValue({
      id: "resp-correction",
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call-correction",
                type: "function",
                function: {
                  name: "create_job",
                  arguments: JSON.stringify({
                    customerName: "Alice",
                    phone: "***-***-3183",
                    issueCategory: "HEATING",
                    urgency: "STANDARD",
                    description: "No heat",
                    preferredTime: "Tuesday after 3",
                  }),
                },
              },
            ],
          },
        },
      ],
    } as never);
    jobsRepository.createJobFromToolCall.mockRejectedValue(
      new BadRequestException({
        message: "Job payload validation failed.",
        invalidFields: ["phone"],
      }),
    );

    const response = await service.triage(
      tenantId,
      sessionId,
      "Tuesday after 3 works.",
    );

    expect(response).toMatchObject({
      status: "needs_correction",
      invalidFields: ["phone"],
      reply: expect.stringContaining("10-digit callback number"),
    });
    expect(callLogService.createLog).toHaveBeenCalledWith(
      expect.objectContaining({
        transcript: "Tuesday after 3 works.",
        metadata: expect.objectContaining({
          responseType: "needs_correction",
          invalidFields: ["phone"],
        }),
      }),
    );
    expect(errorHandler.handle).not.toHaveBeenCalled();
  });

  it("delegates provider errors to the AiErrorHandler", async () => {
    aiProvider.createCompletion.mockRejectedValue(new Error("network"));
    await service.triage(tenantId, sessionId, "Hello");
    expect(errorHandler.handle).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        stage: "triage",
        tenantId,
      }),
    );
  });

  it("fails closed when AI returns an empty reply", async () => {
    aiProvider.createCompletion.mockResolvedValue({
      id: "resp-3",
      choices: [
        {
          message: { role: "assistant", content: null },
        },
      ],
    } as never);

    await service.triage(tenantId, sessionId, "Hello");
    expect(loggingService.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "ai.invalid_output",
        tenantId,
        reason: "empty_reply",
      }),
      AiService.name,
    );
    expect(errorHandler.handle).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        stage: "triage",
        tenantId,
      }),
    );
  });

  it("fails closed when tool args are invalid JSON", async () => {
    aiProvider.createCompletion.mockResolvedValue({
      id: "resp-4",
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call-2",
                type: "function",
                function: {
                  name: "create_job",
                  arguments: "{not-json}",
                },
              },
            ],
          },
        },
      ],
    } as never);
    jobsRepository.createJobFromToolCall.mockImplementation(() => {
      throw new Error("Invalid job payload.");
    });

    await service.triage(tenantId, sessionId, "Create job.");
    expect(errorHandler.handle).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        stage: "tool_call",
        tenantId,
      }),
    );
  });

  it("logs refusals when the model declines", async () => {
    aiProvider.createCompletion.mockResolvedValue({
      id: "resp-5",
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            refusal: "policy_violation",
          },
        },
      ],
    } as never);

    await service.triage(tenantId, sessionId, "Disallowed request.");

    expect(loggingService.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "ai.refusal",
        tenantId,
        reason: "policy_violation",
      }),
      AiService.name,
    );
    expect(errorHandler.handle).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        stage: "triage",
        tenantId,
      }),
    );
  });
});

describe("AiProviderService", () => {
  const mockConfig: ReturnType<typeof appConfig> = {
    environment: "test",
    openAiApiKey: "test",
    enablePreviewModel: true,
    enabledTools: [],
    aiMaxTokens: 800,
    aiMaxToolCalls: 1,
    aiTimeoutMs: 15000,
    aiMaxRetries: 1,
    port: 3000,
    databaseUrl: "postgres://user:pass@localhost:5432/db",
    adminApiToken: "token",
    devAuthEnabled: true,
    devAuthSecret: "dev-auth-secret",
    identityIssuer: "http://localhost",
    identityAudience: "signmons",
    corsOrigins: ["http://localhost:3000"],
    openAiModel: "gpt-4o-mini",
    webchatIntegrations: [],
    conversationDataEncryptionKey: "0".repeat(64),
  };

  let client: jest.Mocked<IAiProviderClient>;
  let errorHandler: jest.Mocked<AiErrorHandler>;
  let loggingService: jest.Mocked<LoggingService>;
  let provider: AiProviderService;

  beforeEach(() => {
    client = {
      createCompletion: jest.fn(),
    } as unknown as jest.Mocked<IAiProviderClient>;
    errorHandler = {
      handle: jest.fn(),
    } as unknown as jest.Mocked<AiErrorHandler>;
    errorHandler.handle.mockImplementation((error) => {
      throw (error as Error) ?? new Error("handled");
    });
    loggingService = {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as jest.Mocked<LoggingService>;

    provider = new AiProviderService(
      client,
      mockConfig,
      errorHandler,
      loggingService,
    );
  });

  it("falls back to default model when preview model fails", async () => {
    const fallbackResponse = { id: "resp", choices: [] } as never;
    client.createCompletion
      .mockRejectedValueOnce(new Error("model not found"))
      .mockRejectedValueOnce(new Error("model not found"))
      .mockResolvedValueOnce(fallbackResponse);

    const response = await provider.createCompletion({
      messages: [],
    });

    expect(response).toBe(fallbackResponse);
    expect(loggingService.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "ai.preview_fallback",
        model: "gpt-5.1-codex",
        fallbackModel: "gpt-4o-mini",
        reason: "preview_unavailable",
      }),
      AiProviderService.name,
    );
    const previewLogs = loggingService.warn.mock.calls.filter(
      ([payload]) =>
        typeof payload === "object" &&
        payload !== null &&
        (payload as { event?: string }).event === "ai.preview_fallback",
    );
    expect(previewLogs).toHaveLength(1);
    expect(errorHandler.handle).not.toHaveBeenCalled();
  });

  it("reports errors when fallback also fails", async () => {
    client.createCompletion
      .mockRejectedValueOnce(new Error("model not found"))
      .mockRejectedValueOnce(new Error("model not found"))
      .mockRejectedValueOnce(new Error("fallback failed"))
      .mockRejectedValueOnce(new Error("fallback failed"));

    await expect(provider.createCompletion({ messages: [] })).rejects.toThrow(
      "fallback failed",
    );

    expect(errorHandler.handle).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        stage: "completion",
        metadata: expect.objectContaining({ model: "gpt-4o-mini" }),
      }),
    );
  });

  it("retries once when the provider fails before succeeding", async () => {
    const response = { id: "resp", choices: [] } as never;
    client.createCompletion
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce(response);

    const result = await provider.createCompletion({ messages: [] });

    expect(result).toBe(response);
    expect(client.createCompletion).toHaveBeenCalledTimes(2);
    expect(loggingService.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "ai_budget_triggered",
        budget: "AI_MAX_RETRIES",
        limit: mockConfig.aiMaxRetries,
        attempt: 1,
      }),
      AiProviderService.name,
    );
  });
});
