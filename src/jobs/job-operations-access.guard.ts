import { CanActivate, ForbiddenException, Injectable } from "@nestjs/common";
import { getRequestContext } from "../common/context/request-context";

const JOB_OPERATIONS_ROLES = new Set(["admin", "owner"]);

@Injectable()
export class JobOperationsAccessGuard implements CanActivate {
  canActivate(): boolean {
    const role = getRequestContext()?.role?.trim().toLowerCase();
    if (!role || !JOB_OPERATIONS_ROLES.has(role)) {
      throw new ForbiddenException(
        "Job completion requires an owner or admin role.",
      );
    }
    return true;
  }
}
