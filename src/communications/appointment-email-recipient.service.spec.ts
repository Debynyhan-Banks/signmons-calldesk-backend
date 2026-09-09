import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getRequestContext } from "../common/context/request-context";
import { ConversationMemoryCipher } from "../logging/conversation-memory-cipher.service";
import { PrismaService } from "../prisma/prisma.service";
import { AppointmentEmailRecipientService } from "./appointment-email-recipient.service";
import type appConfig from "../config/app.config";
import type { ConfigType } from "@nestjs/config";

jest.mock("../common/context/request-context", () => ({
  getRequestContext: jest.fn(),
}));
const context = jest.mocked(getRequestContext);
const tenantId = "11111111-1111-4111-8111-111111111111",
  jobId = "22222222-2222-4222-8222-222222222222";
const version = "2026-09-09T16:00:00.123Z";
const cipher = new ConversationMemoryCipher({
  conversationDataEncryptionKey: "2".repeat(64),
} as ConfigType<typeof appConfig>);
const state = () => ({
  version: 1,
  status: "captured",
  askedAt: null,
  encryptedEmail: cipher.encrypt("Customer@example.invalid"),
});
const row = () => ({
  tenantId,
  jobId,
  status: "ACCEPTED",
  updatedAt: new Date(version),
  windowStart: new Date("2026-09-15T14:00:00.000Z"),
  windowEnd: new Date("2026-09-15T16:00:00.000Z"),
  hasCalendarEvent: true,
  calendarReferenceCleared: false,
  calendarSettled: true,
  originLinkId: "link",
  conversationId: "33333333-3333-4333-8333-333333333333",
  conversationUpdatedAt: new Date(version),
  bindingValid: true,
  intakeEmail: state(),
});
const input = () => ({
  jobId,
  kind: "confirmed" as const,
  expectedJobUpdatedAt: version,
});

describe("inactive appointment email recipient resolution", () => {
  let query: jest.Mock;
  let service: AppointmentEmailRecipientService;
  beforeEach(() => {
    context.mockReturnValue({ userId: "owner", tenantId, role: "owner" });
    query = jest.fn().mockResolvedValue([row()]);
    service = new AppointmentEmailRecipientService(
      { $queryRaw: query } as unknown as PrismaService,
      cipher,
    );
  });
  it("resolves only captured intake email and labels the result private and not delivery-authorized", async () => {
    const result = await service.resolve(input());
    expect(result).toEqual({
      resolution: "recipient_resolved",
      sensitivity: "customer-private",
      snapshotOnly: true,
      deliveryAuthorized: false,
      tenantId,
      jobId,
      kind: "confirmed",
      jobUpdatedAt: version,
      recipient: {
        email: "Customer@example.invalid",
        source: "conversation_intake",
        conversationId: row().conversationId,
        conversationUpdatedAt: version,
        ownershipVerified: false,
      },
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toMatch(
      /encryptedEmail|windowStart|hasCalendarEvent|originLinkId|intakeEmail/,
    );
  });
  it("binds the statement to verified tenant, ignoring submitted tenant/recipient overrides", async () => {
    await service.resolve({
      ...input(),
      tenantId: "forged",
      email: "wrong@example.invalid",
    } as ReturnType<typeof input>);
    const calls = query.mock.calls as [Prisma.Sql][];
    const sql = calls[0][0];
    expect(sql.values).toEqual([jobId, tenantId]);
    expect(sql.sql).toContain("LIMIT 2");
    expect(sql.sql).toContain("'CREATED_FROM'");
    expect(sql.sql).toContain(
      'c."collectedData" ->> \'sessionId\' = j."intakeSessionId"',
    );
    expect(sql.sql).toContain('CASE WHEN origin."bindingValid"');
    expect(sql.sql).not.toMatch(
      /SELECT \*|customer\."email"|customer\."phone"/,
    );
  });
  it.each([
    undefined,
    {},
    { userId: "owner", role: "owner" },
    { tenantId, role: "owner" },
    { userId: "owner", tenantId, role: "dispatcher" },
    { userId: "owner", tenantId, role: "tech" },
    { userId: "owner", tenantId, role: "customer" },
    {
      userId: "owner",
      tenantId,
      role: "admin",
      impersonatedTenantId: tenantId,
    },
  ])(
    "refuses missing/unsupported context before database reads %j",
    async (ctx) => {
      context.mockReturnValue(ctx);
      await expect(service.resolve(input())).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(query).not.toHaveBeenCalled();
    },
  );
  it("accepts normalized admin context", async () => {
    context.mockReturnValue({ userId: "admin", tenantId, role: " ADMIN " });
    await expect(service.resolve(input())).resolves.toHaveProperty(
      "deliveryAuthorized",
      false,
    );
  });
  it.each([
    { jobId: "bad-id" },
    { kind: "send" },
    { kind: "constructor" },
    { expectedJobUpdatedAt: "bad-date" },
    { expectedJobUpdatedAt: "2026-09-09T16:00:00Z" },
    { expectedJobUpdatedAt: "2026-02-30T16:00:00.123Z" },
  ])("validates requests before database reads %j", async (patch) => {
    await expect(
      service.resolve({ ...input(), ...patch } as ReturnType<typeof input>),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(query).not.toHaveBeenCalled();
  });
  it("uses one uniform missing response", async () => {
    query.mockResolvedValue([]);
    await expect(service.resolve(input())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
  it.each([
    { updatedAt: new Date("2026-09-09T16:00:00.124Z") },
    { calendarSettled: false },
    { status: "CREATED" },
    { status: "IN_PROGRESS" },
    { status: "COMPLETED" },
    { status: "CANCELLED" },
    { hasCalendarEvent: false },
    { windowStart: null },
    { windowEnd: null },
    { windowEnd: new Date("2026-09-15T13:00:00.000Z") },
    { windowStart: new Date("2026-09-15T14:00:01.000Z") },
    { bindingValid: false },
    { bindingValid: null },
    { originLinkId: null },
    { conversationId: null },
    { conversationUpdatedAt: null },
  ])(
    "refuses stale/ineligible/ambiguous projections without decrypting %j",
    async (patch) => {
      query.mockResolvedValue([{ ...row(), ...patch }]);
      const decrypt = jest.spyOn(cipher, "decrypt");
      try {
        await expect(service.resolve(input())).rejects.toBeInstanceOf(
          ConflictException,
        );
        expect(decrypt).not.toHaveBeenCalled();
      } finally {
        decrypt.mockRestore();
      }
    },
  );
  it("never chooses between multiple origin links even with the same email", async () => {
    query.mockResolvedValue([row(), row()]);
    await expect(service.resolve(input())).rejects.toThrow(
      "Intake email association needs review.",
    );
  });
  it("supports structural cancellation with cleared fields but does not claim finalized event truth", async () => {
    query.mockResolvedValue([
      {
        ...row(),
        status: "CANCELLED",
        hasCalendarEvent: false,
        calendarReferenceCleared: true,
        windowStart: null,
        windowEnd: null,
      },
    ]);
    const result = await service.resolve({ ...input(), kind: "cancelled" });
    expect(result.deliveryAuthorized).toBe(false);
    expect(result).not.toHaveProperty("appointment");
  });
  it("rejects cancellation with an uncleared reference or reservation", async () => {
    for (const patch of [
      { calendarReferenceCleared: false },
      { windowStart: new Date(version) },
    ]) {
      query.mockResolvedValue([
        {
          ...row(),
          status: "CANCELLED",
          hasCalendarEvent: false,
          calendarReferenceCleared: true,
          windowStart: null,
          windowEnd: null,
          ...patch,
        },
      ]);
      await expect(
        service.resolve({ ...input(), kind: "cancelled" }),
      ).rejects.toBeInstanceOf(ConflictException);
    }
  });
  it("supports structural reschedule without inventing event receipt or previous window", async () => {
    await expect(
      service.resolve({ ...input(), kind: "rescheduled" }),
    ).resolves.toHaveProperty("kind", "rescheduled");
  });
  it.each([
    null,
    {},
    { version: 1, status: "asked", askedAt: version },
    { version: 1, status: "declined", askedAt: null },
    { ...state(), version: 2 },
    { ...state(), extra: "private-value" },
    { ...state(), askedAt: "bad" },
    { ...state(), encryptedEmail: "bad-envelope" },
    {
      ...state(),
      encryptedEmail: cipher.encrypt("Customer@example.invalid") + ".ignored",
    },
    {
      ...state(),
      encryptedEmail: cipher.encrypt("email: wrong@example.invalid"),
    },
    {
      ...state(),
      encryptedEmail: cipher.encrypt(
        "a@example.invalid\r\nBcc:b@example.invalid",
      ),
    },
  ])(
    "rejects missing/uncaptured/malformed encrypted state %j",
    async (intakeEmail) => {
      query.mockResolvedValue([{ ...row(), intakeEmail }]);
      await expect(service.resolve(input())).rejects.toBeInstanceOf(
        ConflictException,
      );
    },
  );
  it("refuses ciphertext under a different key", async () => {
    const wrongCipher = new ConversationMemoryCipher({
      conversationDataEncryptionKey: "3".repeat(64),
    } as ConfigType<typeof appConfig>);
    query.mockResolvedValue([
      {
        ...row(),
        intakeEmail: {
          ...state(),
          encryptedEmail: wrongCipher.encrypt("wrong@example.invalid"),
        },
      },
    ]);
    await expect(service.resolve(input())).rejects.toThrow(
      "Captured email state needs review.",
    );
  });
  it("sanitizes query/cipher errors and mismatched projection without leaking causes", async () => {
    query.mockRejectedValue(
      new Error("private@example.invalid raw query credential"),
    );
    await expect(service.resolve(input())).rejects.toThrow(
      "Email recipient review is unavailable. Reload before trying again.",
    );
    query.mockResolvedValue([
      { ...row(), tenantId: "33333333-3333-4333-8333-333333333333" },
    ]);
    await expect(service.resolve(input())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    query.mockResolvedValue([row()]);
    const spy = jest.spyOn(cipher, "decrypt").mockImplementation(() => {
      throw new Error("secret");
    });
    try {
      await expect(service.resolve(input())).rejects.toThrow(
        "Email recipient review is unavailable. Reload before trying again.",
      );
    } finally {
      spy.mockRestore();
    }
  });
  it("captures request fields before awaiting a read", async () => {
    let complete!: (value: unknown) => void;
    query.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const request = {
      ...input(),
      kind: "confirmed" as "confirmed" | "cancelled",
    };
    const pending = service.resolve(request);
    request.kind = "cancelled";
    complete([row()]);
    await expect(pending).resolves.toHaveProperty("kind", "confirmed");
  });
  it("has no application registration, mutation or sending calls", () => {
    function files(path: string): string[] {
      return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? files(join(path, entry.name))
          : [join(path, entry.name)],
      );
    }
    for (const file of files(join(__dirname, ".."))) {
      if (
        !file.endsWith(".ts") ||
        file.endsWith(".spec.ts") ||
        file.endsWith("appointment-email-recipient.service.ts") ||
        file.endsWith("appointment-email-eligibility.service.ts")
      )
        continue;
      expect(readFileSync(file, "utf8")).not.toContain(
        "AppointmentEmailRecipientService",
      );
    }
    const source = readFileSync(
      join(__dirname, "appointment-email-recipient.service.ts"),
      "utf8",
    );
    expect(source).not.toMatch(
      /fetch\(|console\.|LoggingService|\$executeRaw|\$transaction|\.encrypt\(|signManagementToken|composeAppointmentEmail\(/,
    );
  });
});
