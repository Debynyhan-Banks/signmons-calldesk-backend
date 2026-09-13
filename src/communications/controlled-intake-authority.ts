import { ForbiddenException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

const keys = [
  "version",
  "enabled",
  "tenantId",
  "integrationId",
  "origin",
  "policyVersion",
  "organizationApprovedAt",
  "organizationDigest",
  "paymentApprovedAt",
  "paymentDigest",
  "allowedServiceCategoryIds",
  "priorityPolicy",
  "validFrom",
  "validUntil",
  "packetId",
] as const;
const uuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    v,
  );
const label = (v: unknown): v is string =>
  typeof v === "string" && /^[a-zA-Z0-9:_-]{1,100}$/.test(v);
const digest = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const instant = (v: unknown): v is string =>
  typeof v === "string" &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v;
const refuse = () =>
  new ForbiddenException("Controlled intake authority unavailable.");

export type ControlledIntakeActivation = {
  version: 1;
  enabled: boolean;
  tenantId: string;
  integrationId: string;
  origin: string;
  policyVersion: string;
  organizationApprovedAt: string;
  organizationDigest: string;
  paymentApprovedAt: string;
  paymentDigest: string;
  allowedServiceCategoryIds: readonly string[];
  priorityPolicy: "AUTO_INTAKE_STANDARD_V1";
  validFrom: string;
  validUntil: string;
  packetId: string;
};

export function parseControlledIntakeActivation(
  value: unknown,
): Readonly<ControlledIntakeActivation> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw refuse();
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).sort().join() !== [...keys].sort().join() ||
    v.version !== 1 ||
    typeof v.enabled !== "boolean" ||
    !uuid(v.tenantId) ||
    !uuid(v.packetId) ||
    !label(v.integrationId) ||
    !label(v.policyVersion) ||
    !instant(v.organizationApprovedAt) ||
    !instant(v.paymentApprovedAt) ||
    !digest(v.organizationDigest) ||
    !digest(v.paymentDigest) ||
    !instant(v.validFrom) ||
    !instant(v.validUntil) ||
    Date.parse(v.validUntil) <= Date.parse(v.validFrom) ||
    v.priorityPolicy !== "AUTO_INTAKE_STANDARD_V1" ||
    !Array.isArray(v.allowedServiceCategoryIds) ||
    v.allowedServiceCategoryIds.length === 0 ||
    !v.allowedServiceCategoryIds.every(uuid) ||
    new Set(v.allowedServiceCategoryIds).size !==
      v.allowedServiceCategoryIds.length ||
    typeof v.origin !== "string"
  )
    throw refuse();
  try {
    const url = new URL(v.origin);
    if (
      url.protocol !== "https:" ||
      url.origin !== v.origin ||
      url.username ||
      url.password
    )
      throw refuse();
  } catch {
    throw refuse();
  }
  return Object.freeze({
    version: 1,
    enabled: v.enabled,
    tenantId: v.tenantId,
    integrationId: v.integrationId,
    origin: v.origin,
    policyVersion: v.policyVersion,
    organizationApprovedAt: v.organizationApprovedAt,
    organizationDigest: v.organizationDigest,
    paymentApprovedAt: v.paymentApprovedAt,
    paymentDigest: v.paymentDigest,
    allowedServiceCategoryIds: Object.freeze([...v.allowedServiceCategoryIds]),
    priorityPolicy: "AUTO_INTAKE_STANDARD_V1",
    validFrom: v.validFrom,
    validUntil: v.validUntil,
    packetId: v.packetId,
  });
}

export type ControlledIntakeScope = Readonly<{
  tenantId: string;
  integrationId: string;
  origin: string;
  serviceCategoryId: string;
}>;
export type ControlledIntakeCurrentState = {
  tenantId: string;
  tenantActive: boolean;
  serviceCategoryId: string;
  categoryActive: boolean;
  organizationApprovedAt: string;
  organizationDigest: string;
  paymentApprovedAt: string;
  paymentDigest: string;
  nowMs: number;
};

/** Local composition only, deliberately unregistered. Neither this capability nor
 * its result is customer authentication, verification proof or job-write permission.
 * Call check under the admission transaction's locks, immediately before writing.
 */
export class ControlledIntakeAuthority {
  readonly #issued = new WeakMap<object, string>();
  constructor(
    private readonly readActivation: () => unknown = () => undefined,
    private readonly readCurrent?: (
      tx: Prisma.TransactionClient,
      scope: ControlledIntakeScope,
    ) => Promise<ControlledIntakeCurrentState | null>,
  ) {}

  issue(): Readonly<object> {
    const activation = parseControlledIntakeActivation(this.readActivation());
    if (!activation.enabled || !this.readCurrent) throw refuse();
    const capability = Object.freeze({});
    this.#issued.set(capability, JSON.stringify(activation));
    return capability;
  }

  async check(
    capability: unknown,
    tx: Prisma.TransactionClient,
    scope: ControlledIntakeScope,
  ) {
    if (
      !capability ||
      typeof capability !== "object" ||
      !this.#issued.has(capability)
    )
      throw refuse();
    const activation = parseControlledIntakeActivation(this.readActivation());
    const binding = this.#issued.get(capability);
    if (
      !activation.enabled ||
      binding !== JSON.stringify(activation) ||
      !this.readCurrent ||
      !scope ||
      scope.tenantId !== activation.tenantId ||
      scope.integrationId !== activation.integrationId ||
      scope.origin !== activation.origin ||
      !activation.allowedServiceCategoryIds.includes(scope.serviceCategoryId)
    )
      throw refuse();
    const requested = Object.freeze({ ...scope });
    let current: ControlledIntakeCurrentState | null;
    try {
      current = await this.readCurrent(tx, requested);
    } catch {
      // Do not expose database or configuration details through an authority refusal.
      throw refuse();
    }
    // Re-read after the asynchronous transaction-state read: revocation wins.
    const latest = parseControlledIntakeActivation(this.readActivation());
    if (
      !latest.enabled ||
      JSON.stringify(latest) !== binding ||
      !current ||
      current.tenantId !== requested.tenantId ||
      current.serviceCategoryId !== requested.serviceCategoryId ||
      current.tenantActive !== true ||
      current.categoryActive !== true ||
      current.organizationApprovedAt !== activation.organizationApprovedAt ||
      current.organizationDigest !== activation.organizationDigest ||
      current.paymentApprovedAt !== activation.paymentApprovedAt ||
      current.paymentDigest !== activation.paymentDigest ||
      !Number.isSafeInteger(current.nowMs) ||
      current.nowMs < Date.parse(activation.validFrom) ||
      current.nowMs >= Date.parse(activation.validUntil) ||
      current.nowMs < Date.parse(activation.organizationApprovedAt) ||
      current.nowMs < Date.parse(activation.paymentApprovedAt)
    )
      throw refuse();
    return Object.freeze({
      actorId: "signmons-intake-admission-v1" as const,
      actorType: "SYSTEM_AI" as const,
      decisionSource: "DETERMINISTIC_POLICY" as const,
      policyVersion: activation.policyVersion,
      priorityPolicy: activation.priorityPolicy,
      packetId: activation.packetId,
    });
  }
}
