import { CustomerEmailSettingsService } from "./customer-email-settings.service";
import {
  customerEmailPolicy,
  blockedCustomerEmailEvents,
} from "./customer-email-policy";
import { customerSmsPolicy } from "./customer-messaging-policy";
import { getRequestContext } from "../common/context/request-context";
import type { PrismaService } from "../prisma/prisma.service";
jest.mock("../common/context/request-context", () => ({
  getRequestContext: jest.fn(),
}));
describe("independent customer email preferences", () => {
  const ctx = jest.mocked(getRequestContext);
  const tenantId = "11111111-1111-4111-8111-111111111111";
  const tenant = {
    settings: {
      unrelated: { keep: true },
      customerSmsPreferences: {
        version: 1,
        events: {
          APPOINTMENT_CONFIRMED: true,
          APPOINTMENT_RESCHEDULED: true,
          APPOINTMENT_CANCELLED: true,
          TECHNICIAN_ON_THE_WAY: true,
        },
      },
    },
    updatedAt: new Date("2030-01-01T00:00:00.000Z"),
  };
  const db = {
    tenantOrganization: { findFirst: jest.fn(), updateMany: jest.fn() },
    auditLog: { create: jest.fn() },
    $transaction: jest.fn(),
  };
  const service = () =>
    new CustomerEmailSettingsService(db as unknown as PrismaService);
  const input = () => ({
    expectedUpdatedAt: tenant.updatedAt.toISOString(),
    events: blockedCustomerEmailEvents(),
  });
  beforeEach(() => {
    jest.resetAllMocks();
    ctx.mockReturnValue({ tenantId, userId: "owner", role: "owner" });
    db.tenantOrganization.findFirst.mockResolvedValue(tenant);
    db.tenantOrganization.updateMany.mockResolvedValue({ count: 1 });
    db.$transaction.mockImplementation(
      (fn: (tx: typeof db) => Promise<unknown>) => fn(db),
    );
  });
  it("defaults email off while SMS remains independent", async () => {
    expect(await service().read()).toEqual({
      updatedAt: tenant.updatedAt.toISOString(),
      source: "default",
      events: blockedCustomerEmailEvents(),
      recipientRole: "customer",
      deliveryAvailable: false,
    });
    expect(
      customerSmsPolicy(tenant.settings).events.APPOINTMENT_CONFIRMED,
    ).toBe(true);
    expect(db.tenantOrganization.findFirst).toHaveBeenCalledWith({
      where: { id: tenantId, status: "ACTIVE" },
      select: { settings: true, updatedAt: true },
    });
  });
  it.each([
    null,
    [],
    "bad",
    { customerEmailPreferences: null },
    {
      customerEmailPreferences: {
        version: 2,
        events: blockedCustomerEmailEvents(),
      },
    },
    { customerEmailPreferences: { version: 1, events: {} } },
    {
      customerEmailPreferences: {
        version: 1,
        events: blockedCustomerEmailEvents(),
        extra: true,
      },
    },
  ])(
    "blocks malformed stored policy without rewriting it %j",
    async (settings) => {
      db.tenantOrganization.findFirst.mockResolvedValue({
        ...tenant,
        settings,
      });
      expect(customerEmailPolicy(settings)).toEqual({
        source: "invalid",
        events: blockedCustomerEmailEvents(),
      });
      await expect(service().save(input())).rejects.toThrow(
        "administrator review",
      );
      expect(db.tenantOrganization.updateMany).not.toHaveBeenCalled();
    },
  );
  it.each([
    undefined,
    {},
    { tenantId, role: "owner" },
    { tenantId: "bad", userId: "x", role: "owner" },
    { tenantId, userId: " ", role: "owner" },
    { tenantId, userId: "x", role: "dispatcher" },
    { tenantId, userId: "x", role: "tech" },
    { tenantId, userId: "x", role: "admin", impersonatedTenantId: tenantId },
  ])("refuses invalid context before data access %j", async (context) => {
    ctx.mockReturnValue(context);
    await expect(service().read()).rejects.toThrow("owner or admin");
    await expect(service().save(input())).rejects.toThrow("owner or admin");
    expect(db.tenantOrganization.findFirst).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it.each([
    {},
    [],
    { ...blockedCustomerEmailEvents(), EXTRA: true },
    { ...blockedCustomerEmailEvents(), APPOINTMENT_CONFIRMED: "true" },
  ])("requires exactly three boolean preferences %j", async (events) => {
    await expect(service().save({ ...input(), events })).rejects.toThrow(
      "three boolean",
    );
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it.each([
    "today",
    "2030-01-01",
    "2030-01-01T00:00:00Z",
    "2030-02-30T00:00:00.000Z",
  ])("rejects noncanonical version %s", async (expectedUpdatedAt) => {
    await expect(
      service().save({ ...input(), expectedUpdatedAt }),
    ).rejects.toThrow("reviewed version");
  });
  it("saves only the email subtree and a privacy-safe audit with active tenant CAS", async () => {
    ctx.mockReturnValue({ tenantId, userId: "admin", role: " ADMIN " });
    const events = {
      ...blockedCustomerEmailEvents(),
      APPOINTMENT_CONFIRMED: true,
    };
    const result = await service().save({ ...input(), events });
    expect(result.events).toEqual(events);
    expect(result.deliveryAvailable).toBe(false);
    expect(db.tenantOrganization.updateMany).toHaveBeenCalledWith({
      where: { id: tenantId, status: "ACTIVE", updatedAt: tenant.updatedAt },
      data: {
        updatedAt: expect.any(Date),
        settings: {
          ...tenant.settings,
          customerEmailPreferences: { version: 1, events },
        },
      },
    });
    expect(db.auditLog.create).toHaveBeenCalledWith({
      data: {
        tenantId,
        actorId: "admin",
        actorType: "USER",
        entityType: "TenantOrganization",
        entityId: tenantId,
        action: "communication.customer_email_preferences_updated",
        metadata: {
          version: 1,
          events,
          expectedUpdatedAt: input().expectedUpdatedAt,
          updatedAt: result.updatedAt,
        },
      },
    });
    expect(Date.parse(result.updatedAt)).toBeGreaterThan(
      tenant.updatedAt.getTime(),
    );
  });
  it("refuses inactive/missing tenants uniformly", async () => {
    db.tenantOrganization.findFirst.mockResolvedValue(null);
    await expect(service().read()).rejects.toThrow(
      "unavailable for this tenant",
    );
    await expect(service().save(input())).rejects.toThrow(
      "unavailable for this tenant",
    );
  });
  it("rejects stale versions and a competing update before audit", async () => {
    await expect(
      service().save({
        ...input(),
        expectedUpdatedAt: "2029-01-01T00:00:00.000Z",
      }),
    ).rejects.toThrow("changed");
    db.tenantOrganization.updateMany.mockResolvedValue({ count: 0 });
    await expect(service().save(input())).rejects.toThrow("changed");
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });
  it("sanitizes read and uncertain write failures", async () => {
    db.tenantOrganization.findFirst.mockRejectedValue(new Error("PRIVATE"));
    await expect(service().read()).rejects.toThrow("Reload to try again");
    await expect(service().save(input())).rejects.toThrow(
      "outcome is unconfirmed",
    );
    db.tenantOrganization.findFirst.mockResolvedValue(tenant);
    db.auditLog.create.mockRejectedValue(new Error("PRIVATE"));
    await expect(service().save(input())).rejects.toThrow(
      "outcome is unconfirmed",
    );
  });
  it("freezes input before asynchronous transaction entry", async () => {
    const request = input();
    db.$transaction.mockImplementation(
      (fn: (tx: typeof db) => Promise<unknown>) => {
        request.expectedUpdatedAt = "bad";
        request.events.APPOINTMENT_CONFIRMED = true;
        return fn(db);
      },
    );
    const result = await service().save(request);
    expect(result.events.APPOINTMENT_CONFIRMED).toBe(false);
  });
});
