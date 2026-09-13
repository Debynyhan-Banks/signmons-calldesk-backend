import { PreferredWindowReviewService } from "./preferred-window-review.service";
import { getRequestContext } from "../common/context/request-context";
import { PrismaService } from "../prisma/prisma.service";
import { readFileSync } from "node:fs";
jest.mock("../common/context/request-context", () => ({
  getRequestContext: jest.fn(),
}));
describe("local preferred service window review", () => {
  const tenantId = "11111111-1111-4111-8111-111111111111",
    jobId = "22222222-2222-4222-8222-222222222222",
    expectedUpdatedAt = "2026-01-01T00:00:00.000Z";
  const input = {
    jobId,
    expectedUpdatedAt,
    preference: "Weekday afternoons; contact customer to arrange.",
    acknowledged: true,
  };
  const context = jest.mocked(getRequestContext);
  beforeEach(() =>
    context.mockReturnValue({ tenantId, userId: "owner", role: "owner" }),
  );
  function harness() {
    let job = {
      id: jobId,
      tenantId,
      status: "CREATED",
      updatedAt: new Date(expectedUpdatedAt),
      preferredTimeText: null as string | null,
      preferredWindowLabel: null,
      serviceWindowStart: null,
      serviceWindowEnd: null,
      calendarEventId: null,
      payment: null,
      pricingSnapshot: { serviceFeeAmountCents: 7500 },
      policySnapshot: {
        intakeAdmission: { humanReviewed: true },
        paymentPolicyBinding: { keep: true },
        serviceFeeRequired: true,
      } as Record<string, unknown>,
    };
    const db = {
      $queryRaw: jest.fn(),
      tenantOrganization: {
        findFirst: jest.fn().mockResolvedValue({ id: tenantId }),
      },
      job: {
        findFirst: jest.fn().mockImplementation(() => Promise.resolve(job)),
        updateMany: jest
          .fn()
          .mockImplementation(({ data }: { data: Partial<typeof job> }) => {
            job = { ...job, ...data };
            return Promise.resolve({ count: 1 });
          }),
      },
      calendarOperation: { count: jest.fn().mockResolvedValue(0) },
      auditLog: { create: jest.fn() },
      $transaction: jest.fn(),
    };
    db.$transaction.mockImplementation(
      async (fn: (tx: typeof db) => Promise<unknown>) => {
        const prior = structuredClone(job);
        try {
          return await fn(db);
        } catch (e) {
          job = prior;
          throw e;
        }
      },
    );
    return {
      db,
      job: () => job,
      service: new PreferredWindowReviewService(db as unknown as PrismaService),
    };
  }
  it("saves only preference/version/review metadata and replays exact request without writes", async () => {
    const h = harness(),
      before = structuredClone(h.job());
    const saved = await h.service.save(input);
    expect(await h.service.save(input)).toEqual(saved);
    expect(h.db.job.updateMany).toHaveBeenCalledTimes(1);
    expect(h.db.auditLog.create).toHaveBeenCalledTimes(1);
    expect(h.job().preferredTimeText).toBe(input.preference);
    expect(h.job().pricingSnapshot).toEqual(before.pricingSnapshot);
    expect(h.job().policySnapshot.paymentPolicyBinding).toEqual(
      before.policySnapshot.paymentPolicyBinding,
    );
    expect(h.job().serviceWindowStart).toBeNull();
    expect(h.job().status).toBe("CREATED");
    expect(saved).toMatchObject({
      availabilityChecked: false,
      bookingAuthorized: false,
      deliveryAuthorized: false,
    });
    expect(JSON.stringify(h.db.auditLog.create.mock.calls)).not.toContain(
      input.preference,
    );
  });
  it.each([
    "",
    "unknown",
    "not provided",
    " padded",
    "a\nb",
    "a\u200bb",
    "x".repeat(501),
  ])("refuses invalid preference %j before writes", async (preference) => {
    const h = harness();
    await expect(h.service.save({ ...input, preference })).rejects.toThrow();
    expect(h.db.$transaction).not.toHaveBeenCalled();
  });
  it.each(["customer", "technician", "webchat_integration"])(
    "refuses role %s",
    async (role) => {
      context.mockReturnValue({ tenantId, userId: "fixture", role });
      const h = harness();
      await expect(h.service.save(input)).rejects.toThrow();
      expect(h.db.$transaction).not.toHaveBeenCalled();
    },
  );
  it.each(["owner", "admin", "dispatcher"])(
    "permits reviewed preference by %s",
    async (role) => {
      context.mockReturnValue({ tenantId, userId: "fixture", role });
      expect((await harness().service.save(input)).bookingAuthorized).toBe(
        false,
      );
    },
  );
  it("requires exact fields, acknowledgment and non-impersonated context", async () => {
    const h = harness();
    for (const changed of [
      { acknowledged: false },
      { expectedUpdatedAt: "invalid" },
      { tenantId },
      { bookingAuthorized: true },
    ])
      await expect(h.service.save({ ...input, ...changed })).rejects.toThrow();
    context.mockReturnValue({
      tenantId,
      userId: "owner",
      role: "owner",
      impersonatedTenantId: tenantId,
    });
    await expect(h.service.save(input)).rejects.toThrow();
  });
  it.each([
    { status: "CONFIRMED" },
    { payment: { id: "fixture" } },
    { calendarEventId: "fixture" },
    { serviceWindowStart: new Date() },
    { serviceWindowEnd: new Date() },
    { policySnapshot: {} },
  ])("refuses advanced or unreviewed job %j", async (changed) => {
    const h = harness();
    h.db.job.findFirst.mockResolvedValue({ ...h.job(), ...changed });
    await expect(h.service.save(input)).rejects.toThrow();
    expect(h.db.job.updateMany).not.toHaveBeenCalled();
  });
  it("refuses Calendar history, missing tenant or foreign job", async () => {
    const h = harness();
    h.db.calendarOperation.count.mockResolvedValue(1);
    await expect(h.service.save(input)).rejects.toThrow();
    h.db.tenantOrganization.findFirst.mockResolvedValue(null);
    await expect(h.service.save(input)).rejects.toThrow();
    h.db.tenantOrganization.findFirst.mockResolvedValue({ id: tenantId });
    h.db.job.findFirst.mockResolvedValue(null);
    await expect(h.service.save(input)).rejects.toThrow();
  });
  it("allows a fresh-version correction but refuses stale or different-actor replay", async () => {
    const h = harness();
    const first = await h.service.save(input);
    await expect(
      h.service.save({ ...input, preference: "Friday only" }),
    ).rejects.toThrow();
    context.mockReturnValue({ tenantId, userId: "other-owner", role: "owner" });
    await expect(h.service.save(input)).rejects.toThrow();
    const second = await h.service.save({
      ...input,
      expectedUpdatedAt: first.updatedAt,
      preference: "Friday only",
    });
    expect(second.preference).toBe("Friday only");
    expect(h.db.auditLog.create).toHaveBeenCalledTimes(2);
  });
  it("rolls back audit failure and refuses a failed conditional update", async () => {
    const h = harness(),
      before = structuredClone(h.job());
    h.db.auditLog.create.mockRejectedValue(Error("fixture"));
    await expect(h.service.save(input)).rejects.toThrow();
    expect(h.job()).toEqual(before);
    h.db.job.updateMany.mockResolvedValue({ count: 0 });
    await expect(h.service.save(input)).rejects.toThrow();
  });
  it("is absent from production modules", () => {
    for (const f of ["src/app.module.ts", "src/jobs/jobs.module.ts"])
      expect(readFileSync(f, "utf8")).not.toContain("PreferredWindowReview");
  });
});
