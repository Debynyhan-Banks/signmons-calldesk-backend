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

/** Inactive office-review containment only: NOT registered, routed or scheduled.
 * Call only under verified RequestAuthGuard/TenantGuard context. Never infer
 * abandonment from elapsed time; a human explicitly selects a reviewed version.
 * Holding PENDING stops its future execution without claiming provider absence.
 */
@Injectable()
export class CalendarPendingReviewService {
  constructor(private readonly prisma: PrismaService) {}

  async hold(input: {
    operationId: string;
    expectedUpdatedAt: string;
    acknowledgeHold: boolean;
  }): Promise<{ status: "needs_review" }> {
    const context = getRequestContext();
    if (!context?.userId?.trim() || !context.tenantId?.trim())
      throw new UnauthorizedException("Verified review identity is required.");
    if (!["owner", "admin"].includes(context.role?.trim().toLowerCase() ?? ""))
      throw new ForbiddenException(
        "Calendar review requires an owner or admin role.",
      );
    const expected = new Date(input.expectedUpdatedAt);
    if (
      input.acknowledgeHold !== true ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        input.operationId,
      ) ||
      !Number.isFinite(expected.getTime()) ||
      expected.toISOString() !== input.expectedUpdatedAt
    )
      throw new BadRequestException(
        "Review requires acknowledgment and the current operation timestamp.",
      );

    const { tenantId, userId } = context;
    try {
      await this.prisma.$transaction(async (tx) => {
        const operation = await tx.calendarOperation.findUnique({
          where: { id_tenantId: { id: input.operationId, tenantId } },
        });
        if (!operation)
          throw new NotFoundException("Calendar operation was not found.");
        if (
          operation.action !== "CREATE" ||
          operation.status !== "PENDING" ||
          operation.finishedAt !== null ||
          operation.updatedAt.getTime() !== expected.getTime()
        )
          throw this.changed();
        const held = await tx.calendarOperation.updateMany({
          where: {
            id: operation.id,
            tenantId,
            action: "CREATE",
            status: "PENDING",
            finishedAt: null,
            updatedAt: expected,
          },
          data: {
            status: "NEEDS_REVIEW",
            updatedAt: new Date(Math.max(Date.now(), expected.getTime() + 1)),
          },
        });
        if (held.count !== 1) throw this.changed();
        await tx.auditLog.create({
          data: {
            tenantId,
            actorType: AuditActorType.USER,
            actorId: userId,
            action: "appointment.pending_create_held",
            entityType: "CalendarOperation",
            entityId: operation.id,
            metadata: {
              jobId: operation.jobId,
              reasonCode: "PENDING_CREATE_REVIEWED",
              acknowledged: true,
              reviewedUpdatedAt: input.expectedUpdatedAt,
            },
          },
        });
      });
    } catch (error) {
      if (
        error instanceof ConflictException ||
        error instanceof NotFoundException
      )
        throw error;
      throw new ServiceUnavailableException(
        "Calendar review status is uncertain. Refresh review state before taking further action.",
      );
    }
    // No job/payment/provider writes or recovery execution. Unknown commit
    // acknowledgment is not auto-retried: refresh the persisted review state.
    return { status: "needs_review" };
  }

  private changed() {
    return new ConflictException(
      "Calendar work changed or is no longer an unattempted CREATE. Refresh review state.",
    );
  }
}
