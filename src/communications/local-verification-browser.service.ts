import {
  BadRequestException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { DurableVerificationService } from "./durable-verification.service";

export const LOCAL_VERIFICATION_NOTICE = Object.freeze({
  noticeVersion: "local-verification-v1",
  noticeText:
    "I request a test verification code for the phone number shown. No SMS is sent in this demonstration. Standard message and data rates may apply",
  termsUrl: "https://example.test/terms",
  privacyUrl: "https://example.test/privacy",
});

/** Local-only projection over the durable service; never registered in production. */
export class LocalVerificationBrowserService {
  constructor(
    private readonly durable: Pick<DurableVerificationService, "execute">,
  ) {}
  async handle(
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const {
      action,
      sessionToken,
      operationId,
      phone,
      code,
      startOperationId,
      requested,
      noticeVersion,
    } = input;
    if (
      Object.keys(input).sort().join(",") !==
      "action,code,noticeVersion,operationId,phone,requested,sessionToken,startOperationId"
    )
      throw new BadRequestException();
    const flags = {
      fixtureOnly: true,
      phoneAccessAuthorized: false,
      bookingAuthorized: false,
      deliveryAuthorized: false,
    };
    if (action === "NOTICE") {
      if (
        operationId !== "" ||
        phone !== "" ||
        code !== "" ||
        startOperationId !== "" ||
        requested !== false ||
        noticeVersion !== ""
      )
        throw new BadRequestException();
      return { ...LOCAL_VERIFICATION_NOTICE, ...flags, state: "NOTICE" };
    }
    if (action !== "START" && action !== "CHECK")
      throw new BadRequestException();
    if (
      action === "START"
        ? requested !== true ||
          noticeVersion !== LOCAL_VERIFICATION_NOTICE.noticeVersion
        : requested !== false || noticeVersion !== ""
    )
      throw new BadRequestException();
    const result = await this.durable.execute(
      {
        sessionToken,
        operationId,
        kind: action,
        phone,
        code,
        startOperationId,
      },
      action === "START"
        ? {
            requested: true,
            noticeVersion: LOCAL_VERIFICATION_NOTICE.noticeVersion,
          }
        : undefined,
    );
    if (
      result.operationId !== operationId ||
      result.phoneAccessAuthorized !== false ||
      result.bookingAuthorized !== false ||
      result.deliveryAuthorized !== false ||
      !["OBSERVED", "UNCONFIRMED"].includes(result.state) ||
      ![
        "PENDING",
        "APPROVED",
        "UNKNOWN",
        "REFUSED",
        "RATE_LIMITED",
        "EXPIRED",
        "UNAVAILABLE",
      ].includes(result.outcome)
    )
      throw new ServiceUnavailableException();
    return {
      ...flags,
      state: result.state,
      outcome: result.outcome,
      operationId: result.operationId,
    };
  }
}
