import {
  ConflictException,
  BadRequestException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
  fixtureSmsInput,
  fixtureSmsPolicy,
  fixtureSmsBinding,
  FIXTURE_SMS_FLAGS,
} from "./fixture-sms-policy";
import {
  CustomerConsentCredentials,
  ConsentSessionClaims,
} from "./customer-consent-credentials";

export type FixtureSmsPolicy = {
  fixtureOnly: true;
  tenantId: string;
  sessionId: string;
  phone: string;
  phoneRevision: number;
  version: string;
  sender: string;
  disclosure: string;
  optedOut: boolean;
  active: boolean;
};
type Entry = {
  binding: string;
  policy: FixtureSmsPolicy;
  expiresAt: number;
  recordedAt?: number;
};

/**
 * Explicit local-only, synchronous in-memory proof model. No DI registration,
 * database, provider, live consent type or export-to-delivery path. Source must
 * independently bind a live fixture session to its current phone/policy state.
 * Restart loses all prompts/evidence and refuses old receipts; never restores grants.
 */
export class FixtureSmsConsent {
  private readonly entries = new Map<string, Entry>();
  constructor(
    private readonly credentials: CustomerConsentCredentials,
    private readonly source: (
      claims: ConsentSessionClaims,
    ) => FixtureSmsPolicy | undefined,
    private readonly clock: () => number = Date.now,
  ) {}

  handle(input: Record<string, unknown>): Record<string, unknown> {
    fixtureSmsInput(input);
    const claims = this.credentials.verifySession(input.sessionToken as string);
    const now = this.clock();
    if (
      !Number.isSafeInteger(now) ||
      now >= claims.expiresAt ||
      now < claims.issuedAt
    )
      throw new ConflictException("Fixture session expired.");
    for (const [key, value] of this.entries)
      if (value.expiresAt <= now) this.entries.delete(key);
    const policy = fixtureSmsPolicy(
      this.source(claims),
      claims,
      input.phone as string,
    );
    const binding = fixtureSmsBinding(claims);
    const flags = FIXTURE_SMS_FLAGS;
    if (input.action === "PROMPT") {
      if (input.promptId !== "" || input.accepted !== false)
        throw new BadRequestException("Invalid prompt request.");
      if (policy.optedOut) return { ...flags, state: "UNAVAILABLE" };
      if (this.entries.size >= 256)
        throw new ServiceUnavailableException(
          "Fixture prompt capacity reached.",
        );
      const promptId = randomUUID(),
        expiresAt = Math.min(claims.expiresAt, now + 300000);
      this.entries.set(promptId, { binding, policy, expiresAt });
      return {
        ...flags,
        state: "PROMPT",
        promptId,
        expiresAt,
        sender: policy.sender,
        disclosure: policy.disclosure,
        policyVersion: policy.version,
        privacyPath: "/fixture-sms-privacy",
        termsPath: "/fixture-sms-terms",
      };
    }
    const entry = this.entries.get(input.promptId as string);
    if (
      !entry ||
      entry.binding !== binding ||
      entry.expiresAt <= now ||
      JSON.stringify(entry.policy) !== JSON.stringify(policy) ||
      policy.optedOut
    )
      throw new ConflictException("Fixture prompt changed or unavailable.");
    // Decline never changes suppression or any prior record.
    if (!input.accepted) return { ...flags, state: "NOT_RECORDED" };
    entry.recordedAt ??= now;
    return {
      ...flags,
      state: "RECORDED",
      promptId: input.promptId,
      recordedAt: entry.recordedAt,
      policyVersion: policy.version,
      expiresAt: entry.expiresAt,
    };
  }
}
