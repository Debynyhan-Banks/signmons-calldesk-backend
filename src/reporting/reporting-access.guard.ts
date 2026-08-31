import { CanActivate, ForbiddenException, Injectable } from "@nestjs/common";
import { getRequestContext } from "../common/context/request-context";

const REPORTING_ROLES = new Set(["admin", "manager", "owner"]);

@Injectable()
export class ReportingAccessGuard implements CanActivate {
  canActivate(): boolean {
    const role = getRequestContext()?.role?.trim().toLowerCase();
    if (!role || !REPORTING_ROLES.has(role)) {
      throw new ForbiddenException(
        "Reporting access requires an owner, admin or manager role.",
      );
    }
    return true;
  }
}
