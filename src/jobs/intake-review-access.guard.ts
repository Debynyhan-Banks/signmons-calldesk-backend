import { CanActivate, ForbiddenException, Injectable } from "@nestjs/common";
import { getRequestContext } from "../common/context/request-context";

const INTAKE_REVIEW_ROLES = new Set(["admin", "owner", "dispatcher"]);

@Injectable()
export class IntakeReviewAccessGuard implements CanActivate {
  canActivate(): boolean {
    const role = getRequestContext()?.role?.trim().toLowerCase();
    if (!role || !INTAKE_REVIEW_ROLES.has(role)) {
      throw new ForbiddenException(
        "Intake review requires an owner, admin, or dispatcher role.",
      );
    }
    return true;
  }
}
