import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import request from "supertest";
import type { Server } from "node:http";
import appConfig from "../config/app.config";
import { FirebaseAdminService } from "../auth/firebase-admin.service";
import { requestContextMiddleware } from "../common/context/request-context";
import { SanitizedExceptionFilter } from "../common/filters/sanitized-exception.filter";
import type { LoggingService } from "../logging/logging.service";
import { CommunicationsOperationsController } from "./communications-operations.controller";
import { SmsDeliveryService } from "./sms-delivery.service";
import { TransactionalMessagingService } from "./transactional-messaging.service";
import { SmsEnqueueIntentService } from "./sms-enqueue-intent.service";
import { SmsEnqueueRecoveryService } from "./sms-enqueue-recovery.service";

describe("enqueue retry HTTP boundary (synthetic Firebase verification only)", () => {
  let app: INestApplication;
  const id = "10000000-0000-4000-8000-000000000001";
  const path = `/communications/sms/enqueue-intents/${id}/retry`;
  const body = {
    acknowledgeRetry: true,
    reasonCode: "CONFIGURATION_REVIEWED",
    expectedUpdatedAt: "2026-09-08T12:00:00.000Z",
  };
  const recovery = {
    retry: jest.fn().mockResolvedValue({ status: "pending" }),
  };
  const verify = jest.fn((token: string) => {
    if (
      ![
        "owner",
        "admin",
        "dispatcher",
        "technician",
        "viewer",
        "missing-tenant",
      ].includes(token)
    )
      throw new Error("invalid fixture token");
    return Promise.resolve({
      sub: "fixture-user",
      tenantId: token === "missing-tenant" ? undefined : "fixture-tenant",
      role: token,
    });
  });
  beforeEach(async () => {
    const module = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }])],
      controllers: [CommunicationsOperationsController],
      providers: [
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        {
          provide: appConfig.KEY,
          useValue: { environment: "production", devAuthEnabled: false },
        },
        {
          provide: FirebaseAdminService,
          useValue: { getAuth: () => ({ verifyIdToken: verify }) },
        },
        { provide: SmsDeliveryService, useValue: {} },
        { provide: TransactionalMessagingService, useValue: {} },
        { provide: SmsEnqueueIntentService, useValue: {} },
        { provide: SmsEnqueueRecoveryService, useValue: recovery },
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
    app.useGlobalFilters(
      new SanitizedExceptionFilter({
        error: () => {},
        warn: () => {},
      } as unknown as LoggingService),
    );
    await app.init();
  });
  afterEach(async () => {
    await app?.close();
  });
  beforeEach(() => {
    recovery.retry.mockClear();
    verify.mockClear();
  });

  it.each(["owner", "admin"])(
    "allows %s and derives tenant/actor from verified claims",
    async (role) => {
      const result = await request(app.getHttpServer() as Server)
        .post(path)
        .set("Authorization", `Bearer ${role}`)
        .send(body)
        .expect(202);
      expect(result.body).toEqual({ status: "pending" });
      expect(result.headers["cache-control"]).toBe("private, no-store");
      expect(verify).toHaveBeenCalledWith(role, true);
      expect(recovery.retry).toHaveBeenCalledWith({
        ...body,
        tenantId: "fixture-tenant",
        actorId: "fixture-user",
        intentId: id,
      });
    },
  );
  it.each(["dispatcher", "technician", "viewer"])(
    "rejects %s before recovery",
    async (role) => {
      await request(app.getHttpServer() as Server)
        .post(path)
        .set("Authorization", `Bearer ${role}`)
        .send(body)
        .expect(403);
      expect(recovery.retry).not.toHaveBeenCalled();
    },
  );
  it.each([undefined, "bad", "missing-tenant"])(
    "rejects missing/invalid identity %s",
    async (token) => {
      const req = request(app.getHttpServer() as Server).post(path);
      if (token) req.set("Authorization", `Bearer ${token}`);
      await req.send(body).expect(401);
      expect(recovery.retry).not.toHaveBeenCalled();
    },
  );
  it.each([
    {},
    { ...body, acknowledgeRetry: false },
    { ...body, acknowledgeRetry: "true" },
    { ...body, reasonCode: "arbitrary text" },
    { ...body, expectedUpdatedAt: "2026-02-30T12:00:00.000Z" },
    { ...body, expectedUpdatedAt: "2026-09-08" },
    { ...body, tenantId: "spoofed" },
    { ...body, actorId: "spoofed" },
    { ...body, message: "arbitrary send" },
  ])("rejects invalid/extra request fields: %j", async (payload) => {
    await request(app.getHttpServer() as Server)
      .post(path)
      .set("Authorization", "Bearer owner")
      .send(payload)
      .expect(400);
    expect(recovery.retry).not.toHaveBeenCalled();
  });
  it("rejects malformed intent IDs", async () => {
    await request(app.getHttpServer() as Server)
      .post("/communications/sms/enqueue-intents/not-a-uuid/retry")
      .set("Authorization", "Bearer owner")
      .send(body)
      .expect(400);
    expect(recovery.retry).not.toHaveBeenCalled();
  });
  it("does not allow developer headers to bypass bearer verification", async () => {
    await request(app.getHttpServer() as Server)
      .post(path)
      .set("x-dev-auth", "fixture")
      .set("Authorization", "Bearer owner")
      .send(body)
      .expect(403);
    expect(recovery.retry).not.toHaveBeenCalled();
  });
  it("limits this retry endpoint to five requests per minute for its local tracker", async () => {
    for (let count = 0; count < 5; count += 1) {
      await request(app.getHttpServer() as Server)
        .post(path)
        .set("Authorization", "Bearer owner")
        .send(body)
        .expect(202);
    }
    await request(app.getHttpServer() as Server)
      .post(path)
      .set("Authorization", "Bearer owner")
      .send(body)
      .expect(429);
    expect(recovery.retry).toHaveBeenCalledTimes(5);
  });
});
