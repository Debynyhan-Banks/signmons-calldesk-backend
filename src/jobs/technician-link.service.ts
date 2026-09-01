import {
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import type { ConfigType } from "@nestjs/config";
import { AuditActorType, Prisma, UserRole, UserStatus } from "@prisma/client";
import { createHmac, randomUUID, timingSafeEqual } from "crypto";
import appConfig from "../config/app.config";
import { PrismaService } from "../prisma/prisma.service";

const TOKEN_PURPOSE = "technician-workflow";
const TOKEN_VERSION = 1;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface TechnicianLinkPayload {
  version: 1;
  purpose: typeof TOKEN_PURPOSE;
  tenantId: string;
  technicianId: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}

export interface VerifiedTechnicianLink {
  tenantId: string;
  technicianId: string;
  expiresAt: Date;
}

@Injectable()
export class TechnicianLinkService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(appConfig.KEY)
    private readonly config: ConfigType<typeof appConfig>,
  ) {}

  async issue(input: {
    tenantId: string;
    technicianId: string;
    expiresInHours?: number;
    actorId: string;
    traceId?: string;
  }) {
    const technician = await this.prisma.user.findFirst({
      where: {
        id: input.technicianId,
        tenantId: input.tenantId,
        role: UserRole.TECH,
        status: UserStatus.ACTIVE,
      },
      select: { id: true, fullName: true },
    });
    if (!technician) {
      throw new NotFoundException("Active technician was not found.");
    }

    const issuedAt = Date.now();
    const ttlHours = input.expiresInHours ?? this.config.technicianLinkTtlHours;
    const expiresAt = issuedAt + ttlHours * 60 * 60 * 1000;
    const payload: TechnicianLinkPayload = {
      version: TOKEN_VERSION,
      purpose: TOKEN_PURPOSE,
      tenantId: input.tenantId,
      technicianId: technician.id,
      issuedAt,
      expiresAt,
      nonce: randomUUID(),
    };
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
      "base64url",
    );
    const signature = this.sign(encodedPayload);
    const token = `${encodedPayload}.${signature}`;
    const baseUrl = this.config.technicianAppBaseUrl.replace(/#.*$/, "");

    await this.prisma.auditLog.create({
      data: {
        tenantId: input.tenantId,
        action: "technician.link_issued",
        actorType: AuditActorType.USER,
        actorId: input.actorId,
        entityType: "User",
        entityId: technician.id,
        metadata: {
          expiresAt: new Date(expiresAt).toISOString(),
          ttlHours,
        } satisfies Prisma.InputJsonValue,
        traceId: input.traceId,
      },
    });

    return {
      technician: { id: technician.id, fullName: technician.fullName },
      expiresAt: new Date(expiresAt).toISOString(),
      url: `${baseUrl}#${encodeURIComponent(token)}`,
    };
  }

  verify(rawToken: string | undefined): VerifiedTechnicianLink {
    const token = rawToken?.trim();
    if (!token || token.length > 2048) this.invalid();
    const parts = token.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) this.invalid();

    const suppliedSignature = Buffer.from(parts[1], "utf8");
    const expectedSignature = Buffer.from(this.sign(parts[0]), "utf8");
    if (
      suppliedSignature.length !== expectedSignature.length ||
      !timingSafeEqual(suppliedSignature, expectedSignature)
    ) {
      this.invalid();
    }

    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    } catch {
      this.invalid();
    }
    if (!this.isPayload(payload)) this.invalid();

    const now = Date.now();
    const maximumTtlMs = 168 * 60 * 60 * 1000;
    if (
      payload.issuedAt > now + CLOCK_SKEW_MS ||
      payload.expiresAt <= now ||
      payload.expiresAt - payload.issuedAt > maximumTtlMs
    ) {
      this.invalid();
    }

    return {
      tenantId: payload.tenantId,
      technicianId: payload.technicianId,
      expiresAt: new Date(payload.expiresAt),
    };
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.config.technicianLinkSecret)
      .update(payload)
      .digest("base64url");
  }

  private isPayload(value: unknown): value is TechnicianLinkPayload {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return false;
    const payload = value as Record<string, unknown>;
    return (
      payload.version === TOKEN_VERSION &&
      payload.purpose === TOKEN_PURPOSE &&
      typeof payload.tenantId === "string" &&
      UUID_PATTERN.test(payload.tenantId) &&
      typeof payload.technicianId === "string" &&
      UUID_PATTERN.test(payload.technicianId) &&
      typeof payload.issuedAt === "number" &&
      Number.isSafeInteger(payload.issuedAt) &&
      typeof payload.expiresAt === "number" &&
      Number.isSafeInteger(payload.expiresAt) &&
      typeof payload.nonce === "string" &&
      UUID_PATTERN.test(payload.nonce)
    );
  }

  private invalid(): never {
    throw new UnauthorizedException("Technician link is invalid or expired.");
  }
}
