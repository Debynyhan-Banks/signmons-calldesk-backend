import { ConversationMemoryCipher } from "../logging/conversation-memory-cipher.service";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_AGE_MS = 5 * 60 * 1000;

export type GoogleCorrectionBinding = {
  tenantId: string;
  sessionId: string;
  conversationId: string;
  serviceCategoryId: string;
  revision: number;
  policyVersion: string;
  organizationApprovedAt: string;
};

type Claims = GoogleCorrectionBinding & {
  version: 1;
  purpose: "google-address-correction-continuation";
  responseId: string;
  issuedAt: number;
  expiresAt: number;
};

/**
 * Stateless, encrypted handoff for one corrected request. Ciphertext may exist
 * only in the initiating page's memory; raw provider identity is never returned.
 */
export class GoogleCorrectionContinuation {
  constructor(
    private readonly cipher: Pick<
      ConversationMemoryCipher,
      "encrypt" | "decrypt"
    >,
    private readonly now: () => number = Date.now,
  ) {}

  issue(
    responseId: unknown,
    binding: GoogleCorrectionBinding,
    sessionExpiresAt: number,
  ): string | undefined {
    const now = this.now();
    if (
      typeof responseId !== "string" ||
      !UUID.test(responseId) ||
      !validBinding(binding) ||
      !Number.isSafeInteger(now) ||
      !Number.isSafeInteger(sessionExpiresAt)
    )
      return undefined;
    const expiresAt = Math.min(sessionExpiresAt, now + MAX_AGE_MS);
    if (expiresAt <= now) return undefined;
    try {
      const token = this.cipher.encrypt(
        JSON.stringify({
          version: 1,
          purpose: "google-address-correction-continuation",
          ...binding,
          responseId,
          issuedAt: now,
          expiresAt,
        } satisfies Claims),
      );
      return validToken(token) ? token : undefined;
    } catch {
      return undefined;
    }
  }

  open(
    token: unknown,
    binding: GoogleCorrectionBinding,
    sessionExpiresAt: number,
  ): string | undefined {
    const now = this.now();
    if (
      !validToken(token) ||
      !validBinding(binding) ||
      !Number.isSafeInteger(now) ||
      !Number.isSafeInteger(sessionExpiresAt)
    )
      return undefined;
    try {
      const raw = this.cipher.decrypt(token);
      if (!raw || raw.length > 4096) return undefined;
      const claims = JSON.parse(raw) as Claims;
      if (
        !claims ||
        typeof claims !== "object" ||
        Array.isArray(claims) ||
        Object.keys(claims).sort().join(",") !==
          [
            "conversationId",
            "expiresAt",
            "issuedAt",
            "organizationApprovedAt",
            "policyVersion",
            "purpose",
            "responseId",
            "revision",
            "serviceCategoryId",
            "sessionId",
            "tenantId",
            "version",
          ]
            .sort()
            .join(",") ||
        claims.version !== 1 ||
        claims.purpose !== "google-address-correction-continuation" ||
        !UUID.test(claims.responseId) ||
        !validBinding(claims) ||
        !Number.isSafeInteger(claims.issuedAt) ||
        !Number.isSafeInteger(claims.expiresAt) ||
        claims.issuedAt > now ||
        claims.expiresAt <= now ||
        claims.expiresAt <= claims.issuedAt ||
        claims.expiresAt - claims.issuedAt > MAX_AGE_MS ||
        claims.expiresAt > sessionExpiresAt ||
        !sameBinding(claims, binding)
      )
        return undefined;
      return claims.responseId;
    } catch {
      return undefined;
    }
  }
}

function validToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 40 &&
    value.length <= 4096 &&
    value.startsWith("v1.") &&
    /^[A-Za-z0-9._-]+$/.test(value)
  );
}

function validBinding(value: GoogleCorrectionBinding) {
  return (
    !!value &&
    [
      value.tenantId,
      value.sessionId,
      value.conversationId,
      value.serviceCategoryId,
    ].every((v) => typeof v === "string" && UUID.test(v)) &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 1 &&
    value.revision <= 2147483647 &&
    typeof value.policyVersion === "string" &&
    /^[A-Za-z0-9_.-]{1,80}$/.test(value.policyVersion) &&
    typeof value.organizationApprovedAt === "string" &&
    Number.isFinite(Date.parse(value.organizationApprovedAt))
  );
}

function sameBinding(a: GoogleCorrectionBinding, b: GoogleCorrectionBinding) {
  return (
    a.tenantId === b.tenantId &&
    a.sessionId === b.sessionId &&
    a.conversationId === b.conversationId &&
    a.serviceCategoryId === b.serviceCategoryId &&
    a.revision === b.revision &&
    a.policyVersion === b.policyVersion &&
    a.organizationApprovedAt === b.organizationApprovedAt
  );
}
