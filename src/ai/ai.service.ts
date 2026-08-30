import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
} from "@nestjs/common";
import type { ConfigType } from "@nestjs/config";
import OpenAI from "openai";
import { readFileSync } from "fs";
import { join } from "path";
import { AI_PROVIDER } from "./ai.constants";
import type { IAiProvider } from "./interfaces/ai-provider.interface";
import { JOB_REPOSITORY } from "../jobs/jobs.constants";
import type { IJobRepository } from "../jobs/interfaces/job-repository.interface";
import { TENANTS_SERVICE } from "../tenants/tenants.constants";
import type { TenantsService } from "../tenants/interfaces/tenants-service.interface";
import { AiErrorHandler } from "./ai-error.handler";
import { LoggingService } from "../logging/logging.service";
import { SanitizationService } from "../sanitization/sanitization.service";
import { ToolSelectorService } from "./tools/tool-selector.service";
import { CallLogService } from "../logging/call-log.service";
import { ConversationsService } from "../conversations/conversations.service";
import appConfig from "../config/app.config";
import { getRequestContext } from "../common/context/request-context";
import { LifeSafetyService } from "./safety/life-safety.service";
import { SchedulingService } from "../scheduling/scheduling.service";
import { JobNotificationService } from "../jobs/job-notification.service";

type IntakeField =
  | "name"
  | "phone"
  | "address"
  | "description"
  | "category"
  | "propertyType"
  | "serviceIntent"
  | "urgency";

interface IntakeSnapshot {
  collected: Set<IntakeField>;
  residential: boolean;
  heatingOrCooling: boolean;
  repairLike: boolean;
  volunteeredEmergency: boolean;
}

@Injectable()
export class AiService {
  private readonly systemPrompt: string | null;

  constructor(
    @Inject(AI_PROVIDER) private readonly aiProviderService: IAiProvider,
    private readonly errorHandler: AiErrorHandler,
    private readonly loggingService: LoggingService,
    private readonly sanitizationService: SanitizationService,
    private readonly toolSelector: ToolSelectorService,
    @Inject(JOB_REPOSITORY) private readonly jobsRepository: IJobRepository,
    @Inject(TENANTS_SERVICE) private readonly tenantsService: TenantsService,
    private readonly callLogService: CallLogService,
    private readonly conversationsService: ConversationsService,
    private readonly lifeSafetyService: LifeSafetyService,
    private readonly schedulingService: SchedulingService,
    private readonly jobNotificationService: JobNotificationService,
    @Inject(appConfig.KEY)
    private readonly config: ConfigType<typeof appConfig>,
  ) {
    try {
      const promptPath = join(__dirname, "prompts", "calldeskSystemPrompt.txt");
      this.systemPrompt = readFileSync(promptPath, "utf8");
    } catch (error) {
      this.loggingService.error(
        "Failed to load system prompt.",
        error instanceof Error ? error : undefined,
        AiService.name,
      );
      this.systemPrompt = null;
    }
  }

  async triage(tenantId: string, sessionId: string, userMessage: string) {
    if (!this.systemPrompt) {
      throw new InternalServerErrorException(
        "AI is not configured on the server.",
      );
    }

    let safeTenantId: string | undefined;
    let safeSessionId: string | undefined;
    let openAIResponseId: string | undefined;
    const incomingMessageLength = userMessage?.length ?? 0;
    try {
      safeTenantId = this.sanitizationService.sanitizeIdentifier(tenantId);
      const safeUserMessage =
        this.sanitizationService.sanitizeText(userMessage);
      safeSessionId = this.sanitizationService.sanitizeIdentifier(sessionId);

      if (!safeTenantId) {
        throw new BadRequestException("Invalid tenant identifier.");
      }

      if (!safeSessionId) {
        throw new BadRequestException("Invalid session identifier.");
      }

      if (!safeUserMessage) {
        throw new BadRequestException("Message must contain text.");
      }

      const tenantContext =
        await this.tenantsService.getTenantContext(safeTenantId);
      const conversation = await this.conversationsService.ensureConversation(
        safeTenantId,
        safeSessionId,
      );
      const safetyEscalation = this.lifeSafetyService.assess(safeUserMessage);
      if (safetyEscalation) {
        await this.callLogService.createLog({
          tenantId: safeTenantId,
          sessionId: safeSessionId,
          conversationId: conversation.id,
          transcript: safeUserMessage,
          aiResponse: safetyEscalation.reply,
          metadata: {
            sessionId: safeSessionId,
            responseType: safetyEscalation.status,
          },
        });
        return safetyEscalation;
      }
      const tenantContextPrompt = tenantContext.prompt;
      const recentMessages = await this.callLogService.getRecentMessages(
        safeTenantId,
        safeSessionId,
        40,
      );
      const conversationHistory: OpenAI.ChatCompletionMessageParam[] =
        recentMessages.map((entry) => ({
          role: entry.role,
          content: entry.content,
        }));
      const intakeSnapshot = this.buildIntakeSnapshot(
        conversationHistory,
        safeUserMessage,
      );
      const messages: OpenAI.ChatCompletionMessageParam[] = [
        { role: "system", content: this.systemPrompt },
        { role: "system", content: tenantContextPrompt },
        {
          role: "system",
          content: this.buildIntakeMemoryPrompt(intakeSnapshot),
        },
        ...conversationHistory,
        { role: "user", content: safeUserMessage },
      ];

      const tools = this.toolSelector.getEnabledToolsForTenant(safeTenantId);
      const createJobTool = tools.find(
        (tool) => tool.function.name === "create_job",
      );
      const shouldCreateResidentialBooking =
        Boolean(createJobTool) &&
        this.isResidentialBookingReady(intakeSnapshot);
      const response = await this.aiProviderService.createCompletion({
        messages,
        tools: tools.length ? tools : undefined,
        toolChoice: shouldCreateResidentialBooking
          ? {
              type: "function",
              function: { name: "create_job" },
            }
          : undefined,
        maxTokens: this.config.aiMaxTokens,
      });
      openAIResponseId = response.id;
      const choice = response.choices[0];
      const { message } = choice;

      const responseModel = response.model;
      const validation = this.validateAssistantMessage(
        message,
        safeTenantId,
        responseModel,
      );

      if (validation.type === "tool") {
        const toolCall = validation.toolCall;
        if (toolCall.function.name) {
          return this.handleToolCall(
            safeTenantId,
            safeSessionId,
            conversation.id,
            toolCall.function.name,
            toolCall.function.arguments ?? undefined,
            safeUserMessage,
            responseModel,
          );
        }

        return {
          status: "tool_called",
          toolName: toolCall.type,
          rawArgs: toolCall.function.arguments ?? null,
        };
      }

      const guardedReply = this.guardAgainstRepeatedQuestion(
        validation.reply,
        intakeSnapshot,
      );
      if (guardedReply !== validation.reply) {
        this.loggingService.warn(
          {
            event: "ai_repeat_question_blocked",
            tenantId: safeTenantId,
            sessionId: safeSessionId,
          },
          AiService.name,
        );
      }
      const reply = {
        status: "reply" as const,
        reply: guardedReply,
      };

      if (tools.length && this.looksLikeSubmissionClaim(guardedReply)) {
        const finalized = await this.forceJobFinalization({
          tenantId: safeTenantId,
          sessionId: safeSessionId,
          conversationId: conversation.id,
          userMessage: safeUserMessage,
          responseModel,
          messages,
          assistantReply: guardedReply,
          tools,
        });
        if (finalized) return finalized;
      }

      await this.callLogService.createLog({
        tenantId: safeTenantId,
        sessionId: safeSessionId,
        conversationId: conversation.id,
        transcript: userMessage,
        aiResponse: guardedReply,
        metadata: {
          sessionId: safeSessionId,
          openAIResponseId,
        },
      });

      return reply;
    } catch (error) {
      this.errorHandler.handle(error, {
        tenantId: safeTenantId ?? tenantId,
        metadata: {
          sessionId: safeSessionId ?? sessionId,
        },
        stage: "triage",
        messageLength: incomingMessageLength,
        openAIResponseId,
      });
    }
  }

  private looksLikeSubmissionClaim(reply: string): boolean {
    return [
      /\b(?:we|i) (?:have )?received your (?:message|request)\b/i,
      /\brequest (?:has been |was )?(?:submitted|received|recorded|saved)\b/i,
      /\b(?:will|i'll) (?:pass|send|forward) (?:this|your) information\b/i,
      /\b(?:our|the human) team (?:will|'ll) (?:follow up|reach out|contact you)\b/i,
    ].some((pattern) => pattern.test(reply));
  }

  private buildIntakeSnapshot(
    history: OpenAI.ChatCompletionMessageParam[],
    currentMessage: string,
  ): IntakeSnapshot {
    const collected = new Set<IntakeField>();
    const exchanges = [
      ...history
        .filter(
          (
            message,
          ): message is
            | OpenAI.ChatCompletionSystemMessageParam
            | OpenAI.ChatCompletionUserMessageParam
            | OpenAI.ChatCompletionAssistantMessageParam =>
            ["user", "assistant"].includes(message.role) &&
            typeof message.content === "string",
        )
        .map((message) => ({
          role: message.role,
          text: message.content as string,
        })),
      { role: "user" as const, text: currentMessage },
    ];
    const customerText = exchanges
      .filter((entry) => entry.role === "user")
      .map((entry) => entry.text)
      .join(" \n ");
    const normalizedCustomerText = customerText.toLowerCase();

    if (
      /\b(?:my name is|this is)\s+[a-z][a-z'-]+(?:\s+[a-z][a-z'-]+){0,2}(?=\s+(?:and|my|i|with|the)\b|[,.!?]|$)/i.test(
        customerText,
      )
    ) {
      collected.add("name");
    }
    if (
      /(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/.test(
        customerText,
      )
    ) {
      collected.add("phone");
    }
    if (
      /\b\d{1,6}\s+[a-z0-9][a-z0-9.' -]{2,}(?:\b(?:st|street|rd|road|ave|avenue|blvd|boulevard|dr|drive|ln|lane|ct|court|way|pl|place)\b|\s\d{5}\b)/i.test(
        customerText,
      )
    ) {
      collected.add("address");
    }
    if (/\b(?:residential|my home|house|homeowner)\b/i.test(customerText)) {
      collected.add("propertyType");
    }
    if (
      /\b(?:commercial|business|managed property|apartment building|multifamily)\b/i.test(
        customerText,
      )
    ) {
      collected.add("propertyType");
    }
    if (
      /\b(?:ac|a\/c|air condition(?:er|ing)?|cooling|furnace|heat(?:ing)?|boiler|refrigerat(?:or|ion))\b/i.test(
        customerText,
      )
    ) {
      collected.add("category");
    }
    if (
      /\b(?:broken|broke|not working|doesn'?t work|don'?t work|blowing (?:hot|cold)|no (?:heat|cooling|air)|leak(?:ing)?|making (?:a )?(?:noise|sound)|won'?t (?:start|run|turn on)|stopped working|it'?s down)\b/i.test(
        customerText,
      )
    ) {
      collected.add("description");
    }
    if (
      /\b(?:repair|fix(?: it)?|diagnostic|install(?:ation)?|maintenance|replace(?:ment)?)\b/i.test(
        customerText,
      )
    ) {
      collected.add("serviceIntent");
    }
    if (/\bemergency\b/i.test(customerText)) collected.add("urgency");

    for (let index = 1; index < exchanges.length; index += 1) {
      const previous = exchanges[index - 1];
      const current = exchanges[index];
      if (previous.role !== "assistant" || current.role !== "user") continue;
      const question = previous.text.toLowerCase();
      const answer = current.text.trim();
      if (!answer) continue;
      if (
        /\b(?:your name|full name|what name|who am i speaking)\b/.test(question)
      )
        collected.add("name");
      if (/\b(?:phone|callback number|best number)\b/.test(question))
        collected.add("phone");
      if (/\b(?:address|service location|where.*service)\b/.test(question))
        collected.add("address");
      if (
        /\b(?:describe|symptom|what.*(?:wrong|problem|doing)|issue.*experiencing)\b/.test(
          question,
        )
      )
        collected.add("description");
      if (
        /\b(?:type of equipment|heating, cooling|equipment.*involved|service category)\b/.test(
          question,
        )
      )
        collected.add("category");
      if (
        /\b(?:property type|residential, commercial|home, business|managed property)\b/.test(
          question,
        )
      )
        collected.add("propertyType");
      if (
        /\b(?:service intent|diagnostic, repair|installation.*maintenance|looking for a)\b/.test(
          question,
        )
      )
        collected.add("serviceIntent");
      if (/\b(?:priority|emergency.*standard|urgent)\b/.test(question))
        collected.add("urgency");
    }

    const residential = /\b(?:residential|my home|house|homeowner)\b/i.test(
      customerText,
    );
    const heatingOrCooling =
      /\b(?:ac|a\/c|air condition(?:er|ing)?|cooling|furnace|heat(?:ing)?)\b/i.test(
        customerText,
      );
    const repairLike =
      /\b(?:broken|broke|not working|doesn'?t work|don'?t work|blowing (?:hot|cold)|no (?:heat|cooling|air)|repair|fix(?: it)?|stopped working|it'?s down)\b/i.test(
        customerText,
      );
    const volunteeredEmergency = /\bemergency\b/i.test(normalizedCustomerText);
    if (repairLike) collected.add("serviceIntent");
    return {
      collected,
      residential,
      heatingOrCooling,
      repairLike,
      volunteeredEmergency,
    };
  }

  private buildIntakeMemoryPrompt(snapshot: IntakeSnapshot): string {
    const labels: Record<IntakeField, string> = {
      name: "customer name",
      phone: "callback number",
      address: "service address",
      description: "problem description",
      category: "equipment/service category",
      propertyType: "property type",
      serviceIntent: "service intent",
      urgency: "urgency",
    };
    const supplied = [...snapshot.collected].map((field) => labels[field]);
    const residentialRule =
      snapshot.heatingOrCooling && snapshot.repairLike
        ? `This is a heating/cooling failure. Infer REPAIR or DIAGNOSTIC. Never ask the customer to choose a priority level or service intent. ${
            snapshot.volunteeredEmergency
              ? "The customer volunteered that this is an emergency; preserve EMERGENCY without asking them to classify it again."
              : "Use STANDARD because the customer has not volunteered a qualifying emergency condition."
          }`
        : "Never ask the customer to label a request emergency, high priority, or standard; infer urgency from facts they volunteer.";
    return [
      "AUTHORITATIVE INTAKE MEMORY:",
      `Already supplied: ${supplied.length ? supplied.join(", ") : "none yet"}.`,
      "Never ask for an already supplied field again, even if it appeared early in the conversation.",
      residentialRule,
      this.isResidentialBookingReady(snapshot)
        ? "All fields required for a residential appointment are present. Call create_job now so the customer can choose a live time."
        : "Ask only for the next genuinely missing required field.",
    ].join(" ");
  }

  private isResidentialBookingReady(snapshot: IntakeSnapshot): boolean {
    return (
      snapshot.residential &&
      snapshot.heatingOrCooling &&
      snapshot.repairLike &&
      [
        "name",
        "phone",
        "address",
        "description",
        "category",
        "propertyType",
      ].every((field) => snapshot.collected.has(field as IntakeField))
    );
  }

  private guardAgainstRepeatedQuestion(
    reply: string,
    snapshot: IntakeSnapshot,
  ): string {
    const normalized = reply.toLowerCase();
    const asksQuestion =
      reply.includes("?") ||
      /\b(?:please provide|can you|could you|what is|what's|let me know|tell me|is this)\b/.test(
        normalized,
      );
    if (!asksQuestion) return reply;
    const asksFor: Array<[IntakeField, RegExp]> = [
      ["name", /\b(?:your name|full name|what name|provide.*name)\b/],
      ["phone", /\b(?:phone number|callback number|best number)\b/],
      ["address", /\b(?:your address|service address|address where)\b/],
      [
        "description",
        /\b(?:describe.*(?:issue|problem|symptom)|what problem|what.*experiencing|what.*wrong)\b/,
      ],
      [
        "category",
        /\b(?:type of equipment|heating, cooling|equipment.*involved)\b/,
      ],
      [
        "propertyType",
        /\b(?:property type|residential, commercial|home, business|managed property)\b/,
      ],
      [
        "serviceIntent",
        /\b(?:service intent|diagnostic, repair|repair, installation|looking for.*(?:diagnostic|repair))\b/,
      ],
      [
        "urgency",
        /\b(?:priority level|emergency.*(?:high priority|standard)|high priority.*standard)\b/,
      ],
    ];
    const repeatsCollected = asksFor.some(
      ([field, pattern]) =>
        snapshot.collected.has(field) && pattern.test(normalized),
    );
    const asksForbiddenPriority = asksFor[7][1].test(normalized);
    const asksInferredIntent =
      snapshot.heatingOrCooling &&
      snapshot.repairLike &&
      asksFor[6][1].test(normalized);
    if (!repeatsCollected && !asksForbiddenPriority && !asksInferredIntent) {
      return reply;
    }
    return this.nextMissingQuestion(snapshot);
  }

  private nextMissingQuestion(snapshot: IntakeSnapshot): string {
    if (!snapshot.collected.has("name")) {
      return "What name should we put on the service request?";
    }
    if (!snapshot.collected.has("phone")) {
      return "What is the best 10-digit callback number?";
    }
    if (!snapshot.collected.has("address")) {
      return "What is the service address, including the ZIP code?";
    }
    if (!snapshot.collected.has("category")) {
      return "What type of equipment needs service—for example, air conditioning, furnace, boiler, or refrigeration?";
    }
    if (!snapshot.collected.has("description")) {
      return "What is the equipment doing or not doing?";
    }
    if (!snapshot.collected.has("propertyType")) {
      return "Is the service location a home, a business, or a managed property?";
    }
    return "I have the required details. I’m preparing the available appointment times now.";
  }

  private async forceJobFinalization(params: {
    tenantId: string;
    sessionId: string;
    conversationId: string;
    userMessage: string;
    responseModel?: string;
    messages: OpenAI.ChatCompletionMessageParam[];
    assistantReply: string;
    tools: OpenAI.ChatCompletionTool[];
  }) {
    const createJobTool = params.tools.find(
      (tool) => tool.function.name === "create_job",
    );
    if (!createJobTool) return null;

    this.loggingService.warn(
      {
        event: "intake_completion_without_job",
        tenantId: params.tenantId,
        sessionId: params.sessionId,
      },
      AiService.name,
    );

    if (!this.hasCompletedIntakeSummary(params.assistantReply)) {
      return this.handleOrphanedIntake(
        params,
        "submission claim did not include enough confirmed intake fields",
      );
    }

    try {
      const forced = await this.aiProviderService.createCompletion({
        messages: [
          ...params.messages,
          { role: "assistant", content: params.assistantReply },
          {
            role: "system",
            content:
              "You indicated that this service intake was complete, but no job was created. Call create_job now using only details confirmed in the conversation. Do not invent contact details, addresses, urgency, property type or service intent. A standard residential heating or cooling repair request is eligible for an initial diagnostic appointment and should retain serviceIntent REPAIR.",
          },
        ],
        tools: [createJobTool],
        toolChoice: {
          type: "function",
          function: { name: "create_job" },
        },
        maxTokens: this.config.aiMaxTokens,
      });
      const forcedMessage = forced.choices[0]?.message;
      if (!forcedMessage) throw new Error("Forced job response was empty.");
      const validation = this.validateAssistantMessage(
        forcedMessage,
        params.tenantId,
        forced.model ?? params.responseModel,
      );
      if (validation.type !== "tool") {
        throw new Error("Forced job response did not call create_job.");
      }

      const result = await this.handleToolCall(
        params.tenantId,
        params.sessionId,
        params.conversationId,
        validation.toolCall.function.name,
        validation.toolCall.function.arguments ?? undefined,
        params.userMessage,
        forced.model ?? params.responseModel,
      );
      this.loggingService.log(
        {
          event: "intake_auto_finalized",
          tenantId: params.tenantId,
          sessionId: params.sessionId,
        },
        AiService.name,
      );
      return result;
    } catch (error) {
      const reason =
        error instanceof Error
          ? error.message
          : "automatic finalization failed";
      return this.handleOrphanedIntake(params, reason, error);
    }
  }

  private hasCompletedIntakeSummary(reply: string): boolean {
    const normalized = reply.toLowerCase();
    const confirmedFields = [
      "name:",
      "phone:",
      "address:",
      "issue",
      "property type:",
      "service intent:",
    ].filter((label) => normalized.includes(label)).length;
    return confirmedFields >= 4 || /\bjust to confirm\b/i.test(reply);
  }

  private async handleOrphanedIntake(
    params: {
      tenantId: string;
      sessionId: string;
      conversationId: string;
      userMessage: string;
    },
    reason: string,
    error?: unknown,
  ) {
    this.loggingService.error(
      `Automatic intake finalization failed for session ${params.sessionId}.`,
      error instanceof Error ? error : undefined,
      AiService.name,
    );
    this.loggingService.warn(
      {
        event: "orphaned_intake_detected",
        tenantId: params.tenantId,
        sessionId: params.sessionId,
        reason,
      },
      AiService.name,
    );
    this.jobNotificationService.enqueueOrphanedIntake(params.sessionId, reason);
    const safeReply =
      "I couldn't save this request, so it has not been sent to Eternity yet. Please try once more or call or text 216-703-3183 for help.";
    await this.callLogService.createLog({
      tenantId: params.tenantId,
      sessionId: params.sessionId,
      conversationId: params.conversationId,
      transcript: params.userMessage,
      aiResponse: safeReply,
      metadata: {
        sessionId: params.sessionId,
        responseType: "orphaned_intake",
      },
    });
    return {
      status: "needs_correction" as const,
      reply: safeReply,
      invalidFields: [],
    };
  }

  private async handleToolCall(
    tenantId: string,
    sessionId: string,
    conversationId: string,
    name: string,
    rawArgs?: string,
    userMessage?: string,
    model?: string,
  ) {
    if (name !== "create_job") {
      return {
        status: "unsupported_tool",
        toolName: name,
        rawArgs,
      };
    }

    try {
      const job = await this.jobsRepository.createJobFromToolCall({
        tenantId,
        sessionId,
        rawArgs,
        deferInitialNotification: true,
      });
      await this.conversationsService.linkJobToConversation({
        tenantId,
        conversationId,
        jobId: job.id,
      });
      await this.callLogService.createLog({
        tenantId,
        sessionId,
        jobId: job.id,
        conversationId,
        transcript: rawArgs ?? "",
        aiResponse: JSON.stringify(job),
        metadata: { toolName: name, sessionId },
      });
      await this.callLogService.clearSession(
        tenantId,
        sessionId,
        conversationId,
      );
      if (this.schedulingService.isInstantBookingEligible(job)) {
        try {
          const slots = await this.schedulingService.getAvailableSlots(job);
          if (slots.length) {
            return {
              status: "availability" as const,
              job,
              slots,
              message: `Service request ${this.reference(job.id)} was saved. Choose an available arrival window to confirm your residential diagnostic appointment.`,
            };
          }
        } catch (error) {
          this.loggingService.warn(
            {
              event: "appointment_availability_unavailable",
              jobId: job.id,
              reason: error instanceof Error ? error.message : "unknown",
            },
            AiService.name,
          );
        }
      }
      this.jobNotificationService.enqueueJobCreated(job);
      return {
        status: "job_created",
        job,
        message: `Service request received — reference ${this.reference(job.id)}. Eternity will follow up using the contact information provided.`,
      };
    } catch (error) {
      if (error instanceof BadRequestException) {
        const invalidFields = this.extractInvalidFields(error);
        this.logAiEvent(tenantId, "ai.invalid_output", {
          model,
          reason: "tool_args_invalid",
          invalidFields,
        });
        const reply = this.buildCorrectionReply(invalidFields);
        await this.callLogService.createLog({
          tenantId,
          sessionId,
          conversationId,
          transcript: userMessage ?? "",
          aiResponse: reply,
          metadata: {
            sessionId,
            responseType: "needs_correction",
            invalidFields,
          },
        });
        return {
          status: "needs_correction" as const,
          reply,
          invalidFields,
        };
      }
      this.errorHandler.handle(error, {
        tenantId,
        toolName: name,
        stage: "tool_call",
        metadata: {
          rawArgsLength: rawArgs?.length ?? 0,
        },
      });
    }
  }

  private reference(jobId: string): string {
    return jobId.replace(/-/g, "").slice(0, 8).toUpperCase();
  }

  private extractInvalidFields(error: BadRequestException): string[] {
    const response = error.getResponse();
    if (!response || typeof response !== "object") return [];
    const invalidFields = (response as { invalidFields?: unknown })
      .invalidFields;
    return Array.isArray(invalidFields)
      ? invalidFields.filter(
          (field): field is string => typeof field === "string",
        )
      : [];
  }

  private buildCorrectionReply(invalidFields: string[]): string {
    const labels: Record<string, string> = {
      customerName: "your full name",
      phone: "the best 10-digit callback number",
      issueCategory: "whether this is HVAC, boiler, or refrigeration service",
      urgency: "whether the equipment is down or still operating",
      description: "a short description of the problem",
      preferredTime: "your preferred date or time, such as ‘Tuesday after 3’",
    };
    const field = invalidFields.find((candidate) => labels[candidate]);
    if (field) {
      return `I couldn't save the request because I need ${labels[field]} again. Please enter that detail, and I’ll keep the rest of your information.`;
    }
    return "I couldn't save the request because one detail needs correction. Please re-enter the best 10-digit callback number, and I’ll keep the rest of your information.";
  }

  private validateAssistantMessage(
    message: OpenAI.ChatCompletionMessage,
    tenantId: string,
    model?: string,
  ) {
    if (typeof message.refusal === "string" && message.refusal.trim()) {
      this.logAiEvent(tenantId, "ai.refusal", {
        model,
        reason: message.refusal.trim(),
      });
      throw new BadRequestException("AI refused the request.");
    }

    if (message.tool_calls?.length) {
      if (message.tool_calls.length > this.config.aiMaxToolCalls) {
        this.logAiEvent(tenantId, "ai.invalid_output", {
          model,
          reason: "too_many_tool_calls",
        });
        this.loggingService.warn(
          {
            event: "ai_budget_triggered",
            budget: "AI_MAX_TOOL_CALLS",
            limit: this.config.aiMaxToolCalls,
          },
          AiService.name,
        );
        throw new BadRequestException("Too many tool calls.");
      }
      const toolCall = message.tool_calls[0];
      if (!toolCall.function.name) {
        this.logAiEvent(tenantId, "ai.invalid_output", {
          model,
          reason: "invalid_tool_call",
        });
        throw new BadRequestException("Invalid tool call response.");
      }
      const rawArgs = toolCall.function.arguments ?? "";
      if (!rawArgs.trim()) {
        this.logAiEvent(tenantId, "ai.invalid_output", {
          model,
          reason: "missing_tool_args",
        });
        throw new BadRequestException("Tool call arguments missing.");
      }
      return { type: "tool" as const, toolCall };
    }

    const replyPayload = Array.isArray(message.content)
      ? message.content
          .map((part) =>
            typeof part === "string"
              ? part
              : ((part as { text?: string })?.text ?? ""),
          )
          .join(" ")
      : (message.content ?? "");

    const trimmed = replyPayload.trim();
    if (!trimmed) {
      this.logAiEvent(tenantId, "ai.invalid_output", {
        model,
        reason: "empty_reply",
      });
      throw new BadRequestException("AI response was empty.");
    }

    return { type: "reply" as const, reply: trimmed };
  }

  private logAiEvent(
    tenantId: string,
    event: "ai.refusal" | "ai.invalid_output",
    details: {
      model?: string;
      reason: string;
      promptVersion?: string;
      invalidFields?: string[];
    },
  ) {
    const context = getRequestContext();
    const payload: Record<string, unknown> = {
      event,
      tenantId,
      requestId: context?.requestId,
      model: details.model,
      reason: details.reason,
    };

    if (details.promptVersion) {
      payload.promptVersion = details.promptVersion;
    }
    if (details.invalidFields?.length) {
      payload.invalidFields = details.invalidFields;
    }

    this.loggingService.warn(payload, AiService.name);
  }
}
