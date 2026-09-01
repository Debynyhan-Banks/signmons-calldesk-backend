import { CanActivate, ForbiddenException, Injectable } from "@nestjs/common";
import { getRequestContext } from "../common/context/request-context";

const URGENCY_REVIEW_ROLES = new Set(["admin", "owner", "dispatcher"]);

@Injectable()
export class UrgencyReviewAccessGuard implements CanActivate {
  canActivate(): boolean {
    const role = getRequestContext()?.role?.trim().toLowerCase();
    if (!role || !URGENCY_REVIEW_ROLES.has(role)) {
      throw new ForbiddenException(
        "Urgency review requires an owner, admin, or dispatcher role.",
      );
    }
    return true;
  }
}
