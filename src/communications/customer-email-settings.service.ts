import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { getRequestContext } from "../common/context/request-context";
import { PrismaService } from "../prisma/prisma.service";
import { record } from "./customer-messaging-policy";
import {
  CUSTOMER_EMAIL_POLICY,
  customerEmailPolicy,
  validCustomerEmailEvents,
} from "./customer-email-policy";

const select = {
  settings: true,
  updatedAt: true,
} satisfies Prisma.TenantOrganizationSelect;
type Tenant = Prisma.TenantOrganizationGetPayload<{ select: typeof select }>;
@Injectable()
export class CustomerEmailSettingsService {
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
        "Email preferences require owner or admin tenant access without impersonation.",
      );
    return { tenantId: ctx.tenantId, actorId: ctx.userId };
  }
  private snapshot(tenant: Tenant) {
    return {
      updatedAt: tenant.updatedAt.toISOString(),
      ...customerEmailPolicy(tenant.settings),
      recipientRole: "customer" as const,
      deliveryAvailable: false as const,
    };
  }
  async read() {
    const ctx = this.context();
    try {
      const tenant = await this.prisma.tenantOrganization.findFirst({
        where: { id: ctx.tenantId, status: "ACTIVE" },
        select,
      });
      if (!tenant)
        throw new NotFoundException(
          "Email preferences are unavailable for this tenant.",
        );
      return this.snapshot(tenant);
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      throw new ServiceUnavailableException(
        "Email preferences are unavailable. Reload to try again.",
      );
    }
  }
  async save(input: { expectedUpdatedAt: string; events: unknown }) {
    const ctx = this.context();
    if (
      !input ||
      typeof input.expectedUpdatedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
        input.expectedUpdatedAt,
      ) ||
      !Number.isFinite(Date.parse(input.expectedUpdatedAt)) ||
      new Date(input.expectedUpdatedAt).toISOString() !==
        input.expectedUpdatedAt ||
      !validCustomerEmailEvents(input.events)
    )
      throw new BadRequestException(
        "Save requires the reviewed version and all three boolean email preferences.",
      );
    const expectedUpdatedAt = input.expectedUpdatedAt;
    const date = new Date(expectedUpdatedAt),
      events = { ...input.events };
    try {
      return await this.prisma.$transaction(async (tx) => {
        const tenant = await tx.tenantOrganization.findFirst({
          where: { id: ctx.tenantId, status: "ACTIVE" },
          select,
        });
        if (!tenant)
          throw new NotFoundException(
            "Email preferences are unavailable for this tenant.",
          );
        const root = record(tenant.settings);
        if (!root || customerEmailPolicy(root).source === "invalid")
          throw new ConflictException(
            "Stored email preferences need administrator review.",
          );
        if (tenant.updatedAt.getTime() !== date.getTime())
          throw new ConflictException(
            "Settings changed. Reload before saving.",
          );
        const updatedAt = new Date(Math.max(Date.now(), date.getTime() + 1));
        const settings = {
          ...root,
          [CUSTOMER_EMAIL_POLICY]: { version: 1, events },
        } as Prisma.JsonObject;
        const result = await tx.tenantOrganization.updateMany({
          where: { id: ctx.tenantId, status: "ACTIVE", updatedAt: date },
          data: { settings, updatedAt },
        });
        if (result.count !== 1)
          throw new ConflictException(
            "Settings changed. Reload before saving.",
          );
        await tx.auditLog.create({
          data: {
            tenantId: ctx.tenantId,
            actorType: "USER",
            actorId: ctx.actorId,
            entityType: "TenantOrganization",
            entityId: ctx.tenantId,
            action: "communication.customer_email_preferences_updated",
            metadata: {
              version: 1,
              events,
              expectedUpdatedAt,
              updatedAt: updatedAt.toISOString(),
            },
          },
        });
        return this.snapshot({ settings, updatedAt });
      });
    } catch (error) {
      if (
        error instanceof ConflictException ||
        error instanceof NotFoundException
      )
        throw error;
      throw new ServiceUnavailableException(
        "Save outcome is unconfirmed. Reload settings before any further save.",
      );
    }
  }
}
