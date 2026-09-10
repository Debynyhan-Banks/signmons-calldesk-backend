import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { getRequestContext } from "../common/context/request-context";
import { PrismaService } from "../prisma/prisma.service";
import { ConversationMemoryCipher } from "../logging/conversation-memory-cipher.service";
import { AppointmentEmailConsentEvidenceStore } from "./appointment-email-consent-evidence";
import { CustomerConsentCredentials } from "./customer-consent-credentials";
import {
  lockCustomerConsentSession,
  CustomerSessionScope,
} from "./customer-consent-session-lock";
import { validateCustomerIntakeDraft } from "./customer-intake-draft";
import {
  ORGANIZATION_PROFILE,
  object,
  profile,
  preview,
  timestamp,
} from "../tenants/organization-profile";

export const PROTECTED_INTAKE_TURN = "protected_intake_turn_v1";
export const PROTECTED_INTAKE_REVIEW = "protected_intake_review_v1";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const changed = () =>
  new ConflictException("Customer intake changed or is unavailable.");
const reviewRoles = new Set(["owner", "admin", "dispatcher"]);
function text(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 2000 &&
    ![...value].some((char) => {
      const code = char.charCodeAt(0);
      return (code < 32 && code !== 9 && code !== 10) || code === 127;
    })
  );
}
type Turn = { id: string; revision: number; message: string; reply: string };
export interface CustomerIntakeReply {
  /** Local scripted collaborator only in this checkpoint. No production AI/tool adapter. */
  reply(input: {
    turns: ReadonlyArray<{ message: string; reply: string }>;
    message: string;
  }): Promise<string>;
}

/** Unregistered, no browser route and no AI/booking/provider/consent side effects.
 * The collaborator runs outside database locks. A fresh ownership/history check
 * gates one atomic encrypted turn after it returns; no automatic retry.
 */
export class CustomerIntakeContinuationService {
  constructor(
    private readonly prisma: Pick<PrismaService, "$transaction">,
    private readonly cipher: Pick<
      ConversationMemoryCipher,
      "encrypt" | "decrypt"
    >,
    private readonly credentials: CustomerConsentCredentials,
    private readonly collaborator?: CustomerIntakeReply,
    private readonly consentEvidence?: Pick<
      AppointmentEmailConsentEvidenceStore,
      "bindJob"
    >,
  ) {}

  /** Customer-only durable submission. Does not store the bearer or authorize a job. */
  async submitReview(input: {
    sessionToken: string;
    requestId: string;
    expectedRevision: number;
    draft: unknown;
    confirmed: boolean;
  }) {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).sort().join(",") !==
        "confirmed,draft,expectedRevision,requestId,sessionToken" ||
      input.confirmed !== true ||
      typeof input.sessionToken !== "string" ||
      input.sessionToken.length > 4096 ||
      typeof input.requestId !== "string" ||
      !UUID.test(input.requestId) ||
      !Number.isInteger(input.expectedRevision) ||
      input.expectedRevision < 1 ||
      input.expectedRevision > 20
    )
      throw new BadRequestException("Invalid review submission.");
    const draft = validateCustomerIntakeDraft(input.draft),
      session = this.credentials.verifySession(input.sessionToken);
    try {
      return await this.transaction(async (tx) => {
        const history = await this.history(tx, session);
        if (history.turns.length !== input.expectedRevision) throw changed();
        this.credentials.verifySession(input.sessionToken);
        const existing = await tx.communicationEvent.findMany({
          where: {
            tenantId: session.tenantId,
            conversationId: session.conversationId,
            content: {
              is: {
                payload: { path: ["type"], equals: PROTECTED_INTAKE_REVIEW },
              },
            },
          },
          take: 2,
          select: { id: true },
        });
        if (existing.length) {
          if (existing.length !== 1 || existing[0].id !== input.requestId)
            throw changed();
          const record = await this.reviewRecord(
            tx,
            session.tenantId,
            input.requestId,
          );
          if (
            record.sessionId !== session.sessionId ||
            record.expiresAt !== session.expiresAt ||
            record.transcriptRevision !== input.expectedRevision ||
            record.transcriptDigest !== history.digest ||
            JSON.stringify(record.draft) !== JSON.stringify(draft)
          )
            throw changed();
          return this.reviewSubmissionReceipt(
            input.requestId,
            record.expiresAt,
          );
        }
        if (
          await tx.communicationEvent.findUnique({
            where: { id: input.requestId },
            select: { id: true },
          })
        )
          throw changed();
        await tx.communicationEvent.create({
          data: {
            id: input.requestId,
            tenantId: session.tenantId,
            conversationId: session.conversationId,
            conversationTenantId: session.tenantId,
            channel: "WEBCHAT",
            direction: "INBOUND",
            provider: "OTHER",
            status: "RECEIVED",
            content: {
              create: {
                tenantId: session.tenantId,
                payload: {
                  type: PROTECTED_INTAKE_REVIEW,
                  version: 1,
                  sessionId: session.sessionId,
                  expiresAt: session.expiresAt,
                  transcriptRevision: history.turns.length,
                  transcriptDigest: history.digest,
                  encryptedDraft: this.cipher.encrypt(JSON.stringify(draft)),
                },
              },
            },
          },
        });
        await tx.auditLog.create({
          data: {
            tenantId: session.tenantId,
            entityType: "Conversation",
            entityId: session.conversationId,
            actorType: "CUSTOMER",
            actorId: "intake-session",
            action: "conversation.intake_review_requested",
            metadata: {
              version: 1,
              requestId: input.requestId,
              transcriptRevision: history.turns.length,
            },
          },
        });
        this.credentials.verifySession(input.sessionToken);
        return this.reviewSubmissionReceipt(input.requestId, session.expiresAt);
      });
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() < 500)
        throw error;
      throw new ServiceUnavailableException(
        "Review submission outcome is unconfirmed. Retry the exact request with the same unexpired session.",
      );
    }
  }

  /** Operator-only read. Never accepts, verifies, issues or reconstructs a customer token. */
  async readReview(input: { requestId: string }) {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).join(",") !== "requestId" ||
      typeof input.requestId !== "string" ||
      !UUID.test(input.requestId)
    )
      throw new BadRequestException("Invalid review request.");
    const operator = this.operator();
    try {
      return await this.transaction(async (tx) => {
        const before = await this.reviewRecord(
          tx,
          operator.tenantId,
          input.requestId,
        );
        const scope = {
          tenantId: operator.tenantId,
          conversationId: before.conversationId,
          sessionId: before.sessionId,
        };
        const history = await this.history(tx, scope);
        const current = await this.reviewRecord(
          tx,
          operator.tenantId,
          input.requestId,
        );
        if (
          JSON.stringify(current) !== JSON.stringify(before) ||
          history.digest !== current.transcriptDigest ||
          history.turns.length !== current.transcriptRevision
        )
          throw changed();
        return {
          ...this.reviewSubmissionReceipt(input.requestId, current.expiresAt),
          draft: current.draft,
          transcriptRevision: current.transcriptRevision,
          requiresHumanReview: true as const,
          urgencyAssessment: "NOT_PERFORMED" as const,
          ...(history.organization
            ? { organizationApprovedAt: history.organization.approvedAt }
            : {}),
        };
      });
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() < 500)
        throw error;
      throw new ServiceUnavailableException("Intake review unavailable.");
    }
  }

  private reviewSubmissionReceipt(requestId: string, expiresAt: number) {
    return {
      requestId,
      state: "PENDING_REVIEW" as const,
      expiresAt: new Date(expiresAt).toISOString(),
      jobCreated: false as const,
      bookingAuthorized: false as const,
      deliveryAuthorized: false as const,
    };
  }

  private async reviewRecord(
    tx: Prisma.TransactionClient,
    tenantId: string,
    requestId: string,
  ) {
    const row = await tx.communicationEvent.findFirst({
      where: { id: requestId, tenantId, conversationTenantId: tenantId },
      select: {
        conversationId: true,
        createdAt: true,
        channel: true,
        direction: true,
        provider: true,
        status: true,
        content: { select: { tenantId: true, payload: true } },
      },
    });
    if (
      !row ||
      !row.conversationId ||
      row.channel !== "WEBCHAT" ||
      row.direction !== "INBOUND" ||
      row.provider !== "OTHER" ||
      row.status !== "RECEIVED" ||
      row.content?.tenantId !== tenantId
    )
      throw changed();
    const p = row.content.payload;
    if (
      !p ||
      typeof p !== "object" ||
      Array.isArray(p) ||
      Object.keys(p).sort().join(",") !==
        "encryptedDraft,expiresAt,sessionId,transcriptDigest,transcriptRevision,type,version"
    )
      throw changed();
    const v = p as Record<string, unknown>;
    if (
      v.type !== PROTECTED_INTAKE_REVIEW ||
      v.version !== 1 ||
      typeof v.sessionId !== "string" ||
      !UUID.test(v.sessionId) ||
      typeof v.encryptedDraft !== "string" ||
      typeof v.transcriptDigest !== "string" ||
      !/^[0-9a-f]{64}$/.test(v.transcriptDigest) ||
      typeof v.expiresAt !== "number" ||
      !Number.isSafeInteger(v.expiresAt) ||
      Date.now() >= v.expiresAt ||
      v.expiresAt > row.createdAt.getTime() + 900000 ||
      row.createdAt.getTime() > Date.now() ||
      typeof v.transcriptRevision !== "number" ||
      !Number.isInteger(v.transcriptRevision) ||
      v.transcriptRevision < 1 ||
      v.transcriptRevision > 20
    )
      throw changed();
    const plaintext = this.cipher.decrypt(v.encryptedDraft);
    if (!plaintext || plaintext.length > 4096) throw changed();
    let draft;
    try {
      draft = validateCustomerIntakeDraft(JSON.parse(plaintext));
    } catch {
      throw changed();
    }
    return {
      conversationId: row.conversationId,
      sessionId: v.sessionId,
      expiresAt: v.expiresAt,
      transcriptRevision: v.transcriptRevision,
      transcriptDigest: v.transcriptDigest,
      draft,
    };
  }

  /** Inactive local admission only. There is no controller/module registration.
   * Verified operator context supplies authority; the customer credential supplies
   * session ownership. Calendar, payment, notification and provider work stay off.
   */
  async admitDraft(input: {
    sessionToken: string;
    expectedRevision: number;
    draft: unknown;
    review: unknown;
  }) {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).sort().join(",") !==
        "draft,expectedRevision,review,sessionToken" ||
      typeof input.sessionToken !== "string" ||
      input.sessionToken.length > 4096 ||
      !Number.isInteger(input.expectedRevision) ||
      input.expectedRevision < 1 ||
      input.expectedRevision > 20
    )
      throw new BadRequestException("Invalid intake admission request.");
    const draft = validateCustomerIntakeDraft(input.draft);
    const review = this.review(input.review);
    const context = this.operator();
    const session = this.credentials.verifySession(input.sessionToken);
    if (session.tenantId !== context.tenantId)
      throw new ForbiddenException("Intake review is unavailable.");
    const admissionDigest = createHash("sha256")
      .update(
        JSON.stringify({
          version: 1,
          tenantId: context.tenantId,
          actorId: context.actorId,
          conversationId: session.conversationId,
          sessionId: session.sessionId,
          transcriptRevision: input.expectedRevision,
          draft,
          review,
        }),
      )
      .digest("hex");
    try {
      return await this.transaction(async (tx) => {
        const sessionRow = await lockCustomerConsentSession(tx, session);
        this.credentials.verifySession(input.sessionToken);
        const prior = await tx.job.findUnique({
          where: {
            tenantId_intakeSessionId: {
              tenantId: session.tenantId,
              intakeSessionId: session.sessionId,
            },
          },
          select: {
            id: true,
            status: true,
            urgency: true,
            policySnapshot: true,
            deletedAt: true,
            conversationLinks: {
              where: {
                tenantId: session.tenantId,
                conversationId: session.conversationId,
                relationType: "CREATED_FROM",
              },
              select: { id: true },
              take: 2,
            },
            emailConsentBinding: { select: { scopeId: true } },
          },
        });
        if (prior)
          return this.admissionReplay(
            prior,
            admissionDigest,
            input.expectedRevision,
          );
        if (sessionRow.status !== "ONGOING") throw changed();
        const history = await this.history(tx, session, true);
        if (history.turns.length !== input.expectedRevision) throw changed();
        const receipt = await this.persistAdmission(
          tx,
          session,
          draft,
          review,
          context,
          admissionDigest,
          input.expectedRevision,
        );
        this.credentials.verifySession(input.sessionToken);
        return receipt;
      });
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() < 500)
        throw error;
      throw new ServiceUnavailableException(
        "Intake admission outcome is unconfirmed. Retry only the exact reviewed request with the same unexpired session.",
      );
    }
  }

  /** Local operator-only admission of a durable organization-bound request.
   * No customer credential method, live controller, provider or booking action.
   */
  async admitReview(input: {
    requestId: string;
    expectedOrganizationApprovedAt: string;
    review: unknown;
  }) {
    const context = this.operator();
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).sort().join(",") !==
        "expectedOrganizationApprovedAt,requestId,review" ||
      typeof input.requestId !== "string" ||
      !UUID.test(input.requestId) ||
      !timestamp(input.expectedOrganizationApprovedAt)
    )
      throw new BadRequestException(
        "Exact reviewed request and organization version required.",
      );
    const review = this.review(input.review);
    try {
      return await this.transaction(async (tx) => {
        const before = await this.reviewRecord(
          tx,
          context.tenantId,
          input.requestId,
        );
        const session: CustomerSessionScope = {
          tenantId: context.tenantId,
          conversationId: before.conversationId,
          sessionId: before.sessionId,
        };
        const locked = await lockCustomerConsentSession(tx, session);
        const record = await this.reviewRecord(
          tx,
          context.tenantId,
          input.requestId,
        );
        if (JSON.stringify(before) !== JSON.stringify(record)) throw changed();
        const organization = await this.organization(tx, context.tenantId);
        if (organization.approvedAt !== input.expectedOrganizationApprovedAt)
          throw changed();
        const admissionDigest = createHash("sha256")
          .update(
            JSON.stringify({
              version: 2,
              requestId: input.requestId,
              tenantId: context.tenantId,
              actorId: context.actorId,
              sessionId: record.sessionId,
              conversationId: record.conversationId,
              transcriptRevision: record.transcriptRevision,
              transcriptDigest: record.transcriptDigest,
              draft: record.draft,
              review,
              organizationApprovedAt: organization.approvedAt,
              organizationDigest: organization.digest,
            }),
          )
          .digest("hex");
        const prior = await tx.job.findUnique({
          where: {
            tenantId_intakeSessionId: {
              tenantId: context.tenantId,
              intakeSessionId: record.sessionId,
            },
          },
          select: {
            id: true,
            status: true,
            urgency: true,
            policySnapshot: true,
            deletedAt: true,
            conversationLinks: {
              where: {
                tenantId: context.tenantId,
                conversationId: record.conversationId,
                relationType: "CREATED_FROM",
              },
              select: { id: true },
              take: 2,
            },
            emailConsentBinding: { select: { scopeId: true } },
          },
        });
        const wrap = (
          receipt: ReturnType<
            CustomerIntakeContinuationService["admissionReceipt"]
          >,
        ) => ({
          ...receipt,
          requestId: input.requestId,
          state: "ADMITTED" as const,
          organizationApprovedAt: organization.approvedAt,
        });
        if (prior) {
          const admission = object(
            object(prior.policySnapshot)?.intakeAdmission,
          );
          if (
            locked.status !== "COMPLETED" ||
            prior.urgency !== review.urgency ||
            admission?.requestId !== input.requestId ||
            admission.organizationApprovedAt !== organization.approvedAt ||
            admission.organizationDigest !== organization.digest
          )
            throw changed();
          const receipt = this.admissionReplay(
            prior,
            admissionDigest,
            record.transcriptRevision,
          );
          if (Date.now() >= record.expiresAt) throw changed();
          return wrap(receipt);
        }
        if (locked.status !== "ONGOING") throw changed();
        const history = await this.history(tx, session, true);
        if (
          !history.organization ||
          history.organization.digest !== organization.digest ||
          history.turns.length !== record.transcriptRevision ||
          history.digest !== record.transcriptDigest
        )
          throw changed();
        const receipt = await this.persistAdmission(
          tx,
          session,
          record.draft,
          review,
          context,
          admissionDigest,
          record.transcriptRevision,
          {
            requestId: input.requestId,
            approvedAt: organization.approvedAt,
            digest: organization.digest,
          },
        );
        if (Date.now() >= record.expiresAt) throw changed();
        return wrap(receipt);
      });
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() < 500)
        throw error;
      throw new ServiceUnavailableException(
        "Intake admission outcome unconfirmed. Retry only the exact reviewed request before its original deadline.",
      );
    }
  }

  private async persistAdmission(
    tx: Prisma.TransactionClient,
    session: CustomerSessionScope,
    draft: ReturnType<typeof validateCustomerIntakeDraft>,
    review: ReturnType<CustomerIntakeContinuationService["review"]>,
    context: ReturnType<CustomerIntakeContinuationService["operator"]>,
    admissionDigest: string,
    expectedRevision: number,
    requestBinding?: { requestId: string; approvedAt: string; digest: string },
  ) {
    const consent = await this.consentState(tx, session);
    const category = await tx.serviceCategory.findFirst({
      where: { tenantId: session.tenantId, name: draft.issueCategory },
      select: { id: true },
    });
    if (!category)
      throw new ConflictException(
        "The reviewed service category is not available for this business.",
      );
    const customer = await tx.customer.upsert({
      where: {
        tenantId_phone: {
          tenantId: session.tenantId,
          phone: draft.phone,
        },
      },
      update: { fullName: draft.customerName, updatedAt: new Date() },
      create: {
        id: randomUUID(),
        tenantId: session.tenantId,
        phone: draft.phone,
        fullName: draft.customerName,
      },
      select: { id: true, deletedAt: true },
    });
    if (customer.deletedAt) throw changed();
    const address = await tx.propertyAddress.create({
      data: {
        id: randomUUID(),
        tenantId: session.tenantId,
        customerId: customer.id,
        customerTenantId: session.tenantId,
        googlePlaceId: randomUUID(),
        formattedAddress: draft.address,
        addressComponents: {},
        latitude: 0,
        longitude: 0,
      },
      select: { id: true },
    });
    const job = await tx.job.create({
      data: {
        id: randomUUID(),
        tenantId: session.tenantId,
        customerId: customer.id,
        customerTenantId: session.tenantId,
        propertyAddressId: address.id,
        propertyAddressTenantId: session.tenantId,
        serviceCategoryId: category.id,
        serviceCategoryTenantId: session.tenantId,
        status: "CREATED",
        urgency: review.urgency,
        description: draft.description,
        intakeSessionId: session.sessionId,
        pricingSnapshot: {},
        policySnapshot: {
          propertyType: draft.propertyType,
          serviceIntent: draft.serviceIntent,
          leadAttribution: { channel: "website_chat" },
          urgencyDecision: {
            source: "OPERATOR_OVERRIDE",
            level: review.urgency,
            reasonCodes: ["HUMAN_INTAKE_REVIEW"],
            confidenceNote:
              "Authorized operator reviewed customer-stated intake.",
          },
          intakeAdmission: {
            version: 1,
            digest: admissionDigest,
            transcriptRevision: expectedRevision,
            reviewReasonCode: review.reasonCode,
            humanReviewed: true,
            contactVerification: "NOT_VERIFIED",
            addressVerification: "NOT_VERIFIED",
            emailChoice: consent.choice,
            ...(requestBinding
              ? {
                  requestId: requestBinding.requestId,
                  organizationApprovedAt: requestBinding.approvedAt,
                  organizationDigest: requestBinding.digest,
                }
              : {}),
          },
        } satisfies Prisma.InputJsonValue,
      },
      select: { id: true, status: true, urgency: true },
    });
    const link = await tx.conversationJobLink.create({
      data: {
        id: randomUUID(),
        tenantId: session.tenantId,
        conversationId: session.conversationId,
        conversationTenantId: session.tenantId,
        jobId: job.id,
        jobTenantId: session.tenantId,
        relationType: "CREATED_FROM",
      },
      select: { id: true },
    });
    if (consent.scopeId) {
      if (!this.consentEvidence)
        throw new ServiceUnavailableException(
          "Intake consent binding is unavailable.",
        );
      await this.consentEvidence.bindJob(tx, {
        tenantId: session.tenantId,
        conversationId: session.conversationId,
        jobId: job.id,
      });
    }
    await tx.auditLog.create({
      data: {
        tenantId: session.tenantId,
        entityType: "Job",
        entityId: job.id,
        actorType: "USER",
        actorId: context.actorId,
        action: "job.customer_intake_admitted",
        metadata: {
          version: 1,
          transcriptRevision: expectedRevision,
          urgency: review.urgency,
          reviewReasonCode: review.reasonCode,
          humanReviewed: true,
          customerStatementsVerified: false,
          consentEvidence: consent.scopeId ? "BOUND" : "NOT_RECORDED",
          originLinkId: link.id,
          ...(requestBinding
            ? {
                requestId: requestBinding.requestId,
                organizationApprovedAt: requestBinding.approvedAt,
              }
            : {}),
        } satisfies Prisma.InputJsonValue,
        traceId: context.traceId,
      },
    });
    const closed = await tx.conversation.updateMany({
      where: {
        id: session.conversationId,
        tenantId: session.tenantId,
        status: "ONGOING",
        deletedAt: null,
      },
      data: { status: "COMPLETED", currentFSMState: "JOB_CREATED" },
    });
    if (closed.count !== 1) throw changed();
    return this.admissionReceipt({
      id: job.id,
      status: job.status,
      urgency: job.urgency,
      transcriptRevision: expectedRevision,
      consentEvidence: consent.scopeId ? "BOUND" : "NOT_RECORDED",
    });
  }

  /** Read-only preview. No job, consent mutation, finalization or delivery admission. */
  async previewDraft(input: {
    sessionToken: string;
    expectedRevision: number;
    draft: unknown;
  }) {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).sort().join(",") !==
        "draft,expectedRevision,sessionToken" ||
      typeof input.sessionToken !== "string" ||
      input.sessionToken.length > 4096 ||
      !Number.isInteger(input.expectedRevision) ||
      input.expectedRevision < 1 ||
      input.expectedRevision > 20
    )
      throw new BadRequestException("Invalid intake draft request.");
    const draft = validateCustomerIntakeDraft(input.draft);
    const session = this.credentials.verifySession(input.sessionToken);
    try {
      return await this.transaction(async (tx) => {
        const history = await this.history(tx, session);
        if (history.turns.length !== input.expectedRevision) throw changed();
        const scope = await tx.appointmentEmailConsentScope.findUnique({
          where: {
            tenantId_conversationId: {
              tenantId: session.tenantId,
              conversationId: session.conversationId,
            },
          },
        });
        if (scope && scope.sessionId !== session.sessionId) throw changed();
        const evidence = scope
          ? await tx.appointmentEmailConsentEvidence.findFirst({
              where: { scopeId: scope.id },
              orderBy: { revision: "desc" },
            })
          : null;
        const emailChoice = evidence?.decision ?? "NOT_RECORDED";
        if (
          !["NOT_RECORDED", "GRANTED", "DECLINED", "REVOKED"].includes(
            emailChoice,
          )
        )
          throw changed();
        this.credentials.verifySession(input.sessionToken);
        return {
          draft,
          transcriptRevision: history.turns.length,
          emailChoice,
          urgencyAssessment: "NOT_PERFORMED" as const,
          requiresHumanReview: true as const,
          jobCreated: false as const,
          bookingAuthorized: false as const,
          deliveryAuthorized: false as const,
        };
      });
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() < 500)
        throw error;
      throw new ServiceUnavailableException("Intake draft unavailable.");
    }
  }

  async continue(input: {
    sessionToken: string;
    interactionId: string;
    message: string;
  }) {
    return this.continueInternal(input, false);
  }

  /** Local protected customer FAQ path; never uses operator credentials or live AI. */
  async continueOrganization(input: {
    sessionToken: string;
    interactionId: string;
    message: string;
  }) {
    return this.continueInternal(input, true);
  }

  private async organization(tx: Prisma.TransactionClient, tenantId: string) {
    // history() holds the shared tenant lock through the surrounding transaction.
    const tenant = await tx.tenantOrganization.findFirst({
      where: { id: tenantId, status: "ACTIVE" },
      select: { settings: true },
    });
    const approved = profile(
      object(tenant?.settings)?.[ORGANIZATION_PROFILE],
    )?.approved;
    if (!approved || Date.parse(approved.approvedAt) > Date.now())
      throw changed();
    return {
      approved,
      approvedAt: approved.approvedAt,
      digest: createHash("sha256")
        .update(JSON.stringify(approved))
        .digest("hex"),
    };
  }

  private async continueInternal(
    input: {
      sessionToken: string;
      interactionId: string;
      message: string;
    },
    organizationMode: boolean,
  ) {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).sort().join(",") !==
        "interactionId,message,sessionToken" ||
      typeof input.sessionToken !== "string" ||
      input.sessionToken.length > 4096 ||
      typeof input.interactionId !== "string" ||
      !UUID.test(input.interactionId) ||
      !text(input.message)
    )
      throw new BadRequestException("Invalid customer intake request.");
    const session = this.credentials.verifySession(input.sessionToken);
    try {
      const first = await this.transaction(async (tx) => {
        const history = await this.history(tx, session);
        if (
          history.turns.length &&
          Boolean(history.organization) !== organizationMode
        )
          throw changed();
        const organization = organizationMode
          ? await this.organization(tx, session.tenantId)
          : null;
        this.credentials.verifySession(input.sessionToken);
        const prior = await this.replay(tx, input, history.turns);
        if (prior) return { history, prior, organization };
        if (history.turns.length >= 20) throw changed();
        return { history, prior: null, organization };
      });
      if (first.prior) return this.receipt(first.prior);
      if (!this.collaborator && !first.organization)
        throw new ServiceUnavailableException(
          "Intake collaborator unavailable.",
        );
      let reply: string;
      try {
        reply = first.organization
          ? preview(
              first.organization.approved,
              input.message.replace(/[\t\n]/g, " "),
              2000,
            ).answer
          : await this.collaborator!.reply({
              turns: first.history.turns.map(({ message, reply }) => ({
                message,
                reply,
              })),
              message: input.message,
            });
      } catch {
        throw new ServiceUnavailableException("Intake reply unavailable.");
      }
      if (!text(reply))
        throw new ServiceUnavailableException("Intake reply unavailable.");
      this.credentials.verifySession(input.sessionToken);
      return await this.transaction(async (tx) => {
        const current = await this.history(tx, session);
        if (first.organization) {
          const latest = await this.organization(tx, session.tenantId);
          if (latest.digest !== first.organization.digest) throw changed();
        }
        this.credentials.verifySession(input.sessionToken);
        const prior = await this.replay(tx, input, current.turns);
        if (prior) return this.receipt(prior);
        if (
          current.digest !== first.history.digest ||
          current.turns.length >= 20
        )
          throw changed();
        const revision = current.turns.length + 1;
        await tx.communicationEvent.create({
          data: {
            id: input.interactionId,
            tenantId: session.tenantId,
            conversationId: session.conversationId,
            conversationTenantId: session.tenantId,
            channel: "WEBCHAT",
            direction: "INBOUND",
            provider: "OTHER",
            status: "RECEIVED",
            content: {
              create: {
                tenantId: session.tenantId,
                payload: {
                  version: first.organization ? 2 : 1,
                  type: PROTECTED_INTAKE_TURN,
                  ...(first.organization
                    ? {
                        organizationApprovedAt: first.organization.approvedAt,
                        organizationDigest: first.organization.digest,
                      }
                    : {}),
                  sessionId: session.sessionId,
                  revision,
                  encryptedInput: this.cipher.encrypt(input.message),
                  encryptedReply: this.cipher.encrypt(reply),
                },
              },
            },
          },
        });
        await tx.auditLog.create({
          data: {
            tenantId: session.tenantId,
            entityType: "Conversation",
            entityId: session.conversationId,
            actorType: "CUSTOMER",
            actorId: "intake-session",
            action: "conversation.protected_intake_turn",
            metadata: {
              version: first.organization ? 2 : 1,
              revision,
              ...(first.organization
                ? { organizationApprovedAt: first.organization.approvedAt }
                : {}),
            },
          },
        });
        this.credentials.verifySession(input.sessionToken);
        return this.receipt({
          id: input.interactionId,
          revision,
          message: input.message,
          reply,
        });
      });
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() < 500)
        throw error;
      throw new ServiceUnavailableException(
        "Intake outcome is unconfirmed. Retry only the same interaction with the same unexpired session.",
      );
    }
  }

  private transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) {
    return this.prisma.$transaction(fn, { maxWait: 2000, timeout: 5000 });
  }
  private receipt(turn: Turn) {
    return {
      reply: turn.reply,
      revision: turn.revision,
      deliveryAuthorized: false as const,
    };
  }
  private async replay(
    tx: Prisma.TransactionClient,
    input: { interactionId: string; message: string },
    turns: Turn[],
  ) {
    const prior = turns.find((turn) => turn.id === input.interactionId);
    if (prior) {
      if (prior.message !== input.message) throw changed();
      return prior;
    }
    // The event ID is globally unique. Never adopt another session's/legacy event.
    const collision = await tx.communicationEvent.findUnique({
      where: { id: input.interactionId },
      select: { id: true },
    });
    if (collision) throw changed();
    return null;
  }
  private async history(
    tx: Prisma.TransactionClient,
    session: CustomerSessionScope,
    sessionAlreadyLocked = false,
  ) {
    const row = sessionAlreadyLocked
      ? { status: "ONGOING" }
      : await lockCustomerConsentSession(tx, session);
    if (row.status !== "ONGOING") throw changed();
    if (
      await tx.conversationJobLink.count({
        where: {
          tenantId: session.tenantId,
          conversationId: session.conversationId,
        },
      })
    )
      throw changed();
    const rows = await tx.communicationEvent.findMany({
      where: {
        tenantId: session.tenantId,
        conversationId: session.conversationId,
        conversationTenantId: session.tenantId,
        content: {
          is: {
            tenantId: session.tenantId,
            payload: { path: ["type"], equals: PROTECTED_INTAKE_TURN },
          },
        },
      },
      take: 21,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        channel: true,
        direction: true,
        provider: true,
        status: true,
        content: { select: { payload: true } },
      },
    });
    if (rows.length > 20) throw changed();
    let boundOrganization: { approvedAt: string; digest: string } | null = null;
    let organizationTurns = 0;
    const turns = rows
      .map((row) => {
        const payload = row.content?.payload;
        if (
          row.channel !== "WEBCHAT" ||
          row.direction !== "INBOUND" ||
          row.provider !== "OTHER" ||
          row.status !== "RECEIVED" ||
          !payload ||
          typeof payload !== "object" ||
          Array.isArray(payload)
        )
          throw changed();
        const p = payload as Record<string, unknown>;
        if (p.version === 2) {
          if (
            typeof p.organizationApprovedAt !== "string" ||
            !Number.isFinite(Date.parse(p.organizationApprovedAt)) ||
            new Date(p.organizationApprovedAt).toISOString() !==
              p.organizationApprovedAt ||
            typeof p.organizationDigest !== "string" ||
            !/^[0-9a-f]{64}$/.test(p.organizationDigest)
          )
            throw changed();
          const binding = {
            approvedAt: p.organizationApprovedAt,
            digest: p.organizationDigest,
          };
          if (
            boundOrganization &&
            JSON.stringify(boundOrganization) !== JSON.stringify(binding)
          )
            throw changed();
          boundOrganization = binding;
          organizationTurns++;
        }
        if (
          Object.keys(p).sort().join(",") !==
            (p.version === 2
              ? "encryptedInput,encryptedReply,organizationApprovedAt,organizationDigest,revision,sessionId,type,version"
              : "encryptedInput,encryptedReply,revision,sessionId,type,version") ||
          (p.version !== 1 && p.version !== 2) ||
          p.type !== PROTECTED_INTAKE_TURN ||
          p.sessionId !== session.sessionId ||
          !Number.isSafeInteger(p.revision) ||
          typeof p.encryptedInput !== "string" ||
          typeof p.encryptedReply !== "string"
        )
          throw changed();
        const message = this.cipher.decrypt(p.encryptedInput),
          reply = this.cipher.decrypt(p.encryptedReply);
        if (!text(message) || !text(reply)) throw changed();
        return { id: row.id, revision: p.revision as number, message, reply };
      })
      .sort((a, b) => a.revision - b.revision);
    if (turns.some((turn, index) => turn.revision !== index + 1))
      throw changed();
    if (organizationTurns) {
      if (organizationTurns !== turns.length) throw changed();
      const currentOrganization = await this.organization(tx, session.tenantId);
      if (
        currentOrganization.digest !== boundOrganization!.digest ||
        currentOrganization.approvedAt !== boundOrganization!.approvedAt
      )
        throw changed();
    }
    return {
      turns,
      organization: boundOrganization as {
        approvedAt: string;
        digest: string;
      } | null,
      digest: createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
    };
  }

  private operator() {
    const context = getRequestContext();
    const role = context?.role?.trim().toLowerCase();
    if (
      !context?.tenantId ||
      !context.userId ||
      context.userId.length > 128 ||
      !role ||
      !reviewRoles.has(role) ||
      context.impersonatedTenantId
    )
      throw new ForbiddenException(
        "Intake admission requires a verified owner, admin, or dispatcher.",
      );
    return {
      tenantId: context.tenantId,
      actorId: context.userId,
      traceId:
        typeof context.requestId === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          context.requestId,
        )
          ? context.requestId
          : undefined,
    };
  }

  private review(value: unknown) {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(",") !==
        "acknowledgeCustomerStatements,reasonCode,urgency"
    )
      throw new BadRequestException("Invalid intake review decision.");
    const v = value as Record<string, unknown>;
    if (
      v.acknowledgeCustomerStatements !== true ||
      typeof v.urgency !== "string" ||
      !["EMERGENCY", "HIGH", "STANDARD"].includes(v.urgency) ||
      v.reasonCode !== "OPERATOR_REVIEWED_INTAKE"
    )
      throw new BadRequestException("Invalid intake review decision.");
    return {
      urgency: v.urgency as "EMERGENCY" | "HIGH" | "STANDARD",
      reasonCode: "OPERATOR_REVIEWED_INTAKE" as const,
      acknowledgeCustomerStatements: true as const,
    };
  }

  private async consentState(
    tx: Prisma.TransactionClient,
    session: CustomerSessionScope,
  ) {
    const scope = await tx.appointmentEmailConsentScope.findUnique({
      where: {
        tenantId_conversationId: {
          tenantId: session.tenantId,
          conversationId: session.conversationId,
        },
      },
    });
    if (!scope) return { scopeId: null, choice: "NOT_RECORDED" as const };
    if (scope.sessionId !== session.sessionId) throw changed();
    const evidence = await tx.appointmentEmailConsentEvidence.findFirst({
      where: { scopeId: scope.id },
      orderBy: { revision: "desc" },
    });
    if (
      !evidence ||
      !["GRANTED", "DECLINED", "REVOKED"].includes(evidence.decision)
    )
      throw changed();
    return { scopeId: scope.id, choice: evidence.decision };
  }

  private admissionReplay(
    prior: {
      id: string;
      status: string;
      urgency: string;
      policySnapshot: Prisma.JsonValue;
      deletedAt: Date | null;
      conversationLinks: { id: string }[];
      emailConsentBinding: { scopeId: string } | null;
    },
    digest: string,
    transcriptRevision: number,
  ) {
    const policy =
      prior.policySnapshot &&
      typeof prior.policySnapshot === "object" &&
      !Array.isArray(prior.policySnapshot)
        ? (prior.policySnapshot as Record<string, unknown>)
        : null;
    const admission =
      policy?.intakeAdmission &&
      typeof policy.intakeAdmission === "object" &&
      !Array.isArray(policy.intakeAdmission)
        ? (policy.intakeAdmission as Record<string, unknown>)
        : null;
    const consentEvidence =
      admission?.emailChoice === "NOT_RECORDED"
        ? "NOT_RECORDED"
        : prior.emailConsentBinding
          ? "BOUND"
          : null;
    if (
      prior.deletedAt ||
      prior.status !== "CREATED" ||
      admission?.version !== 1 ||
      admission.digest !== digest ||
      admission.transcriptRevision !== transcriptRevision ||
      admission.humanReviewed !== true ||
      prior.conversationLinks.length !== 1 ||
      !consentEvidence
    )
      throw changed();
    return this.admissionReceipt({
      id: prior.id,
      status: prior.status,
      urgency: prior.urgency,
      transcriptRevision,
      consentEvidence,
    });
  }

  private admissionReceipt(input: {
    id: string;
    status: string;
    urgency: string;
    transcriptRevision: number;
    consentEvidence: "BOUND" | "NOT_RECORDED";
  }) {
    return {
      jobId: input.id,
      status: input.status,
      urgency: input.urgency,
      transcriptRevision: input.transcriptRevision,
      humanReviewed: true as const,
      consentEvidence: input.consentEvidence,
      jobCreated: true as const,
      bookingAuthorized: false as const,
      deliveryAuthorized: false as const,
    };
  }
}
