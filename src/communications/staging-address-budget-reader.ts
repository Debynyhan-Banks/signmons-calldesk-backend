import { ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  reviewStagingAddressBudget,
  StagingAddressBudgetAuthority,
} from "./staging-address-budget-policy";
import type { AddressOperationPolicy } from "./address-operation-ledger";

export type StagingBudgetConfiguration = Omit<
  StagingAddressBudgetAuthority,
  "usage" | "now" | "tenantId" | "sessionId" | "sessionExpiresAt"
>;
const refuse = () => new ConflictException("Address operation unavailable.");

/** Called only under the ledger's account/tenant/session locks and Tenant SHARE
 * lock. Tenant settings contain review-only approval material, never secrets.
 * No authoring endpoint or production registry is introduced here.
 */
export async function checkStagingAddressReservation(
  tx: Prisma.TransactionClient,
  config: StagingBudgetConfiguration,
  scope: { tenantId: string; sessionId: string; expiresAt: number },
  policy: AddressOperationPolicy,
  now: number,
  existing?: { heldMicros: bigint },
) {
  const tenant = await tx.tenantOrganization.findUnique({
    where: { id: scope.tenantId },
    select: { settings: true },
  });
  const settings = tenant?.settings;
  const entry =
    settings && typeof settings === "object" && !Array.isArray(settings)
      ? settings.stagingAddressBudgetReview
      : null;
  if (!entry || typeof entry !== "object" || Array.isArray(entry))
    throw refuse();
  // enabled is current stored revocation, separate from runtime configuration.
  if (
    entry.enabled !== true ||
    Object.keys(entry).sort().join() !== "enabled,packet"
  )
    throw refuse();
  const value = entry.packet;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw refuse();
  if (
    value.rateVersion !== policy.rateVersion ||
    value.costMicros !== policy.costMicros ||
    value.validUntil !== policy.validUntil
  )
    throw refuse();
  const usage = {} as StagingAddressBudgetAuthority["usage"];
  for (const key of ["account", "tenant", "session"] as const) {
    const cap = value[key];
    if (
      !cap ||
      typeof cap !== "object" ||
      Array.isArray(cap) ||
      cap.micros !== policy[key].micros ||
      cap.requests !== policy[key].requests
    )
      throw refuse();
    const total = await tx.addressVerificationOperation.aggregate({
      where: {
        accountId: config.accountId,
        ...(key !== "account" ? { tenantId: scope.tenantId } : {}),
        ...(key === "session" ? { sessionId: scope.sessionId } : {}),
      },
      _sum: { heldMicros: true },
      _count: true,
    });
    const held = total._sum.heldMicros ?? 0n;
    // Existing identity was checked by the ledger. Remove only its own hold/count
    // from the prospective check, never from storage or from another request.
    if (
      existing &&
      (existing.heldMicros !== BigInt(policy.costMicros) ||
        held < existing.heldMicros ||
        total._count < 1)
    )
      throw refuse();
    const micros = Number(held - (existing?.heldMicros ?? 0n));
    if (!Number.isSafeInteger(micros)) throw refuse();
    usage[key] = { micros, requests: total._count - (existing ? 1 : 0) };
  }
  if (
    reviewStagingAddressBudget(value, {
      ...config,
      tenantId: scope.tenantId,
      sessionId: scope.sessionId,
      sessionExpiresAt: scope.expiresAt,
      now,
      usage,
    }).status !== "POLICY_READY"
  )
    throw refuse();
}
