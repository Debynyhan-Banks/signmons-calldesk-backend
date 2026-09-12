import { Test } from "@nestjs/testing";
import {
  INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  StagingPhoneController,
  StagingPhoneFilter,
} from "./staging-phone.controller";
import { StagingPhoneService } from "./staging-phone.service";
import { RequestAuthGuard } from "../auth/request-auth.guard";
import { TenantGuard } from "../common/guards/tenant.guard";
import { PrismaService } from "../prisma/prisma.service";
import { ConversationMemoryCipher } from "../logging/conversation-memory-cipher.service";

describe("phone-only HTTP default-off boundary", () => {
  let app: INestApplication;
  let base: string;
  let authenticated = true;
  const db = { $transaction: jest.fn() };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [StagingPhoneController],
      providers: [
        StagingPhoneService,
        StagingPhoneFilter,
        { provide: ConfigService, useValue: new ConfigService({}) },
        { provide: PrismaService, useValue: db },
        { provide: ConversationMemoryCipher, useValue: {} },
      ],
    })
      .overrideGuard(RequestAuthGuard)
      .useValue({
        canActivate: () => {
          if (!authenticated) throw new UnauthorizedException();
          return true;
        },
      })
      .overrideGuard(TenantGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication({ logger: false });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
  });
  afterAll(async () => {
    await app?.close();
  });
  it("authenticated operations and stop remain disabled with no persistence", async () => {
    for (const path of ["operations", "stop"]) {
      const r = await fetch(
        `${base}/communications/staging-phone-test/${path}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ operation: {} }),
        },
      );
      expect(r.status).toBe(503);
      expect(r.headers.get("cache-control")).toBe("private, no-store");
      expect(await r.text()).not.toContain("stack");
    }
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it("rejects malformed bodies without echoing OTPs", async () => {
    const r = await fetch(
      `${base}/communications/staging-phone-test/operations`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operation: "123456",
          injected: "private-token",
        }),
      },
    );
    expect(r.status).toBe(400);
    const text = await r.text();
    expect(text).not.toContain("123456");
    expect(text).not.toContain("private-token");
  });
  it("denies an unauthenticated request", async () => {
    authenticated = false;
    const r = await fetch(`${base}/communications/staging-phone-test/stop`, {
      method: "POST",
    });
    expect(r.status).toBe(401);
  });
});
