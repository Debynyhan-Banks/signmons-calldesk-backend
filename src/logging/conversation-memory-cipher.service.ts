import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { ConfigType } from "@nestjs/config";
import appConfig from "../config/app.config";

const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";

@Injectable()
export class ConversationMemoryCipher {
  private readonly key: Buffer;

  constructor(
    @Inject(appConfig.KEY)
    config: ConfigType<typeof appConfig>,
  ) {
    this.key = Buffer.from(config.conversationDataEncryptionKey, "hex");
    if (this.key.length !== 32) {
      throw new Error("Conversation encryption key must be 32 bytes.");
    }
  }

  encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const encrypted = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return [
      VERSION,
      iv.toString("base64url"),
      tag.toString("base64url"),
      encrypted.toString("base64url"),
    ].join(".");
  }

  decrypt(value: string): string | null {
    try {
      const [version, rawIv, rawTag, rawEncrypted] = value.split(".");
      if (
        version !== VERSION ||
        !rawIv ||
        !rawTag ||
        rawEncrypted === undefined
      ) {
        return null;
      }
      const decipher = createDecipheriv(
        ALGORITHM,
        this.key,
        Buffer.from(rawIv, "base64url"),
      );
      decipher.setAuthTag(Buffer.from(rawTag, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(rawEncrypted, "base64url")),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      return null;
    }
  }
}
