import { CustomerMessagingSettingsService } from "./customer-messaging-settings.service";
import {
  CUSTOMER_SMS_KEYS,
  customerSmsAllowed,
  customerSmsPolicy,
  defaultCustomerSmsEvents,
} from "./customer-messaging-policy";
import { TransactionalMessageTemplateService } from "./transactional-message-template.service";
import { getRequestContext } from "../common/context/request-context";
import type { PrismaService } from "../prisma/prisma.service";
jest.mock("../common/context/request-context", () => ({
  getRequestContext: jest.fn(),
}));

describe("Customer messaging settings", () => {
  const ctx = jest.mocked(getRequestContext);
  const tenant = {
    id: "tenant-a",
    name: "Example Service",
    timezone: "America/New_York",
    settings: { unrelated: { keep: true } },
    updatedAt: new Date("2030-01-01T00:00:00.000Z"),
  };
  const db = {
    tenantOrganization: { findUnique: jest.fn(), updateMany: jest.fn() },
    auditLog: { create: jest.fn() },
    $transaction: jest.fn(),
  };
  const service = () =>
    new CustomerMessagingSettingsService(
      db as unknown as PrismaService,
      new TransactionalMessageTemplateService(),
    );
  const input = () => ({
    expectedUpdatedAt: tenant.updatedAt.toISOString(),
    events: defaultCustomerSmsEvents(),
  });
  beforeEach(() => {
    jest.resetAllMocks();
    ctx.mockReturnValue({
      tenantId: tenant.id,
      userId: "owner",
      role: "owner",
    });
    db.tenantOrganization.findUnique.mockResolvedValue(tenant);
    db.tenantOrganization.updateMany.mockResolvedValue({ count: 1 });
    db.auditLog.create.mockResolvedValue({});
    db.$transaction.mockImplementation(
      (fn: (value: typeof db) => Promise<unknown>) => fn(db),
    );
  });
  it("preserves legacy eligibility and returns only fixed branded fictional previews", async () => {
    const result = await service().read();
    expect(result.source).toBe("legacy");
    expect(result.templates).toHaveLength(4);
    expect(
      result.templates.every(
        (t) =>
          t.enabled &&
          t.body.startsWith("Example Service:") &&
          t.body.includes("STOP"),
      ),
    ).toBe(true);
    expect(result).not.toHaveProperty("settings");
    expect(result).not.toHaveProperty("tenantId");
  });
  it.each([
    null,
    [],
    "bad",
    { customerSmsPreferences: null },
    {
      customerSmsPreferences: {
        version: 2,
        events: defaultCustomerSmsEvents(),
      },
    },
    { customerSmsPreferences: { version: 1, events: {} } },
  ])("fails closed on malformed policy %j", (value) => {
    expect(customerSmsPolicy(value).source).toBe("invalid");
    expect(
      CUSTOMER_SMS_KEYS.every((key) => !customerSmsAllowed(value, key)),
    ).toBe(true);
  });
  it.each(["dispatcher", "tech", "", undefined])(
    "rejects %s before data access",
    async (role) => {
      ctx.mockReturnValue({ tenantId: tenant.id, userId: "user", role });
      await expect(service().read()).rejects.toThrow("owner or admin");
      await expect(service().save(input())).rejects.toThrow("owner or admin");
      expect(db.tenantOrganization.findUnique).not.toHaveBeenCalled();
    },
  );
  it("requires tenant and user context", async () => {
    ctx.mockReturnValue({ role: "owner" });
    await expect(service().read()).rejects.toThrow("owner or admin");
  });
  it.each([
    {},
    { ...defaultCustomerSmsEvents(), EXTRA: true },
    { ...defaultCustomerSmsEvents(), APPOINTMENT_CONFIRMED: "false" },
    [],
  ])("refuses non-exact boolean settings %j", async (events) => {
    await expect(service().save({ ...input(), events })).rejects.toThrow(
      "four boolean",
    );
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it("refuses noncanonical timestamp", async () => {
    await expect(
      service().save({ ...input(), expectedUpdatedAt: "2030-01-01" }),
    ).rejects.toThrow("reviewed version");
  });
  it("saves owner/admin settings and audit atomically, preserving unrelated keys", async () => {
    ctx.mockReturnValue({
      tenantId: tenant.id,
      userId: "admin",
      role: " ADMIN ",
    });
    const events = {
      ...defaultCustomerSmsEvents(),
      APPOINTMENT_CONFIRMED: false,
    };
    const result = await service().save({ ...input(), events });
    expect(db.tenantOrganization.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: tenant.id, updatedAt: tenant.updatedAt },
        data: expect.objectContaining({
          settings: {
            unrelated: { keep: true },
            customerSmsPreferences: { version: 1, events },
          },
        }),
      }),
    );
    expect(Date.parse(result.updatedAt)).toBeGreaterThan(
      tenant.updatedAt.getTime(),
    );
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: tenant.id,
          actorId: "admin",
          action: "communication.customer_sms_preferences_updated",
        }),
      }),
    );
  });
  it("rejects stale read and zero-row concurrent compare-and-swap", async () => {
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
  it("reports audit/transaction failures as uncertain without leaking errors", async () => {
    db.auditLog.create.mockRejectedValue(new Error("PRIVATE DATABASE"));
    await expect(service().save(input())).rejects.toThrow(
      "Save outcome is unconfirmed",
    );
  });
});
