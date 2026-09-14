import { randomUUID } from "node:crypto";
import { ControlledCustomerVerification } from "./controlled-customer-verification";
import { DurableVerificationService } from "./durable-verification.service";

describe("controlled customer verification boundary", () => {
  const input = () => ({
    action: "START",
    code: "",
    noticeVersion: "notice-v1",
    operationId: randomUUID(),
    phone: "+12025550123",
    requested: true,
    sessionToken: "private-session",
    startOperationId: "",
  });
  const setup = () => {
    const request = input();
    const receipt: Record<string, unknown> = {
      operationId: request.operationId,
      attemptId: "PRIVATE",
      state: "OBSERVED",
      outcome: "PENDING",
      phoneAccessAuthorized: false,
      bookingAuthorized: false,
      deliveryAuthorized: false,
      usage: { private: "PRIVATE" },
    };
    const authorize = jest.fn().mockResolvedValue(undefined);
    const execute = jest
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          receipt as Awaited<ReturnType<DurableVerificationService["execute"]>>,
        ),
      );
    const service = new ControlledCustomerVerification({
      durable: { execute },
      noticeVersion: "notice-v1",
      authorize,
    });
    return { request, receipt, authorize, execute, service };
  };
  it("defaults closed and authorizes before durable execution; projects only safe receipt", async () => {
    const s = setup();
    await expect(
      new ControlledCustomerVerification().handle(s.request),
    ).rejects.toThrow();
    const result = await s.service.handle(s.request);
    expect(s.authorize).toHaveBeenCalledWith("private-session");
    expect(s.authorize.mock.invocationCallOrder[0]).toBeLessThan(
      s.execute.mock.invocationCallOrder[0],
    );
    expect(s.execute).toHaveBeenCalledWith(
      {
        kind: "START",
        code: "",
        operationId: s.request.operationId,
        phone: s.request.phone,
        sessionToken: "private-session",
        startOperationId: "",
      },
      { requested: true, noticeVersion: "notice-v1" },
    );
    expect(result).toEqual({
      operationId: s.request.operationId,
      state: "OBSERVED",
      outcome: "PENDING",
      phoneAccessAuthorized: false,
      bookingAuthorized: false,
      deliveryAuthorized: false,
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });
  it("maps CHECK without issuing admission authority", async () => {
    const s = setup();
    s.receipt.outcome = "APPROVED";
    const request = {
      ...s.request,
      action: "CHECK",
      code: "123456",
      startOperationId: randomUUID(),
    };
    expect(await s.service.handle(request)).toMatchObject({
      outcome: "APPROVED",
      phoneAccessAuthorized: false,
    });
    expect(s.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "CHECK",
        code: "123456",
        startOperationId: request.startOperationId,
      }),
      expect.any(Object),
    );
  });
  it.each([
    { action: "RETRY" },
    { requested: false },
    { phone: "+442012345678" },
    { noticeVersion: "stale" },
    { operationId: "bad" },
    { extra: true },
    { code: "123456" },
    { action: "CHECK", code: "12345", startOperationId: "bad" },
  ])("refuses invalid input before authority/provider %j", async (change) => {
    const s = setup();
    await expect(
      s.service.handle({ ...s.request, ...change }),
    ).rejects.toThrow();
    expect(s.authorize).not.toHaveBeenCalled();
    expect(s.execute).not.toHaveBeenCalled();
  });
  it("refuses revoked authorization without execution", async () => {
    const s = setup();
    s.authorize.mockRejectedValue(Error("revoked"));
    await expect(s.service.handle(s.request)).rejects.toThrow();
    expect(s.execute).not.toHaveBeenCalled();
  });
  it.each([
    { operationId: "foreign" },
    { outcome: "invented" },
    { outcome: "APPROVED" },
    { bookingAuthorized: true },
    { state: "UNCONFIRMED" },
  ])("refuses invalid receipt %j", async (change) => {
    const s = setup();
    Object.assign(s.receipt, change);
    await expect(s.service.handle(s.request)).rejects.toThrow();
  });
});
