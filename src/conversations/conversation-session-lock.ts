import { Prisma } from "@prisma/client";

export async function lockConversationSession(
  tx: Prisma.TransactionClient,
  tenantId: string,
  sessionId: string,
) {
  await tx.$queryRaw(
    Prisma.sql`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${`conversation:${tenantId}:${sessionId}`}, 0))`,
  );
}
