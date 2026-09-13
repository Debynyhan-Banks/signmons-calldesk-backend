import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { BookingReadinessPreviewService } from "./booking-readiness-preview.service";
import { PrismaService } from "../prisma/prisma.service";
import {
  requestContextMiddleware,
  setAuthContext,
} from "../common/context/request-context";
describe("inactive booking readiness snapshot", () => {
  const tenantId = randomUUID(),
    jobId = randomUUID();
  const scoped = <T>(
    fn: () => Promise<T>,
    role = "owner",
    impersonated?: string,
  ) =>
    new Promise<T>((resolve, reject) =>
      requestContextMiddleware(
        { headers: {} } as Parameters<typeof requestContextMiddleware>[0],
        {} as Parameters<typeof requestContextMiddleware>[1],
        () => {
          setAuthContext(
            { tenantId, userId: "fixture-owner", role },
            impersonated,
          );
          fn().then(resolve, reject);
        },
      ),
    );
  const harness = () => {
    const job = {
      id: jobId,
      tenantId,
      status: "CREATED",
      urgency: "STANDARD",
      description: "Fictional issue",
      createdAt: new Date(),
      updatedAt: new Date(),
      customer: { tenantId, fullName: "Fictional", phone: "+12025550123" },
      propertyAddress: { tenantId, formattedAddress: "123 Fictional Lane" },
      serviceCategory: { tenantId, name: "COOLING" },
      payment: null,
      policySnapshot: {},
      preferredTimeText: null,
      serviceWindowStart: null,
      serviceWindowEnd: null,
      preferredWindowLabel: null,
    };
    const tx = {
      $executeRaw: jest.fn(),
      tenantOrganization: {
        findFirst: jest.fn().mockResolvedValue({ id: tenantId }),
      },
      job: { findFirst: jest.fn().mockResolvedValue(job) },
      calendarOperation: { count: jest.fn().mockResolvedValue(0) },
    };
    const prisma = {
      $transaction: jest
        .fn()
        .mockImplementation((fn: (value: typeof tx) => unknown) => fn(tx)),
    };
    return {
      job,
      tx,
      prisma,
      service: new BookingReadinessPreviewService(
        prisma as unknown as PrismaService,
      ),
    };
  };
  it("does not equate missing policy with no payment required", async () => {
    const { service, tx } = harness();
    const value = await scoped(() => service.read({ jobId }));
    expect(value.payment.state).toBe("UNKNOWN");
    expect(value.blockers).toEqual(
      expect.arrayContaining([
        "PAYMENT_POLICY_UNRESOLVED",
        "MISSING_preferredWindow",
        "HUMAN_REVIEW_REQUIRED",
        "CONTACT_NOT_VERIFIED",
        "ADDRESS_NOT_VERIFIED",
      ]),
    );
    expect(value.confirmation.eligible).toBe(false);
    expect(value.bookingAuthorized).toBe(false);
    expect(value.deliveryAuthorized).toBe(false);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(value)).not.toContain("123 Fictional");
  });
  it.each(["PENDING", "FAILED", "REFUNDED", "CANCELED", "SUCCEEDED"])(
    "reuses the payment decision for %s without authorizing booking",
    async (status) => {
      const { service, tx, job } = harness();
      tx.job.findFirst.mockResolvedValue({
        ...job,
        policySnapshot: { depositRequired: true, serviceFeeRequired: false },
        payment: { tenantId, status },
      });
      const value = await scoped(() => service.read({ jobId }));
      expect(value.payment.state).toBe(
        status === "SUCCEEDED" ? "UNLOCKED" : "LOCKED",
      );
      expect(value.bookingAuthorized).toBe(false);
    },
  );
  it("retains a human-owned pending Calendar blocker", async () => {
    const { service, tx } = harness();
    tx.calendarOperation.count.mockResolvedValue(1);
    expect((await scoped(() => service.read({ jobId }))).blockers).toContain(
      "CALENDAR_REVIEW_REQUIRED",
    );
  });
  it.each(["technician", "webchat_integration", "customer"])(
    "refuses %s before database access",
    async (role) => {
      const { service, prisma } = harness();
      await expect(
        scoped(() => service.read({ jobId }), role),
      ).rejects.toThrow();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );
  it("rejects impersonation, authority overrides, missing tenant and non-CREATED state", async () => {
    const { service, tx, job } = harness();
    await expect(
      scoped(() => service.read({ jobId }), "owner", randomUUID()),
    ).rejects.toThrow();
    await expect(
      scoped(() =>
        service.read({ jobId, bookingAuthorized: true } as { jobId: string }),
      ),
    ).rejects.toThrow();
    tx.job.findFirst.mockResolvedValue({ ...job, status: "CONFIRMED" });
    await expect(scoped(() => service.read({ jobId }))).rejects.toThrow();
    tx.tenantOrganization.findFirst.mockResolvedValue(null);
    await expect(scoped(() => service.read({ jobId }))).rejects.toThrow();
  });
  it("is not registered in production", () => {
    for (const path of ["src/jobs/jobs.module.ts", "src/app.module.ts"])
      expect(readFileSync(path, "utf8")).not.toContain(
        "BookingReadinessPreview",
      );
  });
});
