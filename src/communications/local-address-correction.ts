import { randomUUID } from "node:crypto";
import {
  createVerificationProof,
  verificationProofCurrent,
  sameFreshnessPolicy,
  validFreshnessPolicy,
  type VerificationProof,
  type VerificationFreshnessPolicy,
} from "./verification-freshness";
import {
  GoogleAddressAdapter,
  type AddressCorrectionCandidate,
} from "./google-address.adapter";

export type CorrectionScope = {
  tenantId: string;
  sessionId: string;
  revision: number;
  expiresAt: number;
  policy?: VerificationFreshnessPolicy | null;
};
type Pending = {
  id: string;
  scope: CorrectionScope;
  candidate: AddressCorrectionCandidate;
  expiresAt: number;
  proof: VerificationProof;
  confirmedAt?: number;
};

/** Single-session local composition. No route, persistence or production auth.
 * readScope must be a trusted server/fixture read, never request-provided claims.
 * Lost process state refuses confirmation rather than reconstructing authority.
 */
export class LocalAddressCorrection {
  private pending: Pending | null = null;
  private generation = 0;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  constructor(
    private readonly adapter: GoogleAddressAdapter,
    private readonly readScope: () => CorrectionScope | null,
    private readonly now: () => number = Date.now,
  ) {}

  clear() {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    this.pending = null;
    this.generation++;
  }

  async propose(input: unknown) {
    this.clear();
    const generation = this.generation;
    const scope = this.current();
    if (!scope) return this.refused();
    const preview = await this.adapter.preview(input);
    if (
      generation !== this.generation ||
      !this.same(scope, this.current()) ||
      !preview.candidate
    )
      return this.refused();
    const checkedAt = this.now();
    const proof = createVerificationProof(
      { ...scope, revision: String(scope.revision) },
      scope.policy,
      checkedAt,
      checkedAt,
    );
    if (!proof) return this.refused();
    const pending: Pending = {
      id: randomUUID(),
      scope,
      candidate: structuredClone(preview.candidate),
      expiresAt: proof.expiresAt,
      proof,
    };
    this.pending = pending;
    this.expiryTimer = setTimeout(
      () => this.clear(),
      Math.max(0, pending.expiresAt - this.now()),
    );
    this.expiryTimer.unref();
    return {
      status: "CONFIRMATION_REQUIRED" as const,
      candidateId: pending.id,
      revision: scope.revision,
      candidate: structuredClone(pending.candidate),
      expiresAt: pending.expiresAt,
      checkedAt,
      ...this.authority(),
    };
  }

  confirm(input: unknown) {
    const scope = this.current();
    const pending = this.pending;
    if (
      !pending ||
      !scope ||
      !this.same(pending.scope, scope) ||
      !verificationProofCurrent(
        pending.proof,
        { ...scope, revision: String(scope.revision) },
        scope.policy,
        this.now(),
      )
    ) {
      this.clear();
      return this.refused();
    }
    if (!input || typeof input !== "object" || Array.isArray(input))
      return this.refused();
    const data = input as Record<string, unknown>;
    if (
      Object.keys(data).sort().join(",") !== "candidateId,confirmed,revision" ||
      data.candidateId !== pending.id ||
      data.revision !== scope.revision ||
      data.confirmed !== true
    )
      return this.refused();
    pending.confirmedAt ??= this.now();
    return {
      status: "CUSTOMER_CONFIRMED" as const,
      checkedAt: pending.proof.checkedAt,
      confirmedAt: pending.confirmedAt,
      expiresAt: pending.expiresAt,
      candidateId: pending.id,
      revision: scope.revision,
      // Fresh copy of the exact presented fields, not submitted replacement text.
      customerAddress: structuredClone(pending.candidate),
      ...this.authority(),
    };
  }

  private current(): CorrectionScope | null {
    const scope = this.readScope();
    const now = this.now();
    if (
      !scope ||
      !Number.isFinite(now) ||
      !scope.tenantId ||
      !scope.sessionId ||
      !Number.isSafeInteger(scope.revision) ||
      scope.revision < 0 ||
      !Number.isFinite(scope.expiresAt) ||
      scope.expiresAt <= now ||
      !validFreshnessPolicy(scope.policy)
    )
      return null;
    return { ...scope, policy: { ...scope.policy } };
  }
  private same(a: CorrectionScope, b: CorrectionScope | null) {
    return (
      !!b &&
      a.tenantId === b.tenantId &&
      a.sessionId === b.sessionId &&
      a.revision === b.revision &&
      a.expiresAt === b.expiresAt &&
      sameFreshnessPolicy(a.policy, b.policy)
    );
  }
  private authority() {
    return {
      fixtureOnly: true as const,
      addressVerified: false as const,
      county: "UNKNOWN" as const,
      admissionAuthorized: false as const,
    };
  }
  private refused() {
    return { status: "REFUSED" as const, ...this.authority() };
  }
}
