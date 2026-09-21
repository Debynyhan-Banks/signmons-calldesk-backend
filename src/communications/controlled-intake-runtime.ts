import { ServiceUnavailableException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import twilio from "twilio";
import { PrismaService } from "../prisma/prisma.service";
import { ConversationMemoryCipher } from "../logging/conversation-memory-cipher.service";
import {
  parseControlledRuntimeConfig,
  RuntimeFacts,
} from "./controlled-intake-runtime-config";
import { CustomerConsentCredentials } from "./customer-consent-credentials";
import { DedicatedEmailConsentFingerprint } from "./email-consent-fingerprint";
import { AppointmentEmailConsentEvidenceStore } from "./appointment-email-consent-evidence";
import { CustomerConsentResponseService } from "./customer-consent-response.service";
import { CustomerConsentCaptureService } from "./customer-consent-capture.service";
import { CustomerIntakeContinuationService } from "./customer-intake-continuation.service";
import { ControlledIntakeAuthority } from "./controlled-intake-authority";
import { ControlledCustomerAdmission } from "./controlled-customer-admission";
import { ControlledCustomerVerification } from "./controlled-customer-verification";
import { ControlledIntakeComposition } from "./controlled-intake-composition";
import { DurableVerificationService } from "./durable-verification.service";
import {
  TwilioVerifyAdapter,
  VerifyClientFactory,
} from "./twilio-verify.adapter";
import {
  GoogleAddressOAuthTransport,
  GoogleAddressOAuthPorts,
} from "./google-address-oauth.transport";
import { SharedCustomerBrowserBudget } from "./shared-customer-browser-budget";
import { CustomerConsentBrowserTransport } from "./customer-consent-browser-transport";
import { lockCustomerConsentSession } from "./customer-consent-session-lock";
import { VERIFICATION_PROOF_MS } from "./verification-freshness";
import { VerificationCleanupService } from "./verification-cleanup.service";

type Resources = {
  prisma: Pick<PrismaService, "$transaction">;
  cipher: Pick<ConversationMemoryCipher, "encrypt" | "decrypt">;
  /** Exact version-reference -> injected material. Never populated from HTTP. */
  secrets: Readonly<Record<string, Buffer | string>>;
  verifyFactory?: VerifyClientFactory;
  googlePorts?: GoogleAddressOAuthPorts;
};
const deny = () =>
  new ServiceUnavailableException("Controlled runtime unavailable.");
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};

/** Explicit startup composition only. No environment/secret reads or main mount.
 * Caller must independently establish reviewed runtime facts and inject secrets.
 * Construct once per process. Construction never dispatches provider requests. */
export async function loadControlledIntakeRuntime(
  value: unknown,
  facts: RuntimeFacts,
  resources?: Resources,
) {
  const config = parseControlledRuntimeConfig(value, facts);
  if (!config) return undefined;
  if (!resources || config.project !== "signmons") throw deny();
  const p = resources,
    a = config.activation;
  let retired = false;
  const current = async (tx: Prisma.TransactionClient) => {
    if (retired) throw deny();
    const rows = await tx.$queryRaw<
      { settings: Prisma.JsonValue; nowMs: bigint }[]
    >(
      Prisma.sql`SELECT settings, floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS "nowMs" FROM "TenantOrganization" WHERE id=${a.tenantId}::uuid AND status='ACTIVE' FOR SHARE`,
    );
    const approval = object(
        object(rows[0]?.settings).controlledRuntimeApproval,
      ),
      now = Number(rows[0]?.nowMs);
    if (
      retired ||
      rows.length !== 1 ||
      Object.keys(approval).sort().join() !== "digest,enabled" ||
      approval.enabled !== true ||
      approval.digest !== config.digest ||
      !Number.isSafeInteger(now) ||
      now < Date.parse(a.validFrom) ||
      now >= Date.parse(a.validUntil)
    )
      throw deny();
  };
  try {
    await p.prisma.$transaction(current);
    const refs = [
      ...Object.values(config.secrets.sessionKeys),
      config.secrets.digestKey,
      config.secrets.fingerprintKey,
      config.secrets.twilioToken,
    ];
    if (Object.keys(p.secrets).sort().join() !== [...refs].sort().join())
      throw deny();
    const material = refs.map((ref) => p.secrets[ref]);
    const keyMaterial = material.slice(0, -1);
    if (!keyMaterial.every((k) => Buffer.isBuffer(k) && k.length === 32))
      throw deny();
    const copied = keyMaterial.map((k) => Buffer.from(k));
    try {
      if (new Set(copied.map((k) => k.toString("hex"))).size !== copied.length)
        throw deny();
      const token = material.at(-1);
      if (typeof token !== "string" || !/^[a-fA-F0-9]{32}$/.test(token))
        throw deny();
      const keys = Object.fromEntries(
        Object.keys(config.secrets.sessionKeys).map((id, i) => [id, copied[i]]),
      );
      const credentials = new CustomerConsentCredentials({
        activeKeyId: config.secrets.activeKeyId,
        keys,
      });
      const fingerprint = new DedicatedEmailConsentFingerprint({
        key: copied.at(-1)!,
        keyVersion: config.secrets.fingerprintKeyVersion,
      });
      const evidence = new AppointmentEmailConsentEvidenceStore(
        p.cipher,
        fingerprint,
      );
      const responses = new CustomerConsentResponseService(
        p.prisma,
        p.cipher,
        credentials,
        evidence,
      );
      const capture = new CustomerConsentCaptureService(
        p.prisma,
        p.cipher,
        credentials,
      );
      const intake = new CustomerIntakeContinuationService(
        p.prisma,
        p.cipher,
        credentials,
        undefined,
        evidence,
      );
      const authority = new ControlledIntakeAuthority(
        () => a,
        async (tx, scope) => {
          await current(tx);
          return intake.readControlledCurrentState(tx, scope);
        },
      );
      const capability = authority.issue();
      const scope = {
        tenantId: a.tenantId,
        integrationId: a.integrationId,
        origin: a.origin,
        serviceCategoryId: a.allowedServiceCategoryIds[0],
      };
      const authorize = async (tx: Prisma.TransactionClient) => {
        await authority.check(capability, tx, scope);
      };
      await p.prisma.$transaction(authorize);
      const admission = new ControlledCustomerAdmission(config.phone);
      const adapter = new TwilioVerifyAdapter(
        config.phone,
        p.verifyFactory ??
          ((options) => twilio(config.phone.accountSid, token, options)),
      );
      const durable = new DurableVerificationService(
        p.prisma,
        p.cipher,
        credentials,
        copied[copied.length - 2],
        adapter,
        admission,
        undefined,
        async (tx, tenantId) => {
          if (tenantId !== a.tenantId) throw deny();
          await authorize(tx);
          return {
            mode: "CONTROLLED_VERIFY_V1",
            version: a.policyVersion,
            accountSid: config.phone.accountSid,
            serviceSid: config.phone.serviceSid,
            noticeVersion: config.phone.noticeVersion,
            businessPolicyVersion: a.organizationApprovedAt,
            lifetimeMs: VERIFICATION_PROOF_MS,
          };
        },
      );
      const verification = new ControlledCustomerVerification({
        durable,
        noticeVersion: config.phone.noticeVersion,
        authorize: async (token) => {
          const session = credentials.verifySession(token);
          if (session.tenantId !== a.tenantId) throw deny();
          await p.prisma.$transaction(async (tx) => {
            await authorize(tx);
            await lockCustomerConsentSession(tx, session);
          });
        },
      });
      const composition = new ControlledIntakeComposition({
        prisma: p.prisma,
        credentials,
        intake,
        tenantId: a.tenantId,
        integrationId: a.integrationId,
        origin: a.origin,
        serviceCategoryId: scope.serviceCategoryId,
        authority,
        capability,
        phone: durable,
        transport: new GoogleAddressOAuthTransport(true, p.googlePorts),
        addressAccountId: config.addressAccountId,
        readAddressPolicy: async (tx) => {
          await current(tx);
          return config.addressPolicy;
        },
      });
      const shared = new SharedCustomerBrowserBudget(
        p.prisma,
        config.browserBudget,
      );
      const transport = new CustomerConsentBrowserTransport(
        { origin: a.origin, tenantId: a.tenantId },
        {
          credentials,
          responses: {
            start: async () => {
              await p.prisma.$transaction(authorize);
              return responses.start();
            },
            prompt: (input) => responses.prompt(input),
            respond: (input) => responses.respond(input),
          },
          capture,
          draft: intake,
          continuation: {
            continue: (input) => intake.continueOrganization(input),
          },
          controlled: composition,
          controlledVerification: verification,
          controlledLifecycle: new VerificationCleanupService(
            p.prisma,
            credentials,
            { mode: "CONTROLLED_SESSION_V1", tenantId: a.tenantId },
          ),
          budget: {
            acquire: async (peer, operation) => {
              await p.prisma.$transaction(current);
              return shared.acquire(peer, operation);
            },
          },
        },
      );
      return Object.freeze({
        binding: Object.freeze({
          tenantId: a.tenantId,
          integrationId: a.integrationId,
          security: config.security,
          transport,
        }),
        retire: () => {
          retired = true;
          fingerprint.retire();
        },
      });
    } finally {
      copied.forEach((k) => k.fill(0));
    }
  } catch {
    throw deny();
  }
}
