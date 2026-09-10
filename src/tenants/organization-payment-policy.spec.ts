import {
  draft,
  profile,
  ORGANIZATION_PAYMENT_POLICY,
} from "./organization-payment-policy";
import { OrganizationPaymentPolicyService } from "./organization-payment-policy.service";
import { JobPaymentPolicyService } from "../jobs/job-payment-policy.service";
import { getRequestContext } from "../common/context/request-context";
import { PrismaService } from "../prisma/prisma.service";
import { readFileSync } from "node:fs";
jest.mock("../common/context/request-context", () => ({
  getRequestContext: jest.fn(),
}));
describe("local approved payment policies", () => {
  const tenantId = "11111111-1111-4111-8111-111111111111",
    jobId = "22222222-2222-4222-8222-222222222222";
  const facts = {
    currency: "usd",
    serviceFeeRequired: true,
    serviceFeeCents: 7500,
    depositRequired: false,
    depositPolicy: { kind: "none" },
    emergencyFeePolicy: { kind: "none" },
    paymentGateMode: "fail_closed",
    webhookValidationRequired: true,
  };
  const context = jest.mocked(getRequestContext);
  beforeEach(() =>
    context.mockReturnValue({ tenantId, userId: "owner", role: "owner" }),
  );
  it("validates fixed fees and deposits, including explicitly no payment", () => {
    expect(draft(facts)).toEqual(facts);
    expect(
      draft({
        ...facts,
        depositRequired: true,
        depositPolicy: { kind: "fixed", amountCents: 10000 },
      }).depositRequired,
    ).toBe(true);
    expect(
      draft({ ...facts, serviceFeeRequired: false, serviceFeeCents: null })
        .serviceFeeRequired,
    ).toBe(false);
  });
  it.each([
    { currency: "eur" },
    { serviceFeeCents: -1 },
    { serviceFeeCents: 0 },
    { serviceFeeCents: 1.5 },
    { serviceFeeCents: 100000001 },
    { serviceFeeRequired: false },
    { paymentGateMode: "manual_override" },
    { webhookValidationRequired: false },
    { extra: true },
    { depositRequired: true },
  ])("rejects unsupported policy %j", (change) =>
    expect(() => draft({ ...facts, ...change })).toThrow(),
  );
  it("refuses corrupt stored policy rather than resetting it", () => {
    expect(profile(undefined)).toBeNull();
    expect(() => profile(null)).toThrow();
    expect(() =>
      profile({ version: 2, draft: facts, approved: null }),
    ).toThrow();
  });
  function harness() {
    let row = {
      settings: { keep: true } as Record<string, unknown>,
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    const db = {
      tenantOrganization: {
        findFirst: jest.fn().mockImplementation(() => Promise.resolve(row)),
        updateMany: jest
          .fn()
          .mockImplementation(({ data }: { data: typeof row }) => {
            row = data;
            return Promise.resolve({ count: 1 });
          }),
      },
      auditLog: { create: jest.fn() },
      $transaction: jest.fn(),
    };
    db.$transaction.mockImplementation(
      async (fn: (tx: typeof db) => Promise<unknown>) => {
        const previous = structuredClone(row);
        try {
          return await fn(db);
        } catch (e) {
          row = previous;
          throw e;
        }
      },
    );
    return {
      db,
      service: new OrganizationPaymentPolicyService(
        db as unknown as PrismaService,
      ),
      row: () => row,
    };
  }
  it("saves, explicitly approves, preserves other settings and separates later drafts", async () => {
    const h = harness();
    const saved = await h.service.write({
      expectedUpdatedAt: h.row().updatedAt.toISOString(),
      draft: facts,
    });
    const approved = await h.service.write(
      { expectedUpdatedAt: saved.updatedAt, acknowledged: true },
      true,
    );
    await h.service.write({
      expectedUpdatedAt: approved.updatedAt,
      draft: { ...facts, serviceFeeCents: 9500 },
    });
    expect(
      (await h.service.read()).policy?.approved?.draft.serviceFeeCents,
    ).toBe(7500);
    expect(h.row().settings.keep).toBe(true);
    await expect(
      h.service.write(
        { expectedUpdatedAt: saved.updatedAt, acknowledged: true },
        true,
      ),
    ).rejects.toThrow();
  });
  it("rolls back settings on audit failure", async () => {
    const h = harness();
    h.db.auditLog.create.mockRejectedValue(Error());
    await expect(
      h.service.write({
        expectedUpdatedAt: h.row().updatedAt.toISOString(),
        draft: facts,
      }),
    ).rejects.toThrow();
    expect(h.row().settings).toEqual({ keep: true });
  });
  it.each(["dispatcher", "technician", "webchat_integration"])(
    "refuses policy mutation by %s",
    async (role) => {
      context.mockReturnValue({ tenantId, userId: "fixture", role });
      const h = harness();
      await expect(h.service.read()).rejects.toThrow();
      expect(h.db.tenantOrganization.findFirst).not.toHaveBeenCalled();
    },
  );
  it("binds once, preserves intake metadata, and replays without writes", async () => {
    const approvedAt = "2026-01-01T00:00:00.000Z";
    let job = {
      id: jobId,
      tenantId,
      status: "CREATED",
      updatedAt: new Date(approvedAt),
      policySnapshot: {
        intakeAdmission: { humanReviewed: true },
        keep: true,
      } as Record<string, unknown>,
      pricingSnapshot: {},
      payment: null,
      calendarEventId: null,
      serviceWindowStart: null,
      serviceWindowEnd: null,
    };
    const db = {
      $queryRaw: jest.fn(),
      tenantOrganization: {
        findFirst: jest.fn().mockResolvedValue({
          settings: {
            [ORGANIZATION_PAYMENT_POLICY]: {
              version: 1,
              draft: facts,
              approved: { draft: facts, actorId: "owner", approvedAt },
            },
          },
        }),
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
    db.$transaction.mockImplementation((fn: (tx: typeof db) => unknown) =>
      fn(db),
    );
    const service = new JobPaymentPolicyService(db as unknown as PrismaService);
    const input = {
      jobId,
      expectedUpdatedAt: approvedAt,
      approvedAt,
      acknowledged: true,
    };
    const first = await service.apply(input);
    expect(await service.apply(input)).toEqual(first);
    expect(db.job.updateMany).toHaveBeenCalledTimes(1);
    expect(db.auditLog.create).toHaveBeenCalledTimes(1);
    expect(job.policySnapshot.keep).toBe(true);
    expect(first.paymentInitiated).toBe(false);
    await expect(
      service.apply({ ...input, expectedUpdatedAt: first.updatedAt }),
    ).rejects.toThrow();
    context.mockReturnValue({ tenantId, userId: "another", role: "owner" });
    await expect(service.apply(input)).rejects.toThrow();
  });
  it("has no production registration", () => {
    for (const f of [
      "src/app.module.ts",
      "src/jobs/jobs.module.ts",
      "src/tenants/tenants.module.ts",
    ])
      expect(readFileSync(f, "utf8")).not.toMatch(
        /OrganizationPaymentPolicy|JobPaymentPolicy/,
      );
  });
});
