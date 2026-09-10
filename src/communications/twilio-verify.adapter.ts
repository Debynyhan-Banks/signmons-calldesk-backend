import { BadRequestException } from "@nestjs/common";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sid = (prefix: string, value: unknown): value is string =>
  typeof value === "string" &&
  new RegExp("^" + prefix + "[0-9a-fA-F]{32}$").test(value);
const phone = (value: unknown): value is string =>
  typeof value === "string" && /^\+[1-9]\d{7,14}$/.test(value);
export const VERIFY_CLIENT_OPTIONS = Object.freeze({
  // Installed SDK defaults maxRetries:0 to 3. Keep autoRetry explicitly false.
  autoRetry: false as const,
  maxRetries: 0 as const,
  timeout: 8000,
  logLevel: "error" as const,
});
export interface VerifySdkClient {
  verify: {
    v2: {
      services(serviceSid: string): {
        verifications: {
          create(input: {
            to: string;
            channel: "sms";
            riskCheck: "enable";
          }): Promise<unknown>;
        };
        verificationChecks: {
          create(input: {
            verificationSid: string;
            code: string;
          }): Promise<unknown>;
        };
      };
    };
  };
}
export type VerifyClientFactory = (
  options: typeof VERIFY_CLIENT_OPTIONS,
) => VerifySdkClient;
type Binding = { tenantId: string; accountSid: string; serviceSid: string };
type Outcome =
  | "PENDING"
  | "APPROVED"
  | "EXPIRED"
  | "REFUSED"
  | "RATE_LIMITED"
  | "UNKNOWN"
  | "UNAVAILABLE";
export type VerifyAdapterResult = {
  operationId: string;
  outcome: Outcome;
  verificationSid?: string;
  usage: {
    operation: "START" | "CHECK";
    sdkInvocations: 0 | 1;
    billing: "NOT_ATTEMPTED" | "UNRECONCILED";
  };
  phoneAccessAuthorized: false;
  bookingAuthorized: false;
  deliveryAuthorized: false;
};

/** Inactive server-internal adapter. No DI, environment/secret loader or default client.
 * Factory must honor no-retry/timeout/log options. All tests inject a network-free client.
 * A provider APPROVED result is evidence to finalize, not persisted application authority.
 * Caller must durably reserve/dedupe operations, establish OTP opt-in and budget BEFORE calls.
 */
export class TwilioVerifyAdapter {
  private readonly binding?: Readonly<Binding>;
  constructor(
    binding?: Binding,
    private readonly factory?: VerifyClientFactory,
  ) {
    if (
      binding &&
      UUID.test(binding.tenantId) &&
      sid("AC", binding.accountSid) &&
      sid("VA", binding.serviceSid)
    )
      this.binding = Object.freeze({ ...binding });
  }
  start(input: Record<string, unknown>) {
    return this.invoke("START", input);
  }
  check(input: Record<string, unknown>) {
    return this.invoke("CHECK", input);
  }

  private async invoke(
    operation: "START" | "CHECK",
    input: Record<string, unknown>,
  ): Promise<VerifyAdapterResult> {
    const keys =
      operation === "START"
        ? "operationId,phone,tenantId"
        : "code,operationId,phone,tenantId,verificationSid";
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).sort().join(",") !== keys ||
      typeof input.operationId !== "string" ||
      !UUID.test(input.operationId) ||
      typeof input.tenantId !== "string" ||
      !UUID.test(input.tenantId) ||
      !phone(input.phone) ||
      (operation === "CHECK" &&
        (!sid("VE", input.verificationSid) ||
          typeof input.code !== "string" ||
          !/^\d{6}$/.test(input.code)))
    )
      throw new BadRequestException("Invalid verification request.");
    let sdkInvocations: 0 | 1 = 0;
    const result = (
      outcome: Outcome,
      verificationSid?: string,
    ): VerifyAdapterResult => ({
      operationId: input.operationId as string,
      outcome,
      ...(verificationSid ? { verificationSid } : {}),
      usage: {
        operation,
        sdkInvocations,
        billing: sdkInvocations ? "UNRECONCILED" : "NOT_ATTEMPTED",
      },
      phoneAccessAuthorized: false,
      bookingAuthorized: false,
      deliveryAuthorized: false,
    });
    if (!this.binding || !this.factory) return result("UNAVAILABLE");
    if (input.tenantId !== this.binding.tenantId) return result("REFUSED");
    let resource: ReturnType<VerifySdkClient["verify"]["v2"]["services"]>;
    try {
      resource = this.factory(VERIFY_CLIENT_OPTIONS).verify.v2.services(
        this.binding.serviceSid,
      );
    } catch {
      return result("UNAVAILABLE");
    }
    try {
      // No retry, logging, detached promise or automatic resend in this adapter.
      sdkInvocations = 1;
      const raw =
        operation === "START"
          ? await resource.verifications.create({
              to: input.phone,
              channel: "sms",
              riskCheck: "enable",
            })
          : await resource.verificationChecks.create({
              verificationSid: input.verificationSid as string,
              code: input.code as string,
            });
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return result("UNKNOWN");
      const value = raw as Record<string, unknown>;
      if (
        !sid("VE", value.sid) ||
        value.accountSid !== this.binding.accountSid ||
        value.serviceSid !== this.binding.serviceSid ||
        value.to !== input.phone ||
        value.channel !== "sms" ||
        (operation === "CHECK" && value.sid !== input.verificationSid)
      )
        return result("UNKNOWN");
      if (value.status === "pending") return result("PENDING", value.sid);
      if (operation === "CHECK" && value.status === "approved")
        return result("APPROVED", value.sid);
      if (value.status === "expired") return result("EXPIRED", value.sid);
      if (
        ["canceled", "max_attempts_reached", "failed"].includes(
          String(value.status),
        )
      )
        return result("REFUSED", value.sid);
      return result("UNKNOWN");
    } catch (error) {
      // Never return raw provider messages, URLs, code, phone, payload or stack.
      let status: unknown;
      try {
        status =
          error && typeof error === "object"
            ? (error as { status?: unknown }).status
            : undefined;
      } catch {
        return result("UNKNOWN");
      }
      if (status === 429) return result("RATE_LIMITED");
      if (
        [400, 401, 403, 422].includes(Number(status)) &&
        typeof status === "number"
      )
        return result("REFUSED");
      // 404 could follow approval, expiry or exhaustion. Network/5xx may have committed.
      return result("UNKNOWN");
    }
  }
}
