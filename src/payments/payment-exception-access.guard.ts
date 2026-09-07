import { CanActivate, ForbiddenException, Injectable } from "@nestjs/common";
import { getRequestContext } from "../common/context/request-context";

const PAYMENT_EXCEPTION_ROLES = new Set(["owner", "admin"]);

@Injectable()
export class PaymentExceptionAccessGuard implements CanActivate {
  canActivate(): boolean {
    const role = getRequestContext()?.role?.trim().toLowerCase();
    if (!role || !PAYMENT_EXCEPTION_ROLES.has(role)) {
      throw new ForbiddenException(
        "Payment exceptions require an owner or admin role.",
      );
    }
    return true;
  }
}
