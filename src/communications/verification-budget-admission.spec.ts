/* eslint-disable @typescript-eslint/require-await -- Transaction mocks. */
import { Prisma } from "@prisma/client";
import { VerificationBudgetAdmission } from "./verification-budget-admission";

describe("inactive verification consent and budget", () => {
  const scope = {
    tenantId: "tenant",
    conversationId: "conversation",
    sessionId: "session",
  };
  const policy = {
    mode: "FIXTURE_ONLY" as const,
    tenantId: "tenant",
    noticeVersion: "fixture-v1",
    noticeText:
      "Request a test verification code. Standard message and data rates may apply",
    termsUrl: "https://example.test/terms",
    privacyUrl: "https://example.test/privacy",
    rateVersion: "fictional-whole-flow-v1",
    flowUpperBoundUsdMicros: 10_000_000,
  };
  const optIn = {
    requested: true as const,
    noticeVersion: policy.noticeVersion,
  };
  let rows: { metadata: Record<string, unknown> }[],
    create: jest.Mock<
      Promise<unknown>,
      [{ data: { metadata: Record<string, unknown> } }]
    >,
    tx: Prisma.TransactionClient;
  beforeEach(() => {
    rows = [];
    create = jest.fn(async (value: unknown) => value);
    tx = {
      auditLog: { findMany: async () => rows, create },
      $queryRaw: async () => [{ now: new Date("2026-09-10T12:00:00.000Z") }],
    } as unknown as Prisma.TransactionClient;
  });
  const held = (reservedMicros: number) => ({
    metadata: { version: 1, currency: "USD", state: "HELD", reservedMicros },
  });
  it("atomically records exact request scope, notice, price version and server time", async () => {
    await new VerificationBudgetAdmission(policy).reserve(
      tx,
      scope,
      "op",
      "digest",
      optIn,
    );
    expect(create.mock.calls[0][0]).toMatchObject({
      data: {
        tenantId: "tenant",
        entityId: "conversation",
        metadata: {
          requested: true,
          sessionId: "session",
          operationId: "op",
          phoneDigest: "digest",
          noticeVersion: "fixture-v1",
          rateVersion: policy.rateVersion,
          monthUtc: "2026-09",
          reservedMicros: 10_000_000,
          ceilingMicros: 50_000_000,
          state: "HELD",
          crossedAlertMicros: [],
        },
      },
    });
  });
  it.each([
    undefined,
    { requested: false, noticeVersion: "fixture-v1" },
    { requested: true, noticeVersion: "stale" },
    { ...optIn, extra: true },
  ])("refuses missing or changed opt-in %j", async (input) => {
    await expect(
      new VerificationBudgetAdmission(policy).reserve(
        tx,
        scope,
        "op",
        "digest",
        input as typeof optIn,
      ),
    ).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  });
  it.each([
    undefined,
    { ...policy, tenantId: "foreign" },
    { ...policy, rateVersion: "" },
    { ...policy, flowUpperBoundUsdMicros: 0 },
    { ...policy, flowUpperBoundUsdMicros: -1 },
    { ...policy, flowUpperBoundUsdMicros: 1.1 },
    { ...policy, flowUpperBoundUsdMicros: Number.NaN },
    { ...policy, flowUpperBoundUsdMicros: 50_000_001 },
  ])("refuses absent or invalid trusted pricing %j", async (p) => {
    await expect(
      new VerificationBudgetAdmission(p).reserve(
        tx,
        scope,
        "op",
        "digest",
        optIn,
      ),
    ).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  });
  it("allows exactly the ceiling and records the $40 crossing", async () => {
    rows = [held(35_000_000)];
    await new VerificationBudgetAdmission({
      ...policy,
      flowUpperBoundUsdMicros: 15_000_000,
    }).reserve(tx, scope, "op", "digest", optIn);
    expect(create.mock.calls[0][0].data.metadata.crossedAlertMicros).toEqual([
      40_000_000,
    ]);
  });
  it("records both thresholds when a reservation crosses both", async () => {
    await new VerificationBudgetAdmission({
      ...policy,
      flowUpperBoundUsdMicros: 45_000_000,
    }).reserve(tx, scope, "op", "digest", optIn);
    expect(create.mock.calls[0][0].data.metadata.crossedAlertMicros).toEqual([
      25_000_000, 40_000_000,
    ]);
  });
  it("holds older-month unknown costs instead of resetting or treating them as free", async () => {
    rows = [held(45_000_000)];
    rows[0].metadata.monthUtc = "2026-08";
    await expect(
      new VerificationBudgetAdmission(policy).reserve(
        tx,
        scope,
        "op",
        "digest",
        optIn,
      ),
    ).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  });
  it("refuses corrupt cost state", async () => {
    rows = [held(-1)];
    await expect(
      new VerificationBudgetAdmission(policy).reserve(
        tx,
        scope,
        "op",
        "digest",
        optIn,
      ),
    ).rejects.toThrow();
  });
  it("snapshots trusted configuration", async () => {
    const p = { ...policy },
      service = new VerificationBudgetAdmission(p);
    p.flowUpperBoundUsdMicros = 0;
    await service.reserve(tx, scope, "op", "digest", optIn);
    expect(create.mock.calls[0][0].data.metadata.reservedMicros).toBe(
      10_000_000,
    );
  });
  it("allows checks against the original held flow without a second reservation", async () => {
    rows = [
      {
        metadata: {
          ...held(10_000_000).metadata,
          mode: "FIXTURE_ONLY",
          requested: true,
          sessionId: "session",
          phoneDigest: "digest",
        },
      },
    ];
    await new VerificationBudgetAdmission().check(tx, scope, "op", "digest");
    expect(create).not.toHaveBeenCalled();
    await expect(
      new VerificationBudgetAdmission().check(tx, scope, "op", "changed"),
    ).rejects.toThrow();
    await expect(
      new VerificationBudgetAdmission().check(
        tx,
        { ...scope, sessionId: "foreign" },
        "op",
        "digest",
      ),
    ).rejects.toThrow();
  });
  it("refuses missing or duplicate consent/budget authority", async () => {
    await expect(
      new VerificationBudgetAdmission().check(tx, scope, "op", "digest"),
    ).rejects.toThrow();
    rows = [held(1), held(1)];
    await expect(
      new VerificationBudgetAdmission().check(tx, scope, "op", "digest"),
    ).rejects.toThrow();
  });
});
