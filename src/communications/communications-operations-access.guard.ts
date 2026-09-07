import { CanActivate, ForbiddenException, Injectable } from "@nestjs/common";
import { getRequestContext } from "../common/context/request-context";

const COMMUNICATIONS_OPERATIONS_ROLES = new Set([
  "owner",
  "admin",
  "dispatcher",
]);

@Injectable()
export class CommunicationsOperationsAccessGuard implements CanActivate {
  canActivate(): boolean {
    const role = getRequestContext()?.role?.trim().toLowerCase();
    if (!role || !COMMUNICATIONS_OPERATIONS_ROLES.has(role)) {
      throw new ForbiddenException(
        "Communication operations require an owner, admin, or dispatcher role.",
      );
    }
    return true;
  }
}
