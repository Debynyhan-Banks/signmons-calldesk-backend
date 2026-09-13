/* eslint-disable @typescript-eslint/require-await -- Network-free async boundaries. */
import { randomUUID } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
import { StagingPhoneService } from "./staging-phone.service";
import { StagingPhoneAdmission } from "./staging-phone-admission";
import {
  stagingPhoneDigest,
  stagingPhonePolicy,
  StagingPhonePolicy,
} from "./staging-phone-policy";
import { PrismaService } from "../prisma/prisma.service";
import { ConversationMemoryCipher } from "../logging/conversation-memory-cipher.service";
import { getRequestContext } from "../common/context/request-context";
jest.mock("../common/context/request-context", () => ({
  getRequestContext: jest.fn(),
}));

describe("staging phone boundary", () => {
  const p: StagingPhonePolicy = {
    version: 1,
    tenantId: randomUUID(),
    conversationId: randomUUID(),
    sessionId: randomUUID(),
    operatorId: "fixture-owner",
    accountSid: "AC" + "a".repeat(32),
    serviceSid: "VA" + "b".repeat(32),
    phoneDigest: "c".repeat(64),
    startsAt: Date.now() - 1000,
    expiresAt: Date.now() + 60000,
    rateVersion: "fixture-not-a-price",
    flowUpperBoundMicros: 300000,
    noticeVersion: "fixture-notice",
  };
  const ctx = { tenantId: p.tenantId, userId: p.operatorId, role: "owner" };
  const scope = {
    tenantId: p.tenantId,
    conversationId: p.conversationId,
    sessionId: p.sessionId,
  };
  const optIn = { requested: true as const, noticeVersion: p.noticeVersion };
  let admission: StagingPhoneAdmission;
  let tx: Prisma.TransactionClient;
  let rows: { metadata: Record<string, unknown> }[];
  let enabled: boolean;
  let now: number;
  beforeEach(() => {
    jest.mocked(getRequestContext).mockReturnValue(ctx);
    admission = new StagingPhoneAdmission(p);
    rows = [];
    enabled = true;
    now = Date.now();
    tx = {
      $queryRaw: jest.fn(async () => [
        {
          settings: {
            stagingPhoneTestApproval: {
              enabled,
              digest: stagingPhoneDigest(p),
            },
          },
          nowMs: BigInt(now),
        },
      ]),
      auditLog: {
        findMany: jest.fn(async () => rows),
        create: jest.fn(async () => ({})),
      },
    } as unknown as Prisma.TransactionClient;
  });
  it("accepts only a complete explicit policy", () => {
    expect(stagingPhonePolicy(JSON.stringify(p))).toEqual(p);
    expect(stagingPhonePolicy(undefined)).toBeNull();
  });
  it.each([
    ["version", 2],
    ["operatorId", ""],
    ["accountSid", [p.accountSid]],
    ["phoneDigest", "raw-phone"],
    ["flowUpperBoundMicros", 0],
    ["flowUpperBoundMicros", 500001],
    ["flowUpperBoundMicros", 0.5],
    ["expiresAt", p.startsAt],
    ["expiresAt", p.startsAt + 1800001],
    ["rateVersion", ""],
    ["noticeVersion", ""],
  ])("refuses malformed %s %s", (key, value) => {
    expect(
      stagingPhonePolicy(JSON.stringify({ ...p, [key]: value })),
    ).toBeNull();
  });
  it("digest is order independent and binds every value", () => {
    expect(
      stagingPhoneDigest(
        Object.fromEntries(Object.entries(p).reverse()) as StagingPhonePolicy,
      ),
    ).toBe(stagingPhoneDigest(p));
    expect(stagingPhoneDigest({ ...p, noticeVersion: "new" })).not.toBe(
      stagingPhoneDigest(p),
    );
  });
  it("default deployment cannot touch persistence", async () => {
    const db = { $transaction: jest.fn() } as unknown as PrismaService;
    const service = new StagingPhoneService(
      new ConfigService({}),
      db,
      {} as ConversationMemoryCipher,
    );
    await expect(service.execute({})).rejects.toThrow("disabled");
    await expect(service.stop()).rejects.toThrow("disabled");
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it.each([
    {},
    { ...ctx, userId: "other" },
    { ...ctx, tenantId: randomUUID() },
    { ...ctx, role: "dispatcher" },
    { ...ctx, impersonatedTenantId: p.tenantId },
  ])("refuses wrong operator context %j", async (value) => {
    jest.mocked(getRequestContext).mockReturnValue(value);
    const service = new StagingPhoneService(
      new ConfigService({
        STAGING_PHONE_TEST_ENABLED: "true",
        STAGING_PHONE_TEST_POLICY: JSON.stringify(p),
        K_SERVICE: "signmons-calldesk-staging",
        GOOGLE_CLOUD_PROJECT: "signmons",
      }),
      {} as PrismaService,
      {} as ConversationMemoryCipher,
    );
    await expect(service.execute({})).rejects.toThrow("operator");
  });
  it("disabled database switch refuses", async () => {
    enabled = false;
    await expect(admission.current(tx)).rejects.toThrow();
  });
  it.each([p.startsAt - 1, p.expiresAt])(
    "window boundary refuses %s",
    async (value) => {
      now = value;
      await expect(admission.current(tx)).rejects.toThrow();
    },
  );
  it("requires opt-in and exact participant scope", async () => {
    await expect(
      admission.reserve(tx, scope, randomUUID(), p.phoneDigest),
    ).rejects.toThrow();
    await expect(
      admission.reserve(
        tx,
        { ...scope, sessionId: randomUUID() },
        randomUUID(),
        p.phoneDigest,
        optIn,
      ),
    ).rejects.toThrow();
    await expect(
      admission.reserve(tx, scope, randomUUID(), "other", optIn),
    ).rejects.toThrow();
    await admission.reserve(tx, scope, randomUUID(), p.phoneDigest, optIn);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
  });
  it.each([
    {
      version: 1,
      state: "HELD",
      currency: "USD",
      reservedMicros: 300000,
      sessionId: randomUUID(),
    },
    {
      version: 1,
      state: "HELD",
      currency: "USD",
      reservedMicros: 1,
      sessionId: p.sessionId,
    },
    { state: "broken" },
  ])(
    "refuses held liability, duplicate session or corruption %j",
    async (metadata) => {
      rows = [{ metadata }];
      await expect(
        admission.reserve(tx, scope, randomUUID(), p.phoneDigest, optIn),
      ).rejects.toThrow();
      expect(tx.auditLog.create).not.toHaveBeenCalled();
    },
  );
  it("checks require exact retained hold", async () => {
    await expect(
      admission.check(tx, scope, randomUUID(), p.phoneDigest),
    ).rejects.toThrow();
    rows = [
      {
        metadata: {
          state: "HELD",
          approvalDigest: stagingPhoneDigest(p),
          phoneDigest: p.phoneDigest,
          sessionId: p.sessionId,
          reservedMicros: p.flowUpperBoundMicros,
        },
      },
    ];
    await admission.check(tx, scope, randomUUID(), p.phoneDigest);
    rows[0].metadata.approvalDigest = "stale";
    await expect(
      admission.check(tx, scope, randomUUID(), p.phoneDigest),
    ).rejects.toThrow();
  });
});
