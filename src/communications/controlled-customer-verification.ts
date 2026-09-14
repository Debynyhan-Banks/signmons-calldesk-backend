import {
  BadRequestException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { DurableVerificationService } from "./durable-verification.service";

type Resources = {
  durable: Pick<DurableVerificationService, "execute">;
  noticeVersion: string;
  /** Must check current server activation/tenant/policy before each request. */
  authorize: (sessionToken: string) => Promise<void>;
};
const uuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    v,
  );
const unavailable = () =>
  new ServiceUnavailableException("Verification unavailable.");

/** Server-owned optional boundary. No provider creation, activation or proof issuance. */
export class ControlledCustomerVerification {
  constructor(private readonly resources?: Resources) {
    this.resources = resources ? Object.freeze({ ...resources }) : undefined;
  }

  async handle(value: Record<string, unknown>) {
    const p = this.resources;
    if (
      !p ||
      typeof p.authorize !== "function" ||
      typeof p.noticeVersion !== "string" ||
      !p.noticeVersion ||
      p.noticeVersion.length > 200
    )
      throw unavailable();
    if (
      !value ||
      Object.keys(value).sort().join() !==
        "action,code,noticeVersion,operationId,phone,requested,sessionToken,startOperationId" ||
      !["START", "CHECK"].includes(value.action as string) ||
      !uuid(value.operationId) ||
      typeof value.sessionToken !== "string" ||
      !value.sessionToken ||
      value.sessionToken.length > 4096 ||
      typeof value.phone !== "string" ||
      !/^\+1[2-9]\d{9}$/.test(value.phone) ||
      value.requested !== true ||
      value.noticeVersion !== p.noticeVersion ||
      (value.action === "START"
        ? value.code !== "" || value.startOperationId !== ""
        : typeof value.code !== "string" ||
          !/^\d{6}$/.test(value.code) ||
          !uuid(value.startOperationId))
    )
      throw new BadRequestException("Invalid verification request.");
    const input = { ...value };
    await p.authorize(input.sessionToken as string);
    const receipt = await p.durable.execute(
      {
        kind: input.action,
        operationId: input.operationId,
        phone: input.phone,
        sessionToken: input.sessionToken,
        code: input.code,
        startOperationId: input.startOperationId,
      },
      { requested: true, noticeVersion: p.noticeVersion },
    );
    if (
      receipt.operationId !== input.operationId ||
      !["OBSERVED", "UNCONFIRMED"].includes(receipt.state) ||
      ![
        "PENDING",
        "APPROVED",
        "REFUSED",
        "RATE_LIMITED",
        "UNKNOWN",
        "EXPIRED",
        "UNAVAILABLE",
      ].includes(receipt.outcome) ||
      (input.action === "START" && receipt.outcome === "APPROVED") ||
      (receipt.state === "UNCONFIRMED" && receipt.outcome !== "UNKNOWN") ||
      receipt.phoneAccessAuthorized !== false ||
      receipt.bookingAuthorized !== false ||
      receipt.deliveryAuthorized !== false
    )
      throw unavailable();
    return {
      operationId: receipt.operationId,
      state: receipt.state,
      outcome: receipt.outcome,
      phoneAccessAuthorized: false,
      bookingAuthorized: false,
      deliveryAuthorized: false,
    };
  }
}
