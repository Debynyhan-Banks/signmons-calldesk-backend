import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  HttpException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { getRequestContext } from "../common/context/request-context";
import { PrismaService } from "../prisma/prisma.service";
import {
  ORGANIZATION_PROFILE,
  draft,
  exact,
  object,
  profile,
  preview,
  timestamp,
  type OrganizationProfile,
} from "./organization-profile";

@Injectable()
export class OrganizationProfileService {
  constructor(private readonly prisma: PrismaService) {}
  private context() {
    const ctx = getRequestContext();
    if (
      !ctx?.userId?.trim() ||
      !ctx.tenantId ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        ctx.tenantId,
      ) ||
      !["owner", "admin"].includes(ctx.role?.trim().toLowerCase() ?? "") ||
      ctx.impersonatedTenantId
    )
      throw new ForbiddenException(
        "Organization setup requires owner/admin access without impersonation.",
      );
    return { tenantId: ctx.tenantId, actorId: ctx.userId };
  }
  private async tenant(
    db: Pick<PrismaService, "tenantOrganization">,
    tenantId: string,
  ) {
    const row = await db.tenantOrganization.findFirst({
      where: { id: tenantId, status: "ACTIVE" },
      select: { settings: true, updatedAt: true },
    });
    if (!row) throw new NotFoundException("Organization unavailable.");
    if (!object(row.settings))
      throw new ConflictException(
        "Organization settings require administrator review.",
      );
    return row;
  }
  async read() {
    const ctx = this.context();
    try {
      const row = await this.tenant(this.prisma, ctx.tenantId);
      return {
        updatedAt: row.updatedAt.toISOString(),
        profile: profile(object(row.settings)![ORGANIZATION_PROFILE]),
        runtimeConnected: false,
      };
    } catch (error) {
      return this.failure(error);
    }
  }
  async write(input: unknown, approving = false) {
    const ctx = this.context();
    if (
      !exact(
        input,
        approving
          ? ["expectedUpdatedAt", "acknowledged"]
          : ["expectedUpdatedAt", "draft"],
      )
    )
      throw new BadRequestException(
        "Exact reviewed version and fields required.",
      );
    const body = object(input)!;
    if (
      !timestamp(body.expectedUpdatedAt) ||
      (approving && body.acknowledged !== true)
    )
      throw new BadRequestException(
        "Review and acknowledge the current saved version.",
      );
    const nextDraft = approving ? null : draft(body.draft);
    const expected = new Date(body.expectedUpdatedAt);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const row = await this.tenant(
          tx as Pick<PrismaService, "tenantOrganization">,
          ctx.tenantId,
        );
        if (row.updatedAt.getTime() !== expected.getTime())
          throw new ConflictException(
            "Organization changed. Reload before writing.",
          );
        const root = object(row.settings)!;
        const old = profile(root[ORGANIZATION_PROFILE]);
        if (approving && !old)
          throw new ConflictException("Save a draft before approval.");
        const updatedAt = new Date(
          Math.max(Date.now(), expected.getTime() + 1),
        );
        const next: OrganizationProfile = {
          version: 1,
          draft: nextDraft ?? old!.draft,
          approved: approving
            ? {
                draft: old!.draft,
                actorId: ctx.actorId,
                approvedAt: updatedAt.toISOString(),
              }
            : (old?.approved ?? null),
        };
        const settings = {
          ...root,
          [ORGANIZATION_PROFILE]: next,
        } as unknown as Prisma.JsonObject;
        const result = await tx.tenantOrganization.updateMany({
          where: { id: ctx.tenantId, status: "ACTIVE", updatedAt: expected },
          data: { settings, updatedAt },
        });
        if (result.count !== 1)
          throw new ConflictException(
            "Organization changed. Reload before writing.",
          );
        await tx.auditLog.create({
          data: {
            tenantId: ctx.tenantId,
            actorType: "USER",
            actorId: ctx.actorId,
            entityType: "TenantOrganization",
            entityId: ctx.tenantId,
            action: approving
              ? "organization.profile_approved"
              : "organization.profile_draft_saved",
            metadata: {
              version: 1,
              expectedUpdatedAt: expected.toISOString(),
              updatedAt: updatedAt.toISOString(),
            },
          },
        });
        return {
          updatedAt: updatedAt.toISOString(),
          profile: next,
          runtimeConnected: false,
        };
      });
    } catch (error) {
      return this.failure(error);
    }
  }
  async answer(input: unknown) {
    if (!exact(input, ["expectedUpdatedAt", "question"]))
      throw new BadRequestException("Exact preview fields required.");
    const body = object(input)!;
    const current = await this.read();
    if (body.expectedUpdatedAt !== current.updatedAt)
      throw new ConflictException(
        "Organization changed. Reload before preview.",
      );
    if (!current.profile?.approved)
      throw new ConflictException("Approve a saved draft before preview.");
    return preview(current.profile.approved, body.question);
  }
  private failure(error: unknown): never {
    if (error instanceof HttpException) throw error;
    throw new ServiceUnavailableException(
      "Organization outcome unconfirmed. Reload before another write.",
    );
  }
}
