import {
  ConflictException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { ConfigType } from "@nestjs/config";
import appConfig from "../config/app.config";
import {
  SchedulingService,
  InitialConfirmationInput,
} from "./scheduling.service";
import { CalendarOperationJournalService } from "./calendar-operation-journal.service";
import { CalendarCreateExecutionService } from "./calendar-create-execution.service";

/** Inactive request-to-CREATE composition. NOT registered, routed or scheduled.
 * The requesting caller owns only its acknowledged new reservation/execution.
 * Existing unfinished work is office/recovery-owned: requests never resume it.
 * Results describe internal/historical processing, not a public booking receipt.
 */
@Injectable()
export class JournaledAppointmentBookingService {
  constructor(
    @Inject(SchedulingService)
    private readonly admission: Pick<
      SchedulingService,
      "prepareInitialConfirmation"
    >,
    @Inject(CalendarOperationJournalService)
    private readonly journal: Pick<CalendarOperationJournalService, "reserve">,
    @Inject(CalendarCreateExecutionService)
    private readonly executor: Pick<CalendarCreateExecutionService, "execute">,
    @Inject(appConfig.KEY)
    private readonly config: Pick<
      ConfigType<typeof appConfig>,
      "googleCalendarId" | "schedulingTimeZone"
    >,
  ) {}

  async book(input: InitialConfirmationInput) {
    // Reuse the exact signed tenant/job/session/lifecycle/eligibility/payment/
    // availability path. No caller can submit a pre-authorized job or journal ID.
    const prepared = await this.admission.prepareInitialConfirmation(input);
    if (prepared.kind === "replay")
      return { status: "already_confirmed" as const };

    let operation: Awaited<
      ReturnType<CalendarOperationJournalService["reserve"]>
    >;
    try {
      operation = await this.journal.reserve({
        tenantId: prepared.job.tenantId,
        jobId: prepared.job.id,
        expectedUpdatedAt: prepared.job.updatedAt,
        action: "CREATE",
        calendarId: this.config.googleCalendarId,
        timeZone: this.config.schedulingTimeZone,
        start: prepared.start,
        end: prepared.end,
        label: prepared.label,
      });
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      // Unknown commit may already own a durable reservation. Do not execute,
      // retry reserve, read/guess the ID, clear state or fall back to legacy.
      throw this.reviewRequired();
    }
    try {
      const result = await this.executor.execute({
        tenantId: operation.tenantId,
        operationId: operation.id,
      });
      // Only read-back finalization can report a finalized outcome. Everything
      // else retains the durable hold for separately authorized recovery/review.
      if (
        result.status === "finalized" ||
        result.status === "already_finalized"
      )
        return { status: "finalized" as const };
      if (result.status === "needs_review")
        return { status: "needs_review" as const };
      return { status: "pending" as const };
    } catch {
      throw this.reviewRequired();
    }
  }

  private reviewRequired() {
    return new ServiceUnavailableException(
      "The calendar reservation needs confirmation by the office. Please contact the office before booking again.",
    );
  }
}
