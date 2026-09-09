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
import {
  CUSTOMER_SMS_KEYS,
  CUSTOMER_SMS_POLICY,
  customerSmsPolicy,
  record,
  validCustomerSmsEvents,
} from "./customer-messaging-policy";
import { TransactionalMessageTemplateService } from "./transactional-message-template.service";

const select = {
  id: true,
  name: true,
  timezone: true,
  settings: true,
  updatedAt: true,
} satisfies Prisma.TenantOrganizationSelect;
type Tenant = Prisma.TenantOrganizationGetPayload<{ select: typeof select }>;

@Injectable()
export class CustomerMessagingSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly templates: TransactionalMessageTemplateService,
  ) {}
  private context() {
    const ctx = getRequestContext();
    if (
      !ctx?.tenantId ||
      !ctx.userId ||
      !["owner", "admin"].includes(ctx.role?.trim().toLowerCase() ?? "")
    )
      throw new ForbiddenException(
        "Messaging settings require owner or admin access.",
      );
    return { tenantId: ctx.tenantId, actorId: ctx.userId };
  }
  private snapshot(tenant: Tenant) {
    const policy = customerSmsPolicy(tenant.settings);
    return {
      updatedAt: tenant.updatedAt.toISOString(),
      source: policy.source,
      templates: CUSTOMER_SMS_KEYS.map((key) => ({
        key,
        enabled: policy.events[key],
        ...this.templates.render(key, {
          contractorName: tenant.name,
          timeZone: tenant.timezone,
          appointmentTime: new Date("2039-01-15T15:00:00.000Z"),
          technicianName: "Example technician",
        }),
      })),
    };
  }
  async read() {
    const ctx = this.context();
    const tenant = await this.prisma.tenantOrganization.findUnique({
      where: { id: ctx.tenantId },
      select,
    });
    if (!tenant) throw new NotFoundException("Tenant not found.");
    return this.snapshot(tenant);
  }
  async save(input: { expectedUpdatedAt: string; events: unknown }) {
    const ctx = this.context();
    const date = new Date(input.expectedUpdatedAt);
    if (
      !Number.isFinite(date.getTime()) ||
      date.toISOString() !== input.expectedUpdatedAt ||
      !validCustomerSmsEvents(input.events)
    )
      throw new BadRequestException(
        "Save requires the reviewed version and all four boolean preferences.",
      );
    const events = { ...input.events };
    try {
      return await this.prisma.$transaction(async (tx) => {
        const tenant = await tx.tenantOrganization.findUnique({
          where: { id: ctx.tenantId },
          select,
        });
        if (!tenant) throw new NotFoundException("Tenant not found.");
        const root = record(tenant.settings);
        if (!root)
          throw new ConflictException(
            "Tenant settings need administrator review.",
          );
        if (tenant.updatedAt.getTime() !== date.getTime())
          throw new ConflictException(
            "Settings changed. Reload before saving.",
          );
        const updatedAt = new Date(Math.max(Date.now(), date.getTime() + 1));
        const settings = {
          ...root,
          [CUSTOMER_SMS_POLICY]: { version: 1, events },
        } as Prisma.JsonObject;
        // Validate branding/timezone before any write as well as transaction commit.
        const result = this.snapshot({ ...tenant, settings, updatedAt });
        const change = await tx.tenantOrganization.updateMany({
          where: { id: ctx.tenantId, updatedAt: date },
          data: { settings, updatedAt },
        });
        if (change.count !== 1)
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
            action: "communication.customer_sms_preferences_updated",
            metadata: {
              version: 1,
              events,
              expectedUpdatedAt: input.expectedUpdatedAt,
              updatedAt: updatedAt.toISOString(),
            },
          },
        });
        return result;
      });
    } catch (error) {
      if (
        error instanceof BadRequestException ||
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
