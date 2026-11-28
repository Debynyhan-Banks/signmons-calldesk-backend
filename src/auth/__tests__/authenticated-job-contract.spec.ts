import {
  NotFoundException,
  ParseUUIDPipe,
  RequestMethod,
  UnauthorizedException,
} from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from "@nestjs/common/constants";
import { JobStatus, JobUrgency, PaymentStatus } from "@prisma/client";
import type { DecodedIdToken } from "firebase-admin/auth";
import {
  getRequestContext,
  requestContextMiddleware,
} from "../../common/context/request-context";
import { TenantGuard } from "../../common/guards/tenant.guard";
import { DispatchAccessGuard } from "../../jobs/dispatch-access.guard";
import { DispatchBoardService } from "../../jobs/dispatch-board.service";
import { JobsController } from "../../jobs/jobs.controller";
import type { FirebaseAdminService } from "../firebase-admin.service";
import { RequestAuthGuard } from "../request-auth.guard";

// In-memory application contract: no Firebase/Prisma client construction, server,
// provider verification, SQL, browser, credential loading or payment execution.
describe("authenticated exact-job application contract", () => {
  const tenantId = "10000000-0000-4000-8000-000000000001";
  const otherTenantId = "10000000-0000-4000-8000-000000000002";
  const jobId = "20000000-0000-4000-8000-000000000001";
  const otherJobId = "20000000-0000-4000-8000-000000000002";
  const userId = "30000000-0000-4000-8000-000000000001";
  const otherUserId = "30000000-0000-4000-8000-000000000002";
  const now = new Date("2026-11-28T12:00:00.000Z");
  const baseJob = {
    id: jobId,
    tenantId,
    calendarOperations: [],
    status: JobStatus.CREATED,
    urgency: JobUrgency.STANDARD,
    serviceCategoryId: "40000000-0000-4000-8000-000000000001",
    serviceCategory: { name: "HEATING" },
    tenant: { timezone: "America/New_York" },
    policySnapshot: { depositRequired: true },
    payment: {
      status: PaymentStatus.PENDING,
      amountTotalCents: 9900,
      currency: "usd",
    },
    assignedUserId: null,
    assignedUser: null,
    serviceWindowStart: null,
    serviceWindowEnd: null,
    calendarEventId: null,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  const claims = (overrides: Partial<DecodedIdToken> = {}): DecodedIdToken => ({
    aud: "signmons",
    auth_time: now.getTime() / 1000,
    exp: now.getTime() / 1000 + 300,
    iat: now.getTime() / 1000,
    iss: "https://securetoken.google.com/signmons",
    sub: userId,
    uid: userId,
    firebase: { identities: {}, sign_in_provider: "custom" },
    tenantId,
    role: "admin",
    ...overrides,
  });
  const method = JobsController.prototype.getDispatchJob;
  const routeArgument = () => {
    const argumentsMetadata = Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      JobsController,
      "getDispatchJob",
    ) as Record<string, { index: number; data: string; pipes: unknown[] }>;
    const values = Object.values(argumentsMetadata);
    expect(values).toHaveLength(1);
    expect(values[0]).toMatchObject({ index: 0, data: "jobId" });
    expect(values[0].pipes).toHaveLength(1);
    expect(values[0].pipes[0]).toBeInstanceOf(ParseUUIDPipe);
    return values[0].pipes[0] as ParseUUIDPipe;
  };

  function harness() {
    const verifyIdToken = jest
      .fn<Promise<DecodedIdToken>, [string, boolean]>()
      .mockResolvedValue(claims());
    const firebase = { getAuth: () => ({ verifyIdToken }) };
    const authentication = new RequestAuthGuard(
      {
        devAuthEnabled: false,
        environment: "test",
        identityIssuer: "https://securetoken.google.com/signmons",
        identityAudience: "signmons",
      } as never,
      firebase as unknown as FirebaseAdminService,
    );
    const prisma = {
      job: {
        findFirst: jest.fn(
          (input: { where: { id: string; tenantId: string } }) =>
            Promise.resolve(
              input.where.id === jobId && input.where.tenantId === tenantId
                ? baseJob
                : null,
            ),
        ),
      },
      user: { findMany: jest.fn().mockResolvedValue([]) },
      auditLog: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new DispatchBoardService(prisma as never);
    const controller = new JobsController(
      {} as never,
      {} as never,
      {} as never,
      service,
      {} as never,
      {} as never,
    );
    const tenant = new TenantGuard();
    const access = new DispatchAccessGuard();

    async function request(token: string, requestedJob = jobId) {
      const headers: Record<string, string> = {
        authorization: `Bearer ${token}`,
        "x-request-id": `request-${token}`,
      };
      const req = { headers, header: (name: string) => headers[name] };
      const context = {
        switchToHttp: () => ({ getRequest: () => req }),
      } as ExecutionContext;
      return new Promise<{
        body: unknown;
        identity: ReturnType<typeof getRequestContext>;
      }>((resolve, reject) => {
        requestContextMiddleware(req as never, {} as never, () => {
          void (async () => {
            // Bind the driver to production registration, not a copied route.
            expect(
              Reflect.getMetadata(GUARDS_METADATA, JobsController),
            ).toEqual([RequestAuthGuard, TenantGuard]);
            expect(Reflect.getMetadata(GUARDS_METADATA, method)).toEqual([
              DispatchAccessGuard,
            ]);
            expect(await authentication.canActivate(context)).toBe(true);
            expect(tenant.canActivate()).toBe(true);
            expect(access.canActivate()).toBe(true);
            const parsedJob = await routeArgument().transform(requestedJob, {
              type: "param",
              metatype: String,
              data: "jobId",
            });
            const result = await controller.getDispatchJob(parsedJob);
            return {
              body: JSON.parse(JSON.stringify(result)) as unknown,
              identity: { ...getRequestContext() },
            };
          })().then(resolve, reject);
        });
      });
    }
    return { request, prisma, verifyIdToken };
  }

  afterEach(() => expect(getRequestContext()).toBeUndefined());

  it("binds to the existing protected GET route and its parameter pipe", () => {
    expect(Reflect.getMetadata(PATH_METADATA, JobsController)).toBe("jobs");
    expect(Reflect.getMetadata(PATH_METADATA, method)).toBe(
      "dispatch-board/:jobId",
    );
    expect(Reflect.getMetadata(METHOD_METADATA, method)).toBe(
      RequestMethod.GET,
    );
    routeArgument();
  });

  it("passes verified identity through the real guards, controller and job reader", async () => {
    const h = harness();
    const result = await h.request("synthetic-valid-token");
    expect(h.verifyIdToken).toHaveBeenCalledWith("synthetic-valid-token", true);
    expect(h.prisma.job.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: jobId, tenantId, deletedAt: null },
      }),
    );
    expect(result.identity).toMatchObject({ userId, tenantId, role: "admin" });
    expect(result.body).toMatchObject({
      jobId,
      status: "CREATED",
      updatedAt: now.toISOString(),
      paymentGate: {
        state: "LOCKED",
        paymentStatus: "PENDING",
        amountTotalCents: 9900,
        currency: "usd",
      },
      candidates: [],
      assignmentHistory: [],
    });
    expect(result.body).not.toHaveProperty("description");
    expect(result.body).not.toHaveProperty("tenantId");
    expect(JSON.stringify(result.body)).not.toContain("synthetic-valid-token");
  });

  it.each([
    "auth/argument-error",
    "auth/id-token-expired",
    "auth/id-token-revoked",
    "auth/insufficient-permission",
  ])(
    "refuses %s without database access or private error disclosure",
    async (code) => {
      const h = harness();
      h.verifyIdToken.mockRejectedValue(
        Object.assign(new Error("PRIVATE_PROVIDER_DIAGNOSTIC"), { code }),
      );
      await expect(h.request("synthetic-refused-token")).rejects.toMatchObject({
        status: 401,
        message: "Invalid bearer token.",
      });
      expect(h.prisma.job.findFirst).not.toHaveBeenCalled();
      expect(h.prisma.user.findMany).not.toHaveBeenCalled();
      expect(h.prisma.auditLog.findMany).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["wrong issuer", { iss: "https://securetoken.google.com/foreign" }],
    ["wrong audience", { aud: "foreign" }],
    ["missing tenant", { tenantId: undefined }],
    ["missing role", { role: undefined }],
  ])(
    "refuses verified claims with %s before database access",
    async (_name, change) => {
      const h = harness();
      h.verifyIdToken.mockResolvedValue(claims(change));
      await expect(h.request("synthetic-claims-token")).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(h.prisma.job.findFirst).not.toHaveBeenCalled();
    },
  );

  it("keeps another tenant's verified identity out of the exact job", async () => {
    const h = harness();
    h.verifyIdToken.mockResolvedValue(claims({ tenantId: otherTenantId }));
    await expect(h.request("synthetic-foreign-token")).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(h.prisma.job.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: jobId, tenantId: otherTenantId, deletedAt: null },
      }),
    );
    expect(h.prisma.user.findMany).not.toHaveBeenCalled();
  });

  it("refuses an absent job through the real tenant-scoped lookup", async () => {
    const h = harness();
    await expect(
      h.request("synthetic-valid-token", otherJobId),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(h.prisma.job.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: otherJobId, tenantId, deletedAt: null },
      }),
    );
  });

  it("refuses a malformed job identifier using the registered pipe before lookup", async () => {
    const h = harness();
    await expect(
      h.request("synthetic-valid-token", "not-a-uuid"),
    ).rejects.toMatchObject({
      status: 400,
    });
    expect(h.prisma.job.findFirst).not.toHaveBeenCalled();
  });

  it("isolates two interleaved authenticated requests and later refusals", async () => {
    const h = harness();
    let releaseFirst: (value: DecodedIdToken) => void = () => {
      throw new Error("First verification has not started");
    };
    h.verifyIdToken.mockImplementation((token) =>
      token === "synthetic-first"
        ? new Promise<DecodedIdToken>((resolve) => {
            releaseFirst = resolve;
          })
        : Promise.resolve(
            claims({
              sub: otherUserId,
              uid: otherUserId,
              tenantId: otherTenantId,
            }),
          ),
    );
    h.prisma.job.findFirst.mockImplementation(({ where }) =>
      Promise.resolve(
        where.id === jobId && where.tenantId === tenantId
          ? baseJob
          : where.id === otherJobId && where.tenantId === otherTenantId
            ? { ...baseJob, id: otherJobId, tenantId: otherTenantId }
            : null,
      ),
    );
    const first = h.request("synthetic-first");
    const second = await h.request("synthetic-second", otherJobId);
    releaseFirst(claims());
    const completedFirst = await first;
    expect(completedFirst.identity).toMatchObject({
      userId,
      tenantId,
      requestId: "request-synthetic-first",
    });
    expect(second.identity).toMatchObject({
      userId: otherUserId,
      tenantId: otherTenantId,
      requestId: "request-synthetic-second",
    });
    expect(completedFirst.body).toMatchObject({ jobId });
    expect(second.body).toMatchObject({ jobId: otherJobId });
    expect(getRequestContext()).toBeUndefined();
    h.verifyIdToken.mockImplementation(() => {
      expect(getRequestContext()).toEqual({
        requestId: "request-synthetic-rejected-next",
      });
      return Promise.reject(new Error("PRIVATE_REJECTED_NEXT_REQUEST"));
    });
    await expect(h.request("synthetic-rejected-next")).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(h.prisma.job.findFirst).toHaveBeenCalledTimes(2);
    expect(getRequestContext()).toBeUndefined();
  });
});
