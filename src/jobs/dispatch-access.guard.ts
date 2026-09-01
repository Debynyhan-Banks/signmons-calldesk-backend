import { CanActivate, ForbiddenException, Injectable } from "@nestjs/common";
import { getRequestContext } from "../common/context/request-context";

const DISPATCH_ROLES = new Set(["admin", "owner", "dispatcher"]);

@Injectable()
export class DispatchAccessGuard implements CanActivate {
  canActivate(): boolean {
    const role = getRequestContext()?.role?.trim().toLowerCase();
    if (!role || !DISPATCH_ROLES.has(role)) {
      throw new ForbiddenException(
        "Dispatch operations require an owner, admin, or dispatcher role.",
      );
    }
    return true;
  }
}
