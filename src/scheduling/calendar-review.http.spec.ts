import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import request from "supertest";
import type { Server } from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import appConfig from "../config/app.config";
import { FirebaseAdminService } from "../auth/firebase-admin.service";
import { requestContextMiddleware } from "../common/context/request-context";
import { TenantThrottleGuard } from "../common/guards/tenant-throttle.guard";
import { LoggingService } from "../logging/logging.service";
import { PrismaService } from "../prisma/prisma.service";
import { CalendarReviewController } from "./calendar-review.controller";
import { CalendarReviewStateService } from "./calendar-review-state.service";

describe("inactive Calendar review HTTP boundary (synthetic Firebase and DB)", () => {
  let app: INestApplication;
  const id = "11111111-1111-4111-8111-111111111111";
  const otherId = "22222222-2222-4222-8222-222222222222";
  const base = "/scheduling/calendar-review";
  const paths = [
    `${base}/jobs/${id}/operations`,
    `${base}/operations/${id}`,
    `${base}/operations/${id}/recovery-requests`,
  ];
  const now = new Date("2039-01-01T12:00:00.000Z");
  const row = {
    id,
    jobId: id,
    action: "CREATE",
    status: "APPLIED",
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
    readbackNotBefore: null,
    tenantId: "private-tenant",
    calendarId: "private-calendar",
    calendarEventId: "private-event",
    desiredTimeText: "private-customer",
    job: { payment: "private-payment", managementToken: "private-token" },
  };
  const snapshot = {
    snapshotOnly: true,
    operationId: id,
    jobId: id,
    action: "CREATE",
    status: "APPLIED",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    finishedAt: null,
    pendingHoldReviewCandidate: false,
    recoveryReviewCandidate: "applied_create",
    recoveryReadbackNotBefore: null,
  };
  const prisma = {
    calendarOperation: {
      findMany: jest.fn<
        Promise<unknown>,
        [{ where: { tenantId: string; jobId: string }; take: number }]
      >(),
      findUnique: jest.fn<
        Promise<unknown>,
        [{ where: { id_tenantId: { id: string; tenantId: string } } }]
      >(),
    },
    auditLog: { findMany: jest.fn() },
  };
  const logging = {
    error: jest.fn<void, [string, Error, string]>(),
    warn: jest.fn(),
  };
  const verify = jest.fn();
  function http(path: string, token = "owner") {
    const req = request(app.getHttpServer() as Server).get(path);
    return token ? req.set("Authorization", `Bearer ${token}`) : req;
  }
  function noQueries() {
    expect(prisma.calendarOperation.findMany).not.toHaveBeenCalled();
    expect(prisma.calendarOperation.findUnique).not.toHaveBeenCalled();
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  }
  function safeError(result: request.Response, status: number) {
    expect(result.status).toBe(status);
    expect(result.body).toEqual({
      statusCode: status,
      message: "Request could not be completed. Please try again later.",
    });
    expect(result.headers["cache-control"]).toBe("private, no-store");
    expect(JSON.stringify(result.body)).not.toContain("private-");
  }
  beforeEach(async () => {
    jest.resetAllMocks();
    verify.mockImplementation(async (token: string) => {
      await Promise.resolve();
      if (token === "bad") throw new Error("private-verifier-error");
      return {
        sub:
          token === "missing-user"
            ? undefined
            : token === "blank-user"
              ? " "
              : "fixture-user",
        tenantId:
          token === "missing-tenant"
            ? undefined
            : token === "blank-tenant"
              ? " "
              : token === "other-tenant"
                ? "tenant-b"
                : "tenant-a",
        role:
          token === "missing-role"
            ? undefined
            : token === "normalized"
              ? " AdMiN "
              : ["other-tenant", "wrong-issuer", "wrong-audience"].includes(
                    token,
                  )
                ? "owner"
                : token,
        iss: token === "wrong-issuer" ? "wrong" : "fixture-issuer",
        aud: token === "wrong-audience" ? "wrong" : "fixture-audience",
      };
    });
    prisma.calendarOperation.findMany.mockImplementation(({ where }) =>
      Promise.resolve(
        where.tenantId === "tenant-a" && where.jobId === id ? [row] : [],
      ),
    );
    prisma.calendarOperation.findUnique.mockImplementation(({ where }) =>
      Promise.resolve(
        where.id_tenantId.tenantId === "tenant-a" && where.id_tenantId.id === id
          ? row
          : null,
      ),
    );
    prisma.auditLog.findMany.mockResolvedValue([
      {
        id: otherId,
        action: "appointment.applied_create_readback_requested",
        createdAt: now,
        actorId: "private-actor",
        metadata: { secret: "private-audit" },
        traceId: "private-trace",
      },
    ]);
    const module = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }])],
      controllers: [CalendarReviewController],
      providers: [
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_GUARD, useClass: TenantThrottleGuard },
        {
          provide: appConfig.KEY,
          useValue: {
            environment: "production",
            devAuthEnabled: false,
            identityIssuer: "fixture-issuer",
            identityAudience: "fixture-audience",
          },
        },
        {
          provide: FirebaseAdminService,
          useValue: { getAuth: () => ({ verifyIdToken: verify }) },
        },
        { provide: PrismaService, useValue: prisma },
        { provide: LoggingService, useValue: logging },
        CalendarReviewStateService,
      ],
    }).compile();
    app = module.createNestApplication();
    app.use(requestContextMiddleware);
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });
  afterEach(async () => {
    await app?.close();
  });

  it.each(["owner", "admin", "normalized"])(
    "allows %s on all three snapshots, with no private fields",
    async (token) => {
      const list = await http(paths[0], token).expect(200);
      const exact = await http(paths[1], token).expect(200);
      const history = await http(paths[2], token).expect(200);
      expect(list.body).toEqual({
        snapshotOnly: true,
        items: [snapshot],
        hasMore: false,
      });
      expect(exact.body).toEqual(snapshot);
      expect(history.body).toEqual({
        snapshotOnly: true,
        requestOnly: true,
        hasMore: false,
        items: [
          {
            requestId: otherId,
            kind: "applied_create",
            requestedAt: now.toISOString(),
          },
        ],
      });
      for (const result of [list, exact, history]) {
        expect(result.headers["cache-control"]).toBe("private, no-store");
        expect(JSON.stringify(result.body)).not.toContain("private-");
      }
      expect(verify).toHaveBeenCalledWith(token, true);
      expect(prisma.calendarOperation.findUnique).toHaveBeenCalledWith({
        where: { id_tenantId: { id, tenantId: "tenant-a" } },
        select: { id: true },
      });
      expect(prisma.auditLog.findMany).toHaveBeenCalledWith({
        where: {
          tenantId: "tenant-a",
          entityType: "CalendarOperation",
          entityId: id,
          actorType: "USER",
          action: {
            in: [
              "appointment.applied_create_readback_requested",
              "appointment.uncertain_create_readback_requested",
            ],
          },
        },
        select: { id: true, action: true, createdAt: true },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 101,
      });
    },
  );

  it.each([
    ["", 401],
    ["bad", 401],
    ["missing-user", 401],
    ["missing-tenant", 401],
    ["missing-role", 401],
    ["blank-user", 403],
    ["blank-tenant", 403],
    ["wrong-issuer", 401],
    ["wrong-audience", 401],
    ["dispatcher", 403],
    ["technician", 403],
    ["viewer", 403],
    ["OWNER,admin", 403],
  ] as const)(
    "rejects %s before queries on every route",
    async (token, status) => {
      for (const path of paths) safeError(await http(path, token), status);
      noQueries();
    },
  );
  it("rejects blank identity even with an allowed verified role", async () => {
    verify.mockResolvedValue({
      sub: " ",
      tenantId: "tenant-a",
      role: "owner",
      iss: "fixture-issuer",
      aud: "fixture-audience",
    });
    for (const path of paths) safeError(await http(path), 401);
    noQueries();
  });
  it.each(["x-dev-auth", "x-dev-role", "x-dev-user-id", "x-dev-tenant-id"])(
    "rejects %s even alongside a valid bearer",
    async (header) => {
      for (const path of paths)
        safeError(await http(path).set(header, "fixture"), 403);
      noQueries();
      expect(verify).not.toHaveBeenCalled();
    },
  );
  it.each([
    "tenantId=tenant-b",
    "actorId=spoofed",
    "limit=1000",
    "cursor=older",
    "operationId=other",
    "tenantId=a&tenantId=b",
  ])("rejects undeclared query input %s before queries", async (query) => {
    for (const path of paths) safeError(await http(`${path}?${query}`), 400);
    noQueries();
  });
  it("rejects malformed path references on every route", async () => {
    for (const path of paths)
      safeError(await http(path.replace(id, "not-a-uuid")), 400);
    noQueries();
  });
  it("cannot override verified identity with untrusted headers or a GET body", async () => {
    const result = await http(paths[1])
      .set("x-tenant-id", "tenant-b")
      .set("x-user-id", "other")
      .set("x-role", "owner")
      .send({ tenantId: "tenant-b", actorId: "other", operationId: otherId })
      .expect(200);
    expect(result.body).toEqual(snapshot);
    expect(prisma.calendarOperation.findUnique.mock.calls[0][0].where).toEqual({
      id_tenantId: { id, tenantId: "tenant-a" },
    });
  });
  it("uniformly hides missing/cross-tenant operations and never queries their audits", async () => {
    for (const path of paths.slice(1)) {
      safeError(await http(path, "other-tenant"), 404);
      safeError(await http(path.replace(id, otherId)), 404);
    }
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });
  it("returns empty job histories for missing and other-tenant references", async () => {
    for (const result of [
      await http(paths[0], "other-tenant").expect(200),
      await http(paths[0].replace(id, otherId)).expect(200),
    ])
      expect(result.body).toEqual({
        snapshotOnly: true,
        items: [],
        hasMore: false,
      });
  });
  it("keeps concurrent request contexts isolated, including subsequent anonymous access", async () => {
    const [owner, other] = await Promise.all([
      http(paths[1]),
      http(paths[1], "other-tenant"),
    ]);
    expect(owner.body).toEqual(snapshot);
    safeError(other, 404);
    expect(
      prisma.calendarOperation.findUnique.mock.calls
        .map(([args]) => args.where.id_tenantId.tenantId)
        .sort(),
    ).toEqual(["tenant-a", "tenant-b"]);
    safeError(await http(paths[1], ""), 401);
    expect(prisma.calendarOperation.findUnique).toHaveBeenCalledTimes(2);
  });
  it("caps both histories and preserves request-only semantics", async () => {
    prisma.calendarOperation.findMany.mockResolvedValue(
      Array.from({ length: 101 }, () => row),
    );
    prisma.auditLog.findMany.mockResolvedValue(
      Array.from({ length: 101 }, () => ({
        id: otherId,
        action: "appointment.uncertain_create_readback_requested",
        createdAt: now,
      })),
    );
    for (const path of [paths[0], paths[2]]) {
      const result = await http(path).expect(200);
      const body = result.body as {
        items: unknown[];
        hasMore: boolean;
        snapshotOnly: boolean;
      };
      expect(body.items).toHaveLength(100);
      expect(body.hasMore).toBe(true);
      expect(body.snapshotOnly).toBe(true);
    }
    const history = await http(paths[2]).expect(200);
    expect(history.body).toEqual(
      expect.objectContaining({
        requestOnly: true,
        items: expect.arrayContaining([
          expect.objectContaining({ kind: "uncertain_create" }),
        ]),
      }),
    );
    expect(prisma.calendarOperation.findMany.mock.calls[0][0].take).toBe(101);
  });
  it("fresh reads reflect changed versions and do not return a conditional cached snapshot", async () => {
    const first = await http(paths[1]).expect(200);
    prisma.calendarOperation.findUnique.mockResolvedValue({
      ...row,
      status: "NEEDS_REVIEW",
      updatedAt: new Date(now.getTime() + 1),
    });
    const next = await http(paths[1])
      .set("If-None-Match", first.headers.etag ?? '"old"')
      .expect(200);
    expect(next.body).toEqual({
      ...snapshot,
      status: "NEEDS_REVIEW",
      updatedAt: new Date(now.getTime() + 1).toISOString(),
      recoveryReviewCandidate: null,
    });
    expect(prisma.calendarOperation.findUnique).toHaveBeenCalledTimes(2);
  });
  it.each(["job", "operation", "audit"] as const)(
    "bounds %s query failures without retry or diagnostic leakage",
    async (target) => {
      const method =
        target === "job"
          ? prisma.calendarOperation.findMany
          : target === "operation"
            ? prisma.calendarOperation.findUnique
            : prisma.auditLog.findMany;
      method.mockRejectedValue(new Error("private-database-secret"));
      const path = paths[target === "job" ? 0 : target === "operation" ? 1 : 2];
      safeError(await http(path), 503);
      expect(method).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(logging.warn.mock.calls)).not.toContain(
        "private-database-secret",
      );
      expect(logging.error.mock.calls[0][1].message).not.toContain(
        "private-database-secret",
      );
    },
  );
  it.each(["job", "operation", "audit"] as const)(
    "bounds malformed %s projections",
    async (target) => {
      if (target === "job")
        prisma.calendarOperation.findMany.mockResolvedValue([
          { ...row, createdAt: new Date(NaN) },
        ]);
      if (target === "operation")
        prisma.calendarOperation.findUnique.mockResolvedValue({
          ...row,
          updatedAt: new Date(NaN),
        });
      if (target === "audit")
        prisma.auditLog.findMany.mockResolvedValue([
          { id, action: "private-unsupported", createdAt: now },
        ]);
      safeError(
        await http(
          paths[target === "job" ? 0 : target === "operation" ? 1 : 2],
        ),
        503,
      );
    },
  );
  it.each(paths)(
    "limits %s to 30 reads per minute per existing local route tracker",
    async (path) => {
      for (let count = 0; count < 30; count += 1) await http(path).expect(200);
      safeError(await http(path), 429);
      expect(verify).toHaveBeenCalledTimes(30);
    },
  );
  it("has no mutation transport", async () => {
    for (const path of [...paths, `${paths[1]}/hold`, `${paths[1]}/recover`]) {
      await request(app.getHttpServer() as Server)
        .post(path)
        .set("Authorization", "Bearer owner")
        .send({ acknowledgeReadback: true })
        .expect(404);
    }
    noQueries();
  });
  it("remains absent from every application module and exposes only read dependencies", () => {
    const root = join(__dirname, "..");
    function walk(dir: string): string[] {
      return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? walk(join(dir, entry.name))
          : [join(dir, entry.name)],
      );
    }
    for (const file of walk(root).filter((name) =>
      name.endsWith(".module.ts"),
    )) {
      expect(readFileSync(file, "utf8")).not.toMatch(
        /CalendarReview|calendar-review/,
      );
    }
    const controller = readFileSync(
      join(__dirname, "calendar-review.controller.ts"),
      "utf8",
    );
    expect(controller).not.toMatch(
      /@(Post|Put|Patch|Delete)\b|PrismaService|RecoveryService|ExecutionService/,
    );
    expect(Object.keys(prisma)).toEqual(["calendarOperation", "auditLog"]);
  });
});
