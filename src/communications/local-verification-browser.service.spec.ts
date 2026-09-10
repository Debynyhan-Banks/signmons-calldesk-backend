import {
  LocalVerificationBrowserService,
  LOCAL_VERIFICATION_NOTICE,
} from "./local-verification-browser.service";

describe("local verification browser projection", () => {
  const execute = jest.fn();
  const service = new LocalVerificationBrowserService({ execute });
  const notice = {
    sessionToken: "fixture",
    action: "NOTICE",
    operationId: "",
    phone: "",
    code: "",
    startOperationId: "",
    requested: false,
    noticeVersion: "",
  };
  const start = {
    ...notice,
    action: "START",
    operationId: "op",
    phone: "+12025550123",
    requested: true,
    noticeVersion: LOCAL_VERIFICATION_NOTICE.noticeVersion,
  };
  beforeEach(() => {
    execute.mockReset();
    execute.mockResolvedValue({
      state: "OBSERVED",
      outcome: "PENDING",
      operationId: "op",
      phoneAccessAuthorized: false,
      bookingAuthorized: false,
      deliveryAuthorized: false,
      secret: "private",
    });
  });
  it("serves trusted fixture notice without provider execution", async () => {
    expect(await service.handle(notice)).toMatchObject({
      ...LOCAL_VERIFICATION_NOTICE,
      fixtureOnly: true,
      state: "NOTICE",
      deliveryAuthorized: false,
    });
    expect(execute).not.toHaveBeenCalled();
  });
  it("maps explicit start consent and projects no private result fields", async () => {
    expect(await service.handle(start)).toEqual({
      state: "OBSERVED",
      outcome: "PENDING",
      operationId: "op",
      fixtureOnly: true,
      phoneAccessAuthorized: false,
      bookingAuthorized: false,
      deliveryAuthorized: false,
    });
    expect(execute).toHaveBeenCalledWith(
      {
        sessionToken: "fixture",
        kind: "START",
        operationId: "op",
        phone: start.phone,
        code: "",
        startOperationId: "",
      },
      {
        requested: true,
        noticeVersion: LOCAL_VERIFICATION_NOTICE.noticeVersion,
      },
    );
  });
  it("checks only the supplied logical start reference, never a provider SID", async () => {
    await service.handle({
      ...start,
      action: "CHECK",
      code: "123456",
      startOperationId: "original",
      requested: false,
      noticeVersion: "",
    });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "CHECK", startOperationId: "original" }),
      undefined,
    );
  });
  it.each([
    { requested: false },
    { noticeVersion: "stale" },
    { extra: true },
    { action: "resend" },
    { action: "CHECK" },
  ])("refuses invalid request %j", async (patch) => {
    await expect(service.handle({ ...start, ...patch })).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });
  it("does not convert unavailable budget into success", async () => {
    execute.mockRejectedValue(Error("unavailable"));
    await expect(service.handle(start)).rejects.toThrow();
  });
  it("refuses authority-bearing or unbound upstream receipts", async () => {
    execute.mockResolvedValue({
      operationId: "op",
      state: "OBSERVED",
      outcome: "APPROVED",
      phoneAccessAuthorized: true,
      bookingAuthorized: false,
      deliveryAuthorized: false,
    });
    await expect(service.handle(start)).rejects.toThrow();
  });
});
