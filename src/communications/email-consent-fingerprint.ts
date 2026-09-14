import { ServiceUnavailableException } from "@nestjs/common";
import { createHmac } from "node:crypto";
import { extractIntakeEmail } from "../conversations/conversation-email.service";
import type { EmailConsentFingerprint } from "./appointment-email-consent-evidence";

const purpose = "signmons.email-consent.fingerprint.v1";
const unavailable = () =>
  new ServiceUnavailableException(
    "Email consent fingerprint authority is unavailable.",
  );

/** Server-only dedicated key adapter. No key loading, defaults, registration or
 * historical record rewriting. Version changes apply to newly recorded evidence.
 * Fingerprints are equality metadata, not mailbox verification or consent. */
export class DedicatedEmailConsentFingerprint
  implements EmailConsentFingerprint
{
  #key?: Buffer;
  readonly #version?: string;
  constructor(config?: { key: Buffer; keyVersion: string }) {
    if (!config) return;
    if (
      Object.keys(config).sort().join() !== "key,keyVersion" ||
      !Buffer.isBuffer(config.key) ||
      config.key.length !== 32 ||
      typeof config.keyVersion !== "string" ||
      !/^[a-zA-Z0-9_-]{1,32}$/.test(config.keyVersion)
    )
      throw unavailable();
    this.#key = Buffer.from(config.key);
    this.#version = config.keyVersion;
  }
  /** Local retirement is irreversible. Distributed revocation remains a release
   * responsibility; it must retire every process, never fall back to an old key. */
  retire() {
    this.#key?.fill(0);
    this.#key = undefined;
  }
  fingerprint(tenantId: string, normalizedMailbox: string) {
    if (
      !this.#key ||
      !this.#version ||
      typeof tenantId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        tenantId,
      ) ||
      typeof normalizedMailbox !== "string" ||
      normalizedMailbox.length > 254 ||
      extractIntakeEmail(normalizedMailbox) !== normalizedMailbox
    )
      throw unavailable();
    return Object.freeze({
      digest: createHmac("sha256", this.#key)
        .update(
          JSON.stringify([purpose, this.#version, tenantId, normalizedMailbox]),
        )
        .digest("hex"),
      keyVersion: this.#version,
    });
  }
}
