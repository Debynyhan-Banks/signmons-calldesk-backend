import { CanActivate, Injectable, UnauthorizedException } from "@nestjs/common";
import { getRequestContext } from "../context/request-context";

@Injectable()
export class TenantGuard implements CanActivate {
  canActivate(): boolean {
    const tenantId = getRequestContext()?.tenantId;
    if (!tenantId) {
      throw new UnauthorizedException("Tenant context is missing.");
    }
    return true;
  }
}
