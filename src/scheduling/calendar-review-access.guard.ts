import { CanActivate, ForbiddenException, Injectable } from "@nestjs/common";
import { getRequestContext } from "../common/context/request-context";

@Injectable()
export class CalendarReviewAccessGuard implements CanActivate {
  canActivate(): boolean {
    const role = getRequestContext()?.role?.trim().toLowerCase();
    if (!role || !["owner", "admin"].includes(role)) {
      throw new ForbiddenException(
        "Calendar review requires an owner or admin role.",
      );
    }
    return true;
  }
}
