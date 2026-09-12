import { BadRequestException, ConflictException } from "@nestjs/common";
import type { ConsentSessionClaims } from "./customer-consent-credentials";
import type { FixtureSmsPolicy } from "./fixture-sms-consent";

export const FIXTURE_SMS_FLAGS = {
  fixtureOnly: true,
  deliveryAuthorized: false,
  liveConsentRecorded: false,
} as const;

export function fixtureSmsInput(input: Record<string, unknown>) {
  if (
    !input ||
    Object.keys(input).sort().join(",") !==
      "accepted,action,phone,promptId,sessionToken" ||
    typeof input.sessionToken !== "string" ||
    input.sessionToken.length > 4096 ||
    typeof input.phone !== "string" ||
    !/^\+[1-9][0-9]{7,14}$/.test(input.phone) ||
    typeof input.promptId !== "string" ||
    input.promptId.length > 64 ||
    typeof input.accepted !== "boolean" ||
    (input.action !== "PROMPT" && input.action !== "CAPTURE")
  )
    throw new BadRequestException("Invalid fixture SMS request.");
  return input as {
    sessionToken: string;
    phone: string;
    promptId: string;
    accepted: boolean;
    action: "PROMPT" | "CAPTURE";
  };
}

export function fixtureSmsPolicy(
  source: unknown,
  claims: ConsentSessionClaims,
  phone: string,
): FixtureSmsPolicy {
  const p = source as FixtureSmsPolicy | undefined;
  if (
    !p ||
    p.fixtureOnly !== true ||
    p.active !== true ||
    p.tenantId !== claims.tenantId ||
    p.sessionId !== claims.sessionId ||
    p.phone !== phone ||
    !Number.isSafeInteger(p.phoneRevision) ||
    p.phoneRevision < 0 ||
    typeof p.version !== "string" ||
    !p.version ||
    p.version.length > 100 ||
    typeof p.sender !== "string" ||
    !p.sender ||
    p.sender.length > 120 ||
    typeof p.disclosure !== "string" ||
    !p.disclosure ||
    p.disclosure.length > 2000 ||
    typeof p.optedOut !== "boolean"
  )
    throw new ConflictException("Fixture SMS policy unavailable.");
  return {
    fixtureOnly: true,
    tenantId: p.tenantId,
    sessionId: p.sessionId,
    phone: p.phone,
    phoneRevision: p.phoneRevision,
    version: p.version,
    sender: p.sender,
    disclosure: p.disclosure,
    optedOut: p.optedOut,
    active: true,
  };
}

export function fixtureSmsBinding(claims: ConsentSessionClaims) {
  return JSON.stringify([
    claims.tenantId,
    claims.conversationId,
    claims.sessionId,
    claims.jti,
  ]);
}
