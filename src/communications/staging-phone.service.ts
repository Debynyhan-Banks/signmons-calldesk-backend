import {
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHmac } from "node:crypto";
import twilio from "twilio";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { ConversationMemoryCipher } from "../logging/conversation-memory-cipher.service";
import { getRequestContext } from "../common/context/request-context";
import { CustomerConsentCredentials } from "./customer-consent-credentials";
import { DurableVerificationService } from "./durable-verification.service";
import { TwilioVerifyAdapter } from "./twilio-verify.adapter";
import { StagingPhoneAdmission } from "./staging-phone-admission";
import { stagingPhonePolicy } from "./staging-phone-policy";
import { VerificationOptIn } from "./verification-budget-admission";

@Injectable()
export class StagingPhoneService {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly cipher: ConversationMemoryCipher,
  ) {}
  private binding() {
    const p = stagingPhonePolicy(
      this.config.get<unknown>("STAGING_PHONE_TEST_POLICY"),
    );
    if (
      this.config.get("STAGING_PHONE_TEST_ENABLED") !== "true" ||
      String(this.config.get("DEV_AUTH_ENABLED") ?? "false").toLowerCase() !==
        "false" ||
      this.config.get("K_SERVICE") !== "signmons-calldesk-staging" ||
      this.config.get("GOOGLE_CLOUD_PROJECT") !== "signmons" ||
      !p
    )
      throw new ServiceUnavailableException("Staging phone test is disabled.");
    const ctx = getRequestContext();
    if (
      !ctx ||
      ctx.impersonatedTenantId ||
      ctx.tenantId !== p.tenantId ||
      ctx.userId !== p.operatorId ||
      !["owner", "admin"].includes(ctx.role ?? "")
    )
      throw new ForbiddenException("Staging operator binding required.");
    return p;
  }
  async execute(input: Record<string, unknown>, optIn?: VerificationOptIn) {
    const p = this.binding();
    const sessionKey = this.config.get<string>("STAGING_PHONE_SESSION_KEY");
    const digestKey = this.config.get<string>("STAGING_PHONE_DIGEST_KEY");
    const authToken = this.config.get<string>(
      "STAGING_PHONE_TWILIO_AUTH_TOKEN",
    );
    if (
      !sessionKey ||
      !digestKey ||
      !/^[0-9a-f]{64}$/.test(sessionKey) ||
      !/^[0-9a-f]{64}$/.test(digestKey) ||
      sessionKey === digestKey ||
      !authToken ||
      !/^[0-9a-f]{32}$/i.test(authToken)
    )
      throw new ServiceUnavailableException(
        "Staging phone credentials are unavailable.",
      );
    const credentials = new CustomerConsentCredentials({
      activeKeyId: "staging-phone",
      keys: { "staging-phone": Buffer.from(sessionKey, "hex") },
    });
    const scope = credentials.verifySession(input?.sessionToken as string);
    if (
      scope.tenantId !== p.tenantId ||
      scope.sessionId !== p.sessionId ||
      scope.conversationId !== p.conversationId ||
      typeof input.phone !== "string" ||
      !/^\+1[2-9]\d{9}$/.test(input.phone) ||
      createHmac("sha256", Buffer.from(digestKey, "hex"))
        .update(input.phone)
        .digest("hex") !== p.phoneDigest
    )
      throw new ForbiddenException("Staging participant binding required.");
    const admission = new StagingPhoneAdmission(p);
    const adapter = new TwilioVerifyAdapter(p, (options) =>
      twilio(p.accountSid, authToken, options),
    );
    const guarded = (kind: "start" | "check", body: Record<string, unknown>) =>
      this.prisma.$transaction(
        async (tx) => {
          // The approval SHARE lock linearizes dispatch against the stop UPDATE.
          // A stop cannot retract a request already in flight; no new call follows its acknowledgement.
          await admission.current(tx);
          credentials.verifySession(input.sessionToken as string);
          return adapter[kind](body);
        },
        { timeout: 15_000, maxWait: 2000 },
      );
    const durable = new DurableVerificationService(
      this.prisma,
      this.cipher,
      credentials,
      Buffer.from(digestKey, "hex"),
      {
        start: (body) => guarded("start", body),
        check: (body) => guarded("check", body),
      },
      admission,
    );
    const result = await durable.execute(input, optIn);
    return {
      ...result,
      addressValidationAuthorized: false,
      jobAdmissionAuthorized: false,
      paymentAuthorized: false,
    };
  }
  async stop() {
    const p = this.binding();
    await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw(
          Prisma.sql`UPDATE "TenantOrganization" SET settings=jsonb_set(COALESCE(settings, '{}'::jsonb), '{stagingPhoneTestApproval}', '{"enabled":false}'::jsonb), "updatedAt"=clock_timestamp() WHERE id=${p.tenantId}::uuid`,
        );
        await tx.auditLog.create({
          data: {
            tenantId: p.tenantId,
            entityType: "TenantOrganization",
            entityId: p.tenantId,
            actorType: "USER",
            actorId: p.operatorId,
            action: "staging.phone_test_stopped",
            metadata: { version: 1 },
          },
        });
      },
      { timeout: 20_000 },
    );
    return { stopped: true, inFlightMayHaveCompleted: true };
  }
}
