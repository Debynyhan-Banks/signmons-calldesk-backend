import { createHmac } from "node:crypto";
import {
  BadRequestException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { Prisma } from "@prisma/client";

// Compatibility contract: do not change the key or hash input during capture integration.
export function smsConsentPhoneHash(
  key: string | undefined,
  tenantId: string,
  phone: string,
): string {
  if (!key)
    throw new ServiceUnavailableException(
      "SMS consent processing is not configured.",
    );
  if (!/^\+[1-9]\d{7,14}$/.test(phone))
    throw new BadRequestException("SMS phone number is invalid.");
  return createHmac("sha256", key).update(`${tenantId}:${phone}`).digest("hex");
}

// Acquire before customer/session/policy locks. Also serializes recipients without a row.
export async function lockSmsConsentRecipient(
  tx: Prisma.TransactionClient,
  tenantId: string,
  phoneHash: string,
): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`sms-consent:${tenantId}:${phoneHash}`}, 0))::text`;
}
