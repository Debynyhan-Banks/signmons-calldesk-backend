import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import twilio from "twilio";
import RequestClient from "twilio/lib/base/RequestClient";
import {
  TwilioVerifyAdapter,
  VERIFY_CLIENT_OPTIONS,
} from "./twilio-verify.adapter";

describe("inactive Twilio Verify adapter", () => {
  it("uses the installed SDK with a network-free HTTP client and correct form mapping", async () => {
    const httpClient = new RequestClient(VERIFY_CLIENT_OPTIONS);
    httpClient.request = jest.fn().mockResolvedValue({
      statusCode: 200,
      body: JSON.stringify({
        sid: check.verificationSid,
        account_sid: binding.accountSid,
        service_sid: binding.serviceSid,
        to: request.phone,
        channel: "sms",
        status: "approved",
      }),
      headers: {},
    });
    const adapter = new TwilioVerifyAdapter(binding, (options) =>
      twilio(binding.accountSid, "fictional-not-a-secret", {
        ...options,
        httpClient,
      }),
    );
    expect((await adapter.check(check)).outcome).toBe("APPROVED");
    expect(httpClient.autoRetry).toBe(false);
    // Installed SDK defaults a zero count to 3; autoRetry:false is the effective guard.
    expect(httpClient.maxRetries).toBe(3);
    expect(httpClient.request).toHaveBeenCalledTimes(1);
    expect(httpClient.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "post",
        uri:
          "https://verify.twilio.com/v2/Services/" +
          binding.serviceSid +
          "/VerificationCheck",
        data: { VerificationSid: check.verificationSid, Code: "123456" },
      }),
    );
  });
  const binding = {
    tenantId: randomUUID(),
    accountSid: "AC" + "a".repeat(32),
    serviceSid: "VA" + "b".repeat(32),
  };
  const request = {
    tenantId: binding.tenantId,
    operationId: randomUUID(),
    phone: "+12025550123",
  };
  const check = {
    ...request,
    verificationSid: "VE" + "c".repeat(32),
    code: "123456",
  };
  const response = (status = "pending") => ({
    sid: check.verificationSid,
    accountSid: binding.accountSid,
    serviceSid: binding.serviceSid,
    to: request.phone,
    channel: "sms",
    status,
    valid: true,
    privatePayload: "do not expose",
  });
  const setup = () => {
    const start = jest.fn().mockResolvedValue(response());
    const verify = jest.fn().mockResolvedValue(response("approved"));
    const services = jest.fn().mockReturnValue({
      verifications: { create: start },
      verificationChecks: { create: verify },
    });
    const factory = jest.fn().mockReturnValue({ verify: { v2: { services } } });
    return {
      start,
      verify,
      services,
      factory,
      adapter: new TwilioVerifyAdapter(binding, factory),
    };
  };
  it("maps SMS start exactly, with fraud checks enabled and explicit retry/timeout options", async () => {
    const { adapter, start, services, factory } = setup();
    const value = await adapter.start(request);
    expect(factory).toHaveBeenCalledWith(VERIFY_CLIENT_OPTIONS);
    expect(VERIFY_CLIENT_OPTIONS).toEqual({
      autoRetry: false,
      maxRetries: 0,
      timeout: 8000,
      logLevel: "error",
    });
    expect(services).toHaveBeenCalledWith(binding.serviceSid);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith({
      to: request.phone,
      channel: "sms",
      riskCheck: "enable",
    });
    expect(value).toMatchObject({
      outcome: "PENDING",
      verificationSid: check.verificationSid,
      usage: { operation: "START", sdkInvocations: 1, billing: "UNRECONCILED" },
    });
  });
  it("checks the stored SID rather than phone and keeps approval separate from authority", async () => {
    const { adapter, verify } = setup();
    const value = await adapter.check(check);
    expect(verify).toHaveBeenCalledWith({
      verificationSid: check.verificationSid,
      code: "123456",
    });
    expect(value).toEqual({
      operationId: request.operationId,
      outcome: "APPROVED",
      verificationSid: check.verificationSid,
      usage: { operation: "CHECK", sdkInvocations: 1, billing: "UNRECONCILED" },
      phoneAccessAuthorized: false,
      bookingAuthorized: false,
      deliveryAuthorized: false,
    });
    expect(JSON.stringify(value)).not.toContain(request.phone);
    expect(JSON.stringify(value)).not.toContain("123456");
    expect(JSON.stringify(value)).not.toContain("privatePayload");
  });
  it.each([
    "pending",
    "expired",
    "failed",
    "canceled",
    "max_attempts_reached",
    "deleted",
    "unknown",
  ])("classifies %s without using legacy valid", async (status) => {
    const { adapter, verify } = setup();
    verify.mockResolvedValue(response(status));
    const outcomes: Record<string, string> = {
      pending: "PENDING",
      expired: "EXPIRED",
      failed: "REFUSED",
      canceled: "REFUSED",
      max_attempts_reached: "REFUSED",
    };
    expect((await adapter.check(check)).outcome).toBe(
      outcomes[status] ?? "UNKNOWN",
    );
  });
  it("does not accept approval from a start response", async () => {
    const { adapter, start } = setup();
    start.mockResolvedValue(response("approved"));
    expect((await adapter.start(request)).outcome).toBe("UNKNOWN");
  });
  it.each([
    { sid: "VE" + "d".repeat(32) },
    { sid: "bad" },
    { accountSid: "AC" + "d".repeat(32) },
    { serviceSid: "VA" + "d".repeat(32) },
    { to: "+12025550124" },
    { channel: "call" },
    { status: undefined },
  ])("refuses mismatched or malformed check result %j", async (patch) => {
    const { adapter, verify } = setup();
    verify.mockResolvedValue({ ...response("approved"), ...patch });
    expect((await adapter.check(check)).outcome).toBe("UNKNOWN");
    expect(verify).toHaveBeenCalledTimes(1);
  });
  it.each([null, [], true, "approved", {}])(
    "refuses invalid response %j",
    async (value) => {
      const { adapter, start } = setup();
      start.mockResolvedValue(value);
      expect((await adapter.start(request)).outcome).toBe("UNKNOWN");
    },
  );
  it.each([404, 429, 500, 503, 400, 401, 403, 422, undefined])(
    "sanitizes provider error %s without retry or assuming zero cost",
    async (status) => {
      const { adapter, start } = setup();
      start.mockRejectedValue({
        status,
        message: "secret 123456 " + request.phone,
        request: { code: "123456" },
      });
      const value = await adapter.start(request);
      expect(value.outcome).toBe(
        status === 429
          ? "RATE_LIMITED"
          : [400, 401, 403, 422].includes(status ?? 0)
            ? "REFUSED"
            : "UNKNOWN",
      );
      expect(start).toHaveBeenCalledTimes(1);
      expect(value.usage.billing).toBe("UNRECONCILED");
      expect(JSON.stringify(value)).not.toMatch(/secret|123456|202555/);
    },
  );
  it("missing config/client and factory faults never invoke a provider", async () => {
    const { factory, start } = setup();
    expect((await new TwilioVerifyAdapter().start(request)).outcome).toBe(
      "UNAVAILABLE",
    );
    expect(
      (
        await new TwilioVerifyAdapter(
          { ...binding, serviceSid: "bad" },
          factory,
        ).start(request)
      ).usage.sdkInvocations,
    ).toBe(0);
    expect(
      (
        await new TwilioVerifyAdapter(binding, () => {
          throw Error("secret");
        }).start(request)
      ).usage.billing,
    ).toBe("NOT_ATTEMPTED");
    expect(start).not.toHaveBeenCalled();
  });
  it("refuses a foreign tenant before client construction", async () => {
    const { adapter, factory } = setup();
    expect(
      (await adapter.start({ ...request, tenantId: randomUUID() })).outcome,
    ).toBe("REFUSED");
    expect(factory).not.toHaveBeenCalled();
  });
  it.each([
    { phone: "2025550123" },
    { operationId: "bad" },
    { tenantId: "bad" },
    { extra: true },
    { code: "12345" },
    { verificationSid: "VA" + "a".repeat(32) },
  ])("rejects invalid input %j without invocation", async (patch) => {
    const { adapter, factory } = setup();
    await expect(adapter.check({ ...check, ...patch })).rejects.toThrow(
      "Invalid verification request.",
    );
    expect(factory).not.toHaveBeenCalled();
  });
  it("copies server binding and does not silently own idempotency", async () => {
    const { factory, start } = setup();
    const config = { ...binding };
    const adapter = new TwilioVerifyAdapter(config, factory);
    config.serviceSid = "VA" + "d".repeat(32);
    expect((await adapter.start(request)).outcome).toBe("PENDING");
    await adapter.start(request);
    expect(start).toHaveBeenCalledTimes(2); // durable caller must deduplicate before invocation
  });
  it("has no production module registration or secret/environment loader", () => {
    for (const file of [
      "src/app.module.ts",
      "src/communications/communications.module.ts",
    ]) {
      expect(readFileSync(join(process.cwd(), file), "utf8")).not.toContain(
        "TwilioVerifyAdapter",
      );
    }
    const source = readFileSync(
      join(process.cwd(), "src/communications/twilio-verify.adapter.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/process\.env|console\.|@Injectable|fetch\(/);
  });
});
