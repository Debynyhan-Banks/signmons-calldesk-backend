import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { AuditActorType } from "@prisma/client";
import { getRequestContext } from "../common/context/request-context";
import { PrismaService } from "../prisma/prisma.service";
import { CalendarCreateReconciliationService } from "./calendar-create-reconciliation.service";

/** Inactive, explicitly reviewed APPLIED CREATE read-back only.
 * Future callers require RequestAuthGuard/TenantGuard. No Calendar writer,
 * customer takeover, automatic retry, UNCERTAIN grace bypass or module wiring.
 */
@Injectable()
export class CalendarAppliedRecoveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reconciliation: CalendarCreateReconciliationService,
  ) {}

  async recover(input: {
    operationId: string;
    expectedUpdatedAt: string;
    acknowledgeReadback: boolean;
  }) {
    const context = getRequestContext();
    if (!context?.userId?.trim() || !context.tenantId?.trim())
      throw new UnauthorizedException("Verified review identity is required.");
    if (!["owner", "admin"].includes(context.role?.trim().toLowerCase() ?? ""))
      throw new ForbiddenException(
        "Calendar recovery requires an owner or admin role.",
      );
    const expected = new Date(input.expectedUpdatedAt);
    if (
      input.acknowledgeReadback !== true ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        input.operationId,
      ) ||
      !Number.isFinite(expected.getTime()) ||
      expected.toISOString() !== input.expectedUpdatedAt
    )
      throw new BadRequestException(
        "Recovery requires acknowledgment and the current operation timestamp.",
      );

    const { tenantId, userId } = context;
    let admittedAt: Date;
    try {
      admittedAt = await this.prisma.$transaction(async (tx) => {
        const operation = await tx.calendarOperation.findUnique({
          where: { id_tenantId: { id: input.operationId, tenantId } },
        });
        if (!operation)
          throw new NotFoundException("Calendar operation was not found.");
        if (
          operation.action !== "CREATE" ||
          operation.status !== "APPLIED" ||
          operation.finishedAt !== null ||
          operation.updatedAt.getTime() !== expected.getTime()
        )
          throw this.changed();
        const version = new Date(Math.max(Date.now(), expected.getTime() + 1));
        const claimed = await tx.calendarOperation.updateMany({
          where: {
            id: operation.id,
            tenantId,
            action: "CREATE",
            status: "APPLIED",
            finishedAt: null,
            updatedAt: expected,
          },
          data: { updatedAt: version },
        });
        if (claimed.count !== 1) throw this.changed();
        await tx.auditLog.create({
          data: {
            tenantId,
            actorType: AuditActorType.USER,
            actorId: userId,
            action: "appointment.applied_create_readback_requested",
            entityType: "CalendarOperation",
            entityId: operation.id,
            metadata: {
              jobId: operation.jobId,
              reasonCode: "APPLIED_CREATE_REVIEWED",
              acknowledged: true,
              reviewedUpdatedAt: input.expectedUpdatedAt,
              admittedUpdatedAt: version.toISOString(),
            },
          },
        });
        return version;
      });
    } catch (error) {
      if (
        error instanceof ConflictException ||
        error instanceof NotFoundException
      )
        throw error;
      // No read-back after unknown admission acknowledgment, and no retry.
      throw this.uncertain();
    }
    try {
      // The exact acknowledged version, never a caller-supplied target/evidence.
      const result = await this.reconciliation.reconcile({
        tenantId,
        operationId: input.operationId,
        expectedUpdatedAt: admittedAt,
      });
      if (
        !["finalized", "already_finalized", "pending", "needs_review"].includes(
          result?.status,
        )
      )
        throw this.uncertain();
      // Internal/historical processing result only, NOT a public booking receipt.
      return { status: result.status };
    } catch {
      // Admission audit is durable. Unknown execution must be refreshed, not
      // compensated/replayed; a newer version/review decision always wins.
      throw this.uncertain();
    }
  }

  private changed() {
    return new ConflictException(
      "Calendar work changed or is not an APPLIED CREATE. Refresh review state.",
    );
  }
  private uncertain() {
    return new ServiceUnavailableException(
      "Calendar recovery outcome is uncertain. Refresh review state before taking further action.",
    );
  }
}
