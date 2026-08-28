import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { ConfigType } from "@nestjs/config";
import type { Request } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import appConfig from "../../config/app.config";
import { setAuthContext } from "../../common/context/request-context";

@Injectable()
export class WebchatIntegrationGuard implements CanActivate {
  constructor(
    @Inject(appConfig.KEY)
    private readonly config: ConfigType<typeof appConfig>,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const authorization = request.header("authorization") ?? "";
    if (!authorization.startsWith("Bearer ")) {
      throw new UnauthorizedException("Missing integration credential.");
    }

    const credential = authorization.slice("Bearer ".length).trim();
    if (credential.length < 24) {
      throw new UnauthorizedException("Invalid integration credential.");
    }

    const presentedHash = createHash("sha256").update(credential).digest();
    const integration = this.config.webchatIntegrations.find((candidate) => {
      const configuredHash = Buffer.from(candidate.keyHash, "hex");
      return (
        configuredHash.length === presentedHash.length &&
        timingSafeEqual(configuredHash, presentedHash)
      );
    });

    if (!integration) {
      throw new UnauthorizedException("Invalid integration credential.");
    }

    setAuthContext({
      userId: `integration:${integration.name}`,
      tenantId: integration.tenantId,
      role: "webchat_integration",
    });
    return true;
  }
}
