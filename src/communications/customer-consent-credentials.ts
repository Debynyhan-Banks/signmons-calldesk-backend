import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";

export const CONSENT_PROMPT =
  "May we email this address confirmations, changes and cancellation notices for this appointment, including a private link to manage it? This is optional and does not include marketing. You can stop these emails at any time. Please verify the address before we send appointment details.";
export const CONSENT_PROMPT_DIGEST = createHash("sha256")
  .update(CONSENT_PROMPT)
  .digest("hex");
export const CONSENT_SESSION_MS = 15 * 60 * 1000;
export const CONSENT_PROMPT_MS = 5 * 60 * 1000;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX = /^[0-9a-f]{64}$/;
type Scope = { tenantId: string; conversationId: string; sessionId: string };
export type ConsentSessionClaims = Scope & {
  v: 1;
  purpose: "customer-consent-session";
  jti: string;
  issuedAt: number;
  expiresAt: number;
};
type PromptClaims = Omit<ConsentSessionClaims, "purpose"> & {
  purpose: "customer-consent-prompt";
  sessionJti: string;
  mailboxDigest: string;
  promptDigest: string;
  expectedRevision: number;
};
type Claims = ConsentSessionClaims | PromptClaims;
const deny = () =>
  new UnauthorizedException(
    "Customer consent credential is invalid or expired.",
  );
function validTime(now: number) {
  if (!Number.isSafeInteger(now) || now < 0) throw deny();
}

/** Inactive local model. No environment loader, DI registration, shared-key fallback
 * or live key generation. A separately reviewed bootstrap must deliver credentials
 * only to the initiating browser, over HTTPS with no logs/URLs/storage exposure.
 * Possession authenticates this new session, not a person's identity or mailbox.
 */
export class CustomerConsentCredentials {
  private readonly keys: Map<string, Buffer>;
  private readonly activeKeyId?: string;
  constructor(config?: { activeKeyId: string; keys: Record<string, Buffer> }) {
    this.keys = new Map();
    if (!config) return;
    if (
      !/^[a-zA-Z0-9_-]{1,32}$/.test(config.activeKeyId) ||
      Object.keys(config.keys).length > 2
    )
      throw new Error("Invalid customer consent key configuration.");
    for (const [id, key] of Object.entries(config.keys)) {
      if (
        !/^[a-zA-Z0-9_-]{1,32}$/.test(id) ||
        !Buffer.isBuffer(key) ||
        key.length !== 32
      )
        throw new Error("Invalid customer consent key configuration.");
      this.keys.set(id, Buffer.from(key));
    }
    if (!this.keys.has(config.activeKeyId))
      throw new Error("Missing active customer consent key.");
    this.activeKeyId = config.activeKeyId;
  }
  assertAvailable() {
    if (!this.activeKeyId)
      throw new ServiceUnavailableException(
        "Customer consent credentials are unavailable.",
      );
  }
  issueSession(scope: Scope, now = Date.now()) {
    this.assertAvailable();
    validTime(now);
    if (
      !Object.values(scope).every(
        (v) => typeof v === "string" && UUID.test(v),
      ) ||
      Object.keys(scope).sort().join(",") !==
        "conversationId,sessionId,tenantId"
    )
      throw deny();
    return this.sign({
      ...scope,
      v: 1,
      purpose: "customer-consent-session",
      jti: randomUUID(),
      issuedAt: now,
      expiresAt: now + CONSENT_SESSION_MS,
    });
  }
  verifySession(token: string, now = Date.now()): ConsentSessionClaims {
    const claims = this.verify(token, now);
    if (claims.purpose !== "customer-consent-session") throw deny();
    return claims;
  }
  issuePrompt(
    sessionToken: string,
    mailboxDigest: string,
    expectedRevision: number,
    now = Date.now(),
  ) {
    const session = this.verifySession(sessionToken, now);
    if (
      !HEX.test(mailboxDigest) ||
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      expectedRevision >= 2147483647
    )
      throw deny();
    return this.sign({
      ...session,
      purpose: "customer-consent-prompt",
      jti: randomUUID(),
      sessionJti: session.jti,
      mailboxDigest,
      promptDigest: CONSENT_PROMPT_DIGEST,
      expectedRevision,
      issuedAt: now,
      expiresAt: Math.min(now + CONSENT_PROMPT_MS, session.expiresAt),
    });
  }
  verifyPrompt(
    token: string,
    sessionToken: string,
    now = Date.now(),
  ): PromptClaims {
    const session = this.verifySession(sessionToken, now),
      prompt = this.verify(token, now);
    if (
      prompt.purpose !== "customer-consent-prompt" ||
      prompt.sessionJti !== session.jti ||
      prompt.tenantId !== session.tenantId ||
      prompt.conversationId !== session.conversationId ||
      prompt.sessionId !== session.sessionId ||
      prompt.expiresAt > session.expiresAt ||
      prompt.issuedAt < session.issuedAt
    )
      throw deny();
    return prompt;
  }
  private sign(claims: Claims) {
    this.assertAvailable();
    const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url"),
      prefix = this.activeKeyId + "." + encoded;
    const mac = createHmac("sha256", this.keys.get(this.activeKeyId!)!)
      .update("signmons.customer-consent.v1:" + prefix)
      .digest("base64url");
    return prefix + "." + mac;
  }
  private verify(token: string, now: number): Claims {
    this.assertAvailable();
    validTime(now);
    try {
      if (typeof token !== "string" || token.length > 4096) throw deny();
      const parts = token.split(".");
      if (parts.length !== 3) throw deny();
      const [keyId, encoded, signature] = parts,
        key = this.keys.get(keyId);
      if (
        !key ||
        !/^[A-Za-z0-9_-]+$/.test(encoded) ||
        !/^[A-Za-z0-9_-]{43}$/.test(signature)
      )
        throw deny();
      const supplied = Buffer.from(signature, "base64url");
      if (supplied.toString("base64url") !== signature) throw deny();
      const expected = createHmac("sha256", key)
        .update("signmons.customer-consent.v1:" + keyId + "." + encoded)
        .digest();
      if (
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      )
        throw deny();
      const bytes = Buffer.from(encoded, "base64url");
      if (bytes.toString("base64url") !== encoded) throw deny();
      const c = JSON.parse(bytes.toString("utf8")) as Claims;
      if (!c || typeof c !== "object" || Array.isArray(c)) throw deny();
      const prompt = c.purpose === "customer-consent-prompt";
      const fields = [
        "v",
        "purpose",
        "tenantId",
        "conversationId",
        "sessionId",
        "jti",
        "issuedAt",
        "expiresAt",
        ...(prompt
          ? ["sessionJti", "mailboxDigest", "promptDigest", "expectedRevision"]
          : []),
      ]
        .sort()
        .join(",");
      if (
        Object.keys(c).sort().join(",") !== fields ||
        c.v !== 1 ||
        !["customer-consent-session", "customer-consent-prompt"].includes(
          c.purpose,
        ) ||
        ![c.tenantId, c.conversationId, c.sessionId, c.jti].every(
          (v) => typeof v === "string" && UUID.test(v),
        ) ||
        !Number.isSafeInteger(c.issuedAt) ||
        !Number.isSafeInteger(c.expiresAt) ||
        c.issuedAt < 0 ||
        c.issuedAt > now ||
        c.expiresAt <= now ||
        c.expiresAt <= c.issuedAt ||
        c.expiresAt - c.issuedAt >
          (prompt ? CONSENT_PROMPT_MS : CONSENT_SESSION_MS)
      )
        throw deny();
      if (
        prompt &&
        (!UUID.test(c.sessionJti) ||
          !HEX.test(c.mailboxDigest) ||
          c.promptDigest !== CONSENT_PROMPT_DIGEST ||
          !Number.isSafeInteger(c.expectedRevision) ||
          c.expectedRevision < 0 ||
          c.expectedRevision >= 2147483647)
      )
        throw deny();
      return c;
    } catch {
      throw deny();
    }
  }
}
