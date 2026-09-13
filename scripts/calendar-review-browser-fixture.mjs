// Local test composition only. No AppModule, real identity, database or providers.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { Test } = require("@nestjs/testing");
const { APP_GUARD } = require("@nestjs/core");
const { ThrottlerModule, ThrottlerGuard } = require("@nestjs/throttler");
const { ValidationPipe } = require("@nestjs/common");
const {
  CalendarReviewController,
} = require("../dist/scheduling/calendar-review.controller.js");
const {
  CalendarReviewStateService,
} = require("../dist/scheduling/calendar-review-state.service.js");
const {
  FirebaseAdminService,
} = require("../dist/auth/firebase-admin.service.js");
const { PrismaService } = require("../dist/prisma/prisma.service.js");
const { LoggingService } = require("../dist/logging/logging.service.js");
const {
  requestContextMiddleware,
  getRequestContext,
} = require("../dist/common/context/request-context.js");
const {
  TenantThrottleGuard,
} = require("../dist/common/guards/tenant-throttle.guard.js");
const config = require("../dist/config/app.config.js").default;
const id = "11111111-1111-4111-8111-111111111111";
const date = new Date("2039-01-01T12:00:00.000Z");

export async function createCalendarReviewBrowserFixture() {
  let browserOrigin = null;
  const metrics = {
    gets: 0,
    preflights: 0,
    reads: 0,
    delayedStarted: 0,
    delayedFinished: 0,
    cancelledGets: 0,
    forbiddenHeaders: 0,
    mutations: 0,
    statuses: {},
  };
  const timers = new Set();
  const row = {
    id,
    jobId: id,
    action: "CREATE",
    status: "APPLIED",
    createdAt: date,
    updatedAt: date,
    finishedAt: null,
    readbackNotBefore: null,
    calendarId: "PRIVATE-CALENDAR",
    job: { token: "PRIVATE-TOKEN" },
  };
  async function snapshot() {
    const user = getRequestContext()?.userId;
    if (user === "failure-a") throw new Error("PRIVATE-DATABASE");
    if (user === "delayed-a") {
      metrics.delayedStarted++;
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          timers.delete(timer);
          resolve();
        }, 1200);
        timers.add(timer);
      });
      metrics.delayedFinished++;
    }
    return row;
  }
  const prisma = {
    calendarOperation: {
      findMany: async ({ where }) => {
        metrics.reads++;
        return where.tenantId === "tenant-a" && where.jobId === id
          ? [await snapshot()]
          : [];
      },
      findUnique: async ({ where }) => {
        metrics.reads++;
        return where.id_tenantId.tenantId === "tenant-a" &&
          where.id_tenantId.id === id
          ? snapshot()
          : null;
      },
    },
    auditLog: {
      findMany: async () => {
        metrics.reads++;
        return [
          {
            id,
            action: "appointment.applied_create_readback_requested",
            createdAt: date,
            actorId: "PRIVATE-ACTOR",
            metadata: "PRIVATE-METADATA",
          },
        ];
      },
    },
  };
  const module = await Test.createTestingModule({
    imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }])],
    controllers: [CalendarReviewController],
    providers: [
      { provide: APP_GUARD, useClass: ThrottlerGuard },
      { provide: APP_GUARD, useClass: TenantThrottleGuard },
      {
        provide: config.KEY,
        useValue: {
          environment: "production",
          devAuthEnabled: false,
          identityIssuer: "fixture-issuer",
          identityAudience: "fixture-audience",
        },
      },
      {
        provide: FirebaseAdminService,
        useValue: {
          getAuth: () => ({
            verifyIdToken: async (token, revoked) => {
              assert.equal(revoked, true);
              if (
                ![
                  "owner-a",
                  "admin-a",
                  "owner-b",
                  "dispatcher",
                  "missing-tenant",
                  "failure-a",
                  "delayed-a",
                ].includes(token)
              )
                throw new Error("PRIVATE-IDENTITY");
              return {
                sub: token,
                role:
                  token === "dispatcher"
                    ? "dispatcher"
                    : token === "admin-a"
                      ? "admin"
                      : "owner",
                tenantId:
                  token === "missing-tenant"
                    ? undefined
                    : token === "owner-b"
                      ? "tenant-b"
                      : "tenant-a",
                iss: "fixture-issuer",
                aud: "fixture-audience",
              };
            },
          }),
        },
      },
      { provide: PrismaService, useValue: prisma },
      { provide: LoggingService, useValue: { warn() {}, error() {} } },
      CalendarReviewStateService,
    ],
  }).compile();
  const app = module.createNestApplication({ logger: false });
  app.use((req, res, next) => {
    if (req.method === "OPTIONS") metrics.preflights++;
    else if (req.method === "GET") metrics.gets++;
    else {
      metrics.mutations++;
      return res.status(405).end();
    }
    for (const header of [
      "cookie",
      "x-admin-token",
      "x-dev-auth",
      "x-tenant-id",
      "x-dev-tenant-id",
      "x-dev-role",
    ])
      if (req.headers[header] !== undefined) metrics.forbiddenHeaders++;
    res.on("finish", () => {
      metrics.statuses[res.statusCode] =
        (metrics.statuses[res.statusCode] ?? 0) + 1;
    });
    res.on("close", () => {
      if (req.method === "GET" && !res.writableFinished)
        metrics.cancelledGets++;
    });
    next();
  });
  // Register after metrics so actual browser preflights are measured too.
  app.use(
    require("cors")({
      origin: (origin, callback) =>
        callback(null, Boolean(browserOrigin && origin === browserOrigin)),
      methods: ["GET"],
      allowedHeaders: ["Authorization", "Accept"],
      credentials: false,
      maxAge: 0,
    }),
  );
  app.use(requestContextMiddleware);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  await app.listen(0, "127.0.0.1");
  return {
    origin: `http://127.0.0.1:${app.getHttpServer().address().port}`,
    setBrowserOrigin(value) {
      assert.equal(browserOrigin, null);
      const url = new URL(value);
      assert.equal(url.hostname, "127.0.0.1");
      assert.equal(url.protocol, "http:");
      browserOrigin = url.origin;
    },
    metrics: () => structuredClone(metrics),
    close: async () => {
      // Let bounded synthetic reads settle, then close every local connection.
      if (timers.size)
        await new Promise((resolve) => setTimeout(resolve, 1300));
      app.getHttpServer().closeAllConnections();
      await app.close();
    },
  };
}
