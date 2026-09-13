import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getRequestContext } from "../common/context/request-context";
import { AppointmentEmailEligibilityService } from "./appointment-email-eligibility.service";

jest.mock("../common/context/request-context", () => ({
  getRequestContext: jest.fn(),
}));
const context = jest.mocked(getRequestContext);
const tenantId = "11111111-1111-4111-8111-111111111111",
  jobId = "22222222-2222-4222-8222-222222222222",
  intentId = "33333333-3333-4333-8333-333333333333";
const version = new Date("2026-09-09T18:00:00.000Z");
const start = new Date("2030-01-01T14:00:00Z"),
  end = new Date("2030-01-01T16:00:00Z");
const flags = {
  APPOINTMENT_CONFIRMED: true,
  APPOINTMENT_RESCHEDULED: true,
  APPOINTMENT_CANCELLED: true,
};
const row = () => ({
  id: intentId,
  tenantId,
  jobId,
  kind: "APPOINTMENT_CONFIRMED",
  version: 1,
  state: "RECORDED",
  jobUpdatedAt: version,
  windowStart: start,
  windowEnd: end,
  calendarEventHash: createHash("sha256")
    .update("PRIVATE-CALENDAR")
    .digest("hex"),
  createdAt: version,
  reviewedAt: new Date(version.getTime() + 1000),
  preference: "PERMITTED",
  currentVersion: version,
  currentStatus: "ACCEPTED",
  currentStart: start,
  currentEnd: end,
  currentCalendarId: "PRIVATE-CALENDAR",
  identityMatches: true,
  receiptMatches: true,
  calendarSettled: true,
  tenantSettingsUpdatedAt: version,
  settingsValid: true,
  policyPresent: true,
  emailPolicy: { version: 1, events: flags },
});
const recipientRow = () => ({
  tenantId,
  jobId,
  status: "ACCEPTED",
  updatedAt: version,
  windowStart: start,
  windowEnd: end,
  hasCalendarEvent: true,
  calendarReferenceCleared: false,
  calendarSettled: true,
  originLinkId: "link",
  conversationId: "44444444-4444-4444-8444-444444444444",
  conversationUpdatedAt: version,
  bindingValid: true,
  intakeEmail: {
    version: 1,
    status: "captured",
    askedAt: null,
    encryptedEmail: `v1.${"a".repeat(16)}.${"A".repeat(22)}.YQ`,
  },
});
describe("inactive finalized email eligibility review", () => {
  function setup(patch = {}, recipientPatch = {}) {
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(0),
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([{ ...row(), ...patch }])
        .mockResolvedValue([{ ...recipientRow(), ...recipientPatch }]),
    };
    const prisma = {
      $transaction: jest.fn(
        (fn: (transaction: typeof tx) => Promise<unknown>) => fn(tx),
      ),
    };
    const cipher = {
      decrypt: jest.fn().mockReturnValue("Customer@example.invalid"),
    };
    const service = new AppointmentEmailEligibilityService(
      prisma as never,
      cipher as never,
    );
    return { service, tx, prisma, cipher };
  }
  beforeEach(() =>
    context.mockReturnValue({ userId: "owner", tenantId, role: "owner" }),
  );
  it.each([
    "APPOINTMENT_CONFIRMED",
    "APPOINTMENT_RESCHEDULED",
    "APPOINTMENT_CANCELLED",
  ])(
    "binds %s but refuses missing consent and expiry authority",
    async (kind) => {
      const cancel = kind === "APPOINTMENT_CANCELLED";
      const { service, tx, prisma, cipher } = setup(
        {
          kind,
          ...(cancel
            ? {
                currentStatus: "CANCELLED",
                currentStart: null,
                currentEnd: null,
                currentCalendarId: null,
              }
            : {}),
        },
        cancel
          ? {
              status: "CANCELLED",
              windowStart: null,
              windowEnd: null,
              hasCalendarEvent: false,
              calendarReferenceCleared: true,
            }
          : {},
      );
      const result = await service.evaluate({ intentId });
      expect(result).toEqual({
        resolution: "blocked",
        eligible: false,
        deliveryAuthorized: false,
        snapshotOnly: true,
        reason: "CONSENT_AUTHORITY_UNAVAILABLE",
        blockers: [
          "CONSENT_AUTHORITY_UNAVAILABLE",
          "EXPIRY_POLICY_UNAVAILABLE",
        ],
        binding: {
          intentId,
          tenantId,
          jobId,
          kind,
          jobUpdatedAt: version.toISOString(),
          tenantSettingsUpdatedAt: version.toISOString(),
          conversationId: recipientRow().conversationId,
          conversationUpdatedAt: version.toISOString(),
          reviewedAt: row().reviewedAt.toISOString(),
          recipientSource: "conversation_intake",
          ownershipVerified: false,
        },
      });
      expect(JSON.stringify(result)).not.toMatch(
        /Customer@|PRIVATE-CALENDAR|encryptedEmail|windowStart|managementUrl/,
      );
      expect(cipher.decrypt).toHaveBeenCalledTimes(1);
      expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        isolationLevel: "RepeatableRead",
        maxWait: 2000,
        timeout: 5000,
      });
      expect(
        (tx.$executeRaw.mock.calls as [TemplateStringsArray][])[0][0][0],
      ).toBe("SET TRANSACTION READ ONLY");
      expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
        tx.$queryRaw.mock.invocationCallOrder[0],
      );
      const sql = (tx.$queryRaw.mock.calls as [Prisma.Sql][])[0][0];
      expect(sql.values).toEqual([intentId, tenantId]);
      for (const clause of [
        '"AppointmentEmailIntent"',
        '"AppointmentCancellationSnapshot"',
        '"AuditLog"',
        '"SmsEnqueueIntent"',
        '"receiptMatches"',
        "MATCHED_CREATE_READBACK",
        "CURRENT_TIMESTAMP AT TIME ZONE 'UTC'",
        "t.status = 'ACTIVE'",
      ])
        expect(sql.sql).toContain(clause);
    },
  );
  it.each([
    [{ kind: "toString" }, "EVENT_INVALID"],
    [{ version: 2 }, "EVENT_INVALID"],
    [{ state: "QUEUED" }, "EVENT_INVALID"],
    [{ receiptMatches: false }, "EVENT_INVALID"],
    [{ windowEnd: start }, "EVENT_INVALID"],
    [{ windowStart: new Date(start.getTime() + 1) }, "EVENT_INVALID"],
    [{ createdAt: new Date("2099-01-01") }, "EVENT_INVALID"],
    [{ calendarEventHash: "bad" }, "EVENT_INVALID"],
    [{ currentVersion: new Date(version.getTime() + 1) }, "EVENT_STALE"],
    [{ identityMatches: false }, "EVENT_STALE"],
    [{ calendarSettled: false }, "CALENDAR_PENDING"],
    [{ currentStatus: "CANCELLED" }, "EVENT_STALE"],
    [{ currentCalendarId: "changed" }, "EVENT_STALE"],
    [{ currentCalendarId: null }, "EVENT_STALE"],
    [{ currentStart: new Date(0) }, "EVENT_STALE"],
    [{ preference: "BLOCKED" }, "EVENT_POLICY_BLOCKED"],
    [{ preference: "INVALID" }, "EVENT_POLICY_INVALID"],
    [{ preference: "unknown" }, "EVENT_POLICY_INVALID"],
    [{ settingsValid: false }, "CURRENT_POLICY_INVALID"],
    [{ emailPolicy: { version: 2 } }, "CURRENT_POLICY_INVALID"],
    [{ policyPresent: false }, "CURRENT_POLICY_BLOCKED"],
    [
      {
        emailPolicy: {
          version: 1,
          events: { ...flags, APPOINTMENT_CONFIRMED: false },
        },
      },
      "CURRENT_POLICY_BLOCKED",
    ],
  ])("refuses %j before recipient decryption", async (patch, reason) => {
    const { service, tx, cipher } = setup(patch);
    expect(await service.evaluate({ intentId })).toEqual({
      resolution: "blocked",
      eligible: false,
      deliveryAuthorized: false,
      snapshotOnly: true,
      reason,
    });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(cipher.decrypt).not.toHaveBeenCalled();
  });
  it.each([
    undefined,
    { userId: "owner", role: "owner" },
    { userId: " ", tenantId, role: "owner" },
    { userId: "owner", tenantId, role: "dispatcher" },
    {
      userId: "owner",
      tenantId,
      role: "owner",
      impersonatedTenantId: tenantId,
    },
  ])("rejects unverified context %j before database access", async (ctx) => {
    context.mockReturnValue(ctx);
    const { service, prisma } = setup();
    await expect(service.evaluate({ intentId })).rejects.toThrow(
      "verified owner",
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it.each([
    { intentId: "bad" },
    { intentId, consent: true },
    { intentId, expiresAt: "2099-01-01" },
    { intentId, email: "attacker@example.invalid" },
    { intentId, tenantId },
  ])("rejects submitted authority or recipient overrides %j", async (input) => {
    const { service, prisma } = setup();
    await expect(service.evaluate(input)).rejects.toThrow("only a finalized");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it("uses a captured request identity during awaits", async () => {
    const { service, tx } = setup();
    const input = { intentId };
    const pending = service.evaluate(input);
    input.intentId = tenantId;
    await pending;
    expect((tx.$queryRaw.mock.calls as [Prisma.Sql][])[0][0].values).toEqual([
      intentId,
      tenantId,
    ]);
  });
  it("maps missing/wrong-tenant/deleted events to unavailable without exposing data", async () => {
    const { service, tx } = setup();
    tx.$queryRaw.mockReset().mockResolvedValue([]);
    await expect(service.evaluate({ intentId })).rejects.toThrow(
      "event is unavailable",
    );
  });
  it.each([
    { bindingValid: false },
    { intakeEmail: { version: 1, status: "declined", askedAt: null } },
  ])("refuses unavailable retained recipient %j", async (patch) => {
    const { service, cipher } = setup({}, patch);
    expect(await service.evaluate({ intentId })).toHaveProperty(
      "reason",
      "RECIPIENT_UNAVAILABLE",
    );
    expect(cipher.decrypt).not.toHaveBeenCalled();
  });
  it("sanitizes read/transaction failures and never returns a partial binding", async () => {
    const { service, prisma } = setup();
    prisma.$transaction.mockRejectedValue(Error("PRIVATE-QUERY"));
    await expect(service.evaluate({ intentId })).rejects.toThrow(
      "Email eligibility review is unavailable. Reload before trying again.",
    );
  });
  it("sanitizes decrypt failures", async () => {
    const { service, cipher } = setup();
    cipher.decrypt.mockImplementation(() => {
      throw Error("PRIVATE-ADDRESS");
    });
    await expect(service.evaluate({ intentId })).rejects.toThrow(
      "Email eligibility review is unavailable",
    );
  });
  it("has no application consumers, transport, credentials or mutable admission", () => {
    const files = (path: string): string[] =>
      readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? files(join(path, entry.name))
          : [join(path, entry.name)],
      );
    for (const file of files(join(__dirname, ".."))) {
      if (
        !file.endsWith(".ts") ||
        file.endsWith(".spec.ts") ||
        file.endsWith("appointment-email-eligibility.service.ts")
      )
        continue;
      expect(readFileSync(file, "utf8")).not.toContain(
        "AppointmentEmailEligibilityService",
      );
    }
    expect(
      readFileSync(
        join(__dirname, "appointment-email-eligibility.service.ts"),
        "utf8",
      ),
    ).not.toMatch(
      /fetch\(|console\.|LoggingService|\.encrypt\(|signManagementToken|composeAppointmentEmail|\b(?:tx|prisma)\.\w+\.(?:create|update|delete|upsert)\w*\(/,
    );
  });
});
