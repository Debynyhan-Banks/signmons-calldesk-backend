import {
  ConflictException,
  ForbiddenException,
  HttpException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { getRequestContext } from "../common/context/request-context";
import { PrismaService } from "../prisma/prisma.service";
import {
  exactPolicyKeys,
  validateSmsPolicy,
  smsPolicyDigest,
  policyRevision,
  policyReference,
} from "./tenant-sms-policy";

export type PolicyPublication = {
  tenantId: string;
  versionId: string;
  digest: string;
  reference: string;
  fixtureOnly: true;
  expiresAt: number;
};
export type SmsPolicyAuthority = {
  allowedUrls(tenantId: string): readonly string[];
  // Trusted local evidence resolver, not a URL fetcher or browser-supplied attestation.
  publication(reference: string): PolicyPublication | undefined;
};
const flags = {
  fixtureOnly: true,
  liveCaptureEnabled: false,
  deliveryAuthorized: false,
} as const;
const unavailable = () =>
  new ConflictException("SMS policy is unavailable or changed.");

/** Inactive P1 application boundary. No controller/DI registration or live consent writes. */
export class TenantSmsPolicyRegistry {
  constructor(
    private readonly prisma: Pick<PrismaService, "$transaction">,
    private readonly authority: SmsPolicyAuthority,
  ) {}

  async saveDraft(raw: unknown) {
    const ctx = this.context();
    exactPolicyKeys(raw, ["expectedRevision", "content"]);
    const expected = policyRevision(raw.expectedRevision);
    const content = validateSmsPolicy(
      raw.content,
      this.authority.allowedUrls(ctx.tenantId),
    );
    return this.run(async (tx) => {
      const head = await this.lock(tx, ctx.tenantId);
      if ((head?.revision ?? 0) !== expected) throw unavailable();
      if (Date.parse(content.expiresAt) <= (await this.now(tx)))
        throw unavailable();
      const versionId = randomUUID(),
        revision = expected + 1;
      await tx.tenantSmsPolicyVersion.create({
        data: {
          id: versionId,
          tenantId: ctx.tenantId,
          content,
          digest: smsPolicyDigest(content),
        },
      });
      const audit = await this.audit(
        tx,
        ctx,
        versionId,
        revision,
        "DRAFT",
        "draft-created",
      );
      const data = {
        versionId,
        revision,
        state: "DRAFT",
        publicationRef: null,
        lastAuditId: audit.id,
      };
      await tx.tenantSmsPolicyHead.upsert({
        where: { tenantId: ctx.tenantId },
        create: { tenantId: ctx.tenantId, ...data },
        update: data,
      });
      return { ...flags, versionId, revision, state: "DRAFT" };
    });
  }

  async transition(raw: unknown) {
    const ctx = this.context();
    exactPolicyKeys(raw, ["expectedRevision", "target", "evidenceRef"]);
    const expected = policyRevision(raw.expectedRevision),
      reference = policyReference(raw.evidenceRef);
    const target = raw.target;
    if (
      typeof target !== "string" ||
      ![
        "REVIEWED",
        "PUBLISHED_VERIFIED",
        "CAPTURE_ELIGIBLE",
        "SUSPENDED",
      ].includes(target)
    )
      throw unavailable();
    return this.run(async (tx) => {
      const head = await this.lock(tx, ctx.tenantId);
      if (!head || head.revision !== expected || head.state === "SUSPENDED")
        throw unavailable();
      const next: Record<string, string> = {
        DRAFT: "REVIEWED",
        REVIEWED: "PUBLISHED_VERIFIED",
        PUBLISHED_VERIFIED: "CAPTURE_ELIGIBLE",
      };
      if (target !== "SUSPENDED" && next[head.state] !== target)
        throw unavailable();
      const now = await this.now(tx);
      const content =
        target === "SUSPENDED"
          ? undefined
          : this.content(head.version, ctx.tenantId);
      if (content && Date.parse(content.expiresAt) <= now) throw unavailable();
      let publicationRef = head.publicationRef;
      if (target === "PUBLISHED_VERIFIED") publicationRef = reference;
      if (["PUBLISHED_VERIFIED", "CAPTURE_ELIGIBLE"].includes(target))
        this.publication(publicationRef, head.version, now);
      if (
        target === "CAPTURE_ELIGIBLE" &&
        (!content || Date.parse(content.effectiveAt) > now)
      )
        throw unavailable();
      const revision = expected + 1;
      const audit = await this.audit(
        tx,
        ctx,
        head.versionId,
        revision,
        target,
        reference,
      );
      await tx.tenantSmsPolicyHead.update({
        where: { tenantId: ctx.tenantId },
        data: {
          state: target,
          revision,
          publicationRef,
          lastAuditId: audit.id,
        },
      });
      return { ...flags, versionId: head.versionId, revision, state: target };
    });
  }

  async read() {
    const ctx = this.context();
    return this.run(async (tx) => {
      const head = await this.lock(tx, ctx.tenantId);
      if (!head) return { ...flags, revision: 0, state: "MISSING" };
      // Operational status stays readable when a URL is removed; no eligibility follows.
      return {
        ...flags,
        versionId: head.versionId,
        revision: head.revision,
        state: head.state,
      };
    });
  }

  // Composition seam for the existing intake transaction. P2 connects real consent.
  async readForCapture(
    tx: Prisma.TransactionClient,
    tenantId: string,
    expected?: { versionId: string; revision: number },
  ) {
    this.context(tenantId, true);
    const head = await this.lock(tx, tenantId);
    if (
      !head ||
      head.state !== "CAPTURE_ELIGIBLE" ||
      (expected &&
        (head.versionId !== expected.versionId ||
          head.revision !== expected.revision))
    )
      throw unavailable();
    const now = await this.now(tx),
      content = this.content(head.version, tenantId);
    if (
      Date.parse(content.effectiveAt) > now ||
      Date.parse(content.expiresAt) <= now
    )
      throw unavailable();
    this.publication(head.publicationRef, head.version, now);
    return {
      ...flags,
      versionId: head.versionId,
      revision: head.revision,
      ...content,
    };
  }

  private context(tenantId?: string, reader = false) {
    const ctx = getRequestContext(),
      roles = reader
        ? ["owner", "admin", "webchat_integration"]
        : ["owner", "admin"];
    if (
      !ctx?.tenantId ||
      !ctx.userId ||
      ctx.impersonatedTenantId ||
      !roles.includes(ctx.role?.toLowerCase() ?? "") ||
      (tenantId && ctx.tenantId !== tenantId)
    )
      throw new ForbiddenException("Tenant SMS policy access denied.");
    return { tenantId: ctx.tenantId, actorId: ctx.userId };
  }
  private async lock(tx: Prisma.TransactionClient, tenantId: string) {
    await tx.$queryRaw(
      Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`sms-policy:${tenantId}`},0))`,
    );
    const tenant = await tx.$queryRaw<unknown[]>(
      Prisma.sql`SELECT id FROM "TenantOrganization" WHERE id=${tenantId}::uuid AND status='ACTIVE' FOR SHARE`,
    );
    if (tenant.length !== 1) throw unavailable();
    await tx.$queryRaw(
      Prisma.sql`SELECT "tenantId" FROM "TenantSmsPolicyHead" WHERE "tenantId"=${tenantId}::uuid FOR UPDATE`,
    );
    return tx.tenantSmsPolicyHead.findUnique({
      where: { tenantId },
      include: { version: true },
    });
  }
  private async now(tx: Prisma.TransactionClient) {
    const [clock] = await tx.$queryRaw<{ nowMs: bigint }[]>(
      Prisma.sql`SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS "nowMs"`,
    );
    const now = Number(clock.nowMs);
    if (!Number.isSafeInteger(now)) throw unavailable();
    return now;
  }
  private content(
    version: { content: unknown; digest: string },
    tenantId: string,
  ) {
    const content = validateSmsPolicy(
      version.content,
      this.authority.allowedUrls(tenantId),
    );
    if (smsPolicyDigest(content) !== version.digest) throw unavailable();
    return content;
  }
  private publication(
    reference: string | null,
    version: { id: string; tenantId: string; digest: string },
    now: number,
  ) {
    const evidence = reference
      ? this.authority.publication(reference)
      : undefined;
    if (
      !evidence ||
      evidence.fixtureOnly !== true ||
      evidence.reference !== reference ||
      evidence.tenantId !== version.tenantId ||
      evidence.versionId !== version.id ||
      evidence.digest !== version.digest ||
      !Number.isSafeInteger(evidence.expiresAt) ||
      evidence.expiresAt <= now
    )
      throw unavailable();
  }
  private audit(
    tx: Prisma.TransactionClient,
    ctx: { tenantId: string; actorId: string },
    versionId: string,
    revision: number,
    state: string,
    evidenceRef: string,
  ) {
    return tx.auditLog.create({
      data: {
        tenantId: ctx.tenantId,
        actorId: ctx.actorId,
        actorType: "USER",
        entityType: "TenantSmsPolicyVersion",
        entityId: versionId,
        action: "sms.policy_transition",
        metadata: { revision, state, evidenceRef, ...flags },
      },
    });
  }
  private async run<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.prisma.$transaction(fn, {
        maxWait: 2000,
        timeout: 5000,
      });
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() < 500)
        throw error;
      throw new ServiceUnavailableException(
        "SMS policy outcome unconfirmed. Reload the current revision before retrying.",
      );
    }
  }
}
