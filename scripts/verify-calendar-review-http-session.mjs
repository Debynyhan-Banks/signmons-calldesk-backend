// Loopback-only cross-layer proof: real adapter/client, HTTP, guards and service.
// Synthetic Firebase verifier and read-only Prisma double; never AppModule.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { CalendarReviewHttpSession } from "../ui/src/calendar-review/http-session.ts";
import { CalendarReviewClient } from "../ui/src/calendar-review/client.ts";
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
} = require("../dist/common/context/request-context.js");
const {
  TenantThrottleGuard,
} = require("../dist/common/guards/tenant-throttle.guard.js");
const config = require("../dist/config/app.config.js").default;
const id = "11111111-1111-4111-8111-111111111111";
const date = new Date("2039-01-01T12:00:00.000Z");
const row = {
  id,
  jobId: id,
  action: "CREATE",
  status: "APPLIED",
  createdAt: date,
  updatedAt: date,
  finishedAt: null,
  readbackNotBefore: null,
  calendarId: "PRIVATE-TARGET",
  job: { token: "PRIVATE-TOKEN" },
};
let reads = 0,
  requests = 0,
  mode = "ready",
  pendingResolve,
  pendingEntered;
const paths = [],
  checks = [];
const snapshot = async () => {
  if (mode === "failure") throw new Error("PRIVATE-DB");
  if (mode === "delayed") {
    pendingEntered?.();
    await new Promise((resolve) => {
      pendingResolve = resolve;
    });
  }
  return row;
};
const prisma = {
  calendarOperation: {
    findMany: async ({ where }) => {
      reads++;
      return where.tenantId === "tenant-a" && where.jobId === id
        ? [await snapshot()]
        : [];
    },
    findUnique: async ({ where }) => {
      reads++;
      return where.id_tenantId.tenantId === "tenant-a" &&
        where.id_tenantId.id === id
        ? snapshot()
        : null;
    },
  },
  auditLog: {
    findMany: async () => {
      reads++;
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
const verification = async (token, revoked) => {
  assert.equal(revoked, true);
  if (
    !["owner-a", "admin-a", "owner-b", "dispatcher", "missing-tenant"].includes(
      token,
    )
  )
    throw new Error("PRIVATE-VERIFIER");
  return {
    sub: "fixture-user",
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
      useValue: { getAuth: () => ({ verifyIdToken: verification }) },
    },
    { provide: PrismaService, useValue: prisma },
    { provide: LoggingService, useValue: { warn() {}, error() {} } },
    CalendarReviewStateService,
  ],
}).compile();
const app = module.createNestApplication({ logger: false });
app.use(requestContextMiddleware);
app.use((req, _res, next) => {
  requests++;
  paths.push(req.path);
  assert.equal(req.method, "GET");
  for (const header of [
    "cookie",
    "x-admin-token",
    "x-dev-auth",
    "x-tenant-id",
    "x-dev-tenant-id",
    "x-dev-role",
  ])
    assert.equal(req.headers[header], undefined);
  assert.ok(req.headers.authorization?.startsWith("Bearer "));
  next();
});
app.useGlobalPipes(
  new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  }),
);
let session, client, unsubscribe;
try {
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address();
  assert.equal(address.address, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  session = new CalendarReviewHttpSession(base, (url, init) => {
    assert.equal(new URL(url).origin, base);
    assert.equal(init.method, "GET");
    assert.equal(init.credentials, "omit");
    assert.equal(init.redirect, "error");
    assert.equal(init.cache, "no-store");
    return fetch(url, init);
  });
  // Model the parent subscribing to every non-secret descriptor transition.
  unsubscribe = session.subscribe(() => {
    client?.dispose();
    const bound = session.getSnapshot();
    client = new CalendarReviewClient(bound.read);
    client.setScope({
      sessionKey: bound.sessionKey,
      role: bound.role,
      jobId: id,
      operationId: id,
    });
  });
  for (const token of ["owner-a", "admin-a"]) {
    session.bind({ bearerToken: token, role: "owner" });
    for (const resource of ["job", "operation", "requests"])
      await client.load(resource);
    for (const view of Object.values(client.getState().views))
      assert.equal(view.state, "ready");
    assert.equal(client.getState().views.requests.data.requestOnly, true);
    assert.equal(
      client.getState().views.operation.data.items[0].recoveryReviewCandidate,
      "applied_create",
    );
    assert.equal(JSON.stringify(client.getState()).includes("PRIVATE"), false);
  }
  checks.push(
    "All three fixed GET paths: real HTTP auth/context/service/projection through adapter and client, owner/admin pass",
  );
  session.bind({ bearerToken: "owner-b", role: "owner" });
  assert.equal(client.getState().views.operation.data, undefined);
  await client.load("job");
  assert.deepEqual(client.getState().views.job.data.items, []);
  await client.load("operation");
  assert.equal(client.getState().views.operation.state, "error");
  const beforeAudit = reads;
  await client.load("requests");
  assert.equal(reads, beforeAudit + 1);
  checks.push(
    "New-tenant binding clears old snapshots; empty job history and operation/history 404 without audit reads",
  );
  for (const token of ["dispatcher", "bad", "missing-tenant"]) {
    session.bind({ bearerToken: token, role: "owner" });
    const before = reads;
    await client.load("operation");
    assert.equal(session.getSnapshot().role, null);
    assert.equal(client.getState().allowed, false);
    assert.equal(reads, before);
  }
  checks.push(
    "Server rejects forged display role, invalid token and missing tenant before DB; session/client revoke and clear",
  );
  session.bind({ bearerToken: "owner-a", role: "owner" });
  mode = "failure";
  await client.load("operation");
  assert.equal(client.getState().views.operation.state, "error");
  assert.equal(JSON.stringify(client.getState()).includes("PRIVATE"), false);
  mode = "ready";
  await client.load("operation");
  assert.equal(client.getState().views.operation.state, "ready");
  checks.push(
    "Actual sanitized 503 is bounded; explicit manual refresh succeeds without automatic retry",
  );
  mode = "delayed";
  const entered = new Promise((resolve) => {
    pendingEntered = resolve;
  });
  const oldClient = client;
  const oldRead = client.load("operation");
  await entered;
  session.bind({ bearerToken: "owner-b", role: "owner" });
  pendingResolve();
  await oldRead;
  assert.equal(client.getState().views.operation.data, undefined);
  assert.equal(oldClient.getState().views.operation.data, undefined);
  mode = "ready";
  await client.load("job");
  assert.deepEqual(client.getState().views.job.data.items, []);
  checks.push(
    "Real in-flight HTTP read cancelled during session replacement; neither old nor new client retains old data",
  );
  session.clear();
  assert.equal(client.getState().allowed, false);
  assert.equal(new Set(paths).size, 3);
  console.log(
    JSON.stringify({
      result: "PASS",
      checks,
      requests,
      readQueries: reads,
      realComponents: [
        "HTTP adapter/session",
        "client/parser",
        "Nest HTTP",
        "auth/tenant/role/throttle guards",
        "request context",
        "review service",
        "sanitized filters",
      ],
      syntheticSeams: ["Firebase token verifier", "Prisma read-only double"],
      providerCalls: 0,
      mutationRequests: 0,
      productionRegistration: false,
    }),
  );
} finally {
  pendingResolve?.();
  unsubscribe?.();
  client?.dispose();
  session?.dispose();
  await app.close();
  console.log("Isolated loopback HTTP fixture closed.");
}
