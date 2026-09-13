import { ConflictException, ForbiddenException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { getRequestContext } from "../common/context/request-context";
import { lockConversationSession } from "../conversations/conversation-session-lock";
import { ConsentSessionClaims } from "./customer-consent-credentials";
import { lifecycle, sessionCleanupDue } from "./verification-retention";
export type CustomerSessionScope = Pick<
  ConsentSessionClaims,
  "tenantId" | "conversationId" | "sessionId"
>;

/** Shared lock order with legacy intake; callers verify the credential before entering.
 * receiptOnly is restricted to authenticated operator receipt lookup. A caller must
 * recheck with the default before any new admission; it grants no write authority.
 */
export async function lockCustomerConsentSession(
  tx: Prisma.TransactionClient,
  session: CustomerSessionScope,
  receiptOnly = false,
) {
  if (getRequestContext()?.impersonatedTenantId)
    throw new ForbiddenException(
      "Impersonation cannot use a customer session.",
    );
  await lockConversationSession(tx, session.tenantId, session.sessionId);
  const tenants = await tx.$queryRaw(
    Prisma.sql`SELECT id FROM "TenantOrganization" WHERE id=${session.tenantId}::uuid AND status='ACTIVE' FOR SHARE`,
  );
  if (!Array.isArray(tenants) || tenants.length !== 1)
    throw new ConflictException("Customer session is unavailable.");
  const rows = await tx.$queryRaw<
    {
      sessionId: unknown;
      marker: unknown;
      capture: unknown;
      hasCapture: boolean;
      status: string;
      lifecycle: unknown;
      hasLifecycle: boolean;
      nowMs: bigint;
    }[]
  >(Prisma.sql`
    SELECT c.status, c."collectedData" -> 'sessionId' AS "sessionId",
      c."collectedData" -> 'verificationLifecycle' AS lifecycle,
      c."collectedData" ? 'verificationLifecycle' AS "hasLifecycle",
      floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS "nowMs",
      c."collectedData" -> 'customerSessionVersion' AS marker,
      c."collectedData" ? 'intakeEmail' AS "hasCapture",
      c."collectedData" -> 'intakeEmail' AS capture FROM "Conversation" c
    JOIN "Customer" customer ON customer.id=c."customerId" AND customer."tenantId"=c."customerTenantId"
      AND customer."tenantId"=c."tenantId" AND customer."deletedAt" IS NULL
    WHERE c.id=${session.conversationId}::uuid AND c."tenantId"=${session.tenantId}::uuid
      AND c.channel='WEBCHAT' AND c."deletedAt" IS NULL FOR UPDATE OF c FOR SHARE OF customer`);
  if (
    rows.length !== 1 ||
    rows[0].sessionId !== session.sessionId ||
    rows[0].marker !== 1
  )
    throw new ConflictException("Customer session is unavailable.");
  if (rows[0].hasLifecycle) {
    const state = lifecycle(rows[0].lifecycle);
    if (
      !state ||
      !Number.isSafeInteger(Number(rows[0].nowMs)) ||
      (!receiptOnly && sessionCleanupDue(state, Number(rows[0].nowMs)))
    )
      throw new ConflictException("Customer session is closed or expired.");
  }
  return rows[0];
}
