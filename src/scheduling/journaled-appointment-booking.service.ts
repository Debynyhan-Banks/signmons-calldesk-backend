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
 * Confirmation requires a fresh request-scoped receipt, never execution status alone.
 */
@Injectable()
export class JournaledAppointmentBookingService {
  constructor(
    @Inject(SchedulingService)
    private readonly admission: Pick<
      SchedulingService,
      "prepareInitialConfirmation" | "readInitialConfirmationReceipt"
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
    if (prepared.kind === "replay") {
      try {
        return await this.admission.readInitialConfirmationReceipt(input, {
          calendarEventId: prepared.response.job.calendarEventId ?? "",
          expectedUpdatedAt: prepared.response.job.updatedAt,
        });
      } catch {
        throw this.reviewRequired();
      }
    }

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
      // A historical executor receipt alone cannot authorize current customer
      // confirmation. Recheck the exact settled job and journal in a fresh read.
      if (
        result.status === "finalized" ||
        result.status === "already_finalized"
      )
        return await this.admission.readInitialConfirmationReceipt(input, {
          operationId: operation.id,
          calendarEventId: operation.calendarEventId,
        });
      throw this.reviewRequired();
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
