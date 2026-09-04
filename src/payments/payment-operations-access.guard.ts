import { CanActivate, ForbiddenException, Injectable } from "@nestjs/common";
import { getRequestContext } from "../common/context/request-context";

const PAYMENT_OPERATION_ROLES = new Set(["admin", "owner", "dispatcher"]);

@Injectable()
export class PaymentOperationsAccessGuard implements CanActivate {
  canActivate(): boolean {
    const role = getRequestContext()?.role?.trim().toLowerCase();
    if (!role || !PAYMENT_OPERATION_ROLES.has(role)) {
      throw new ForbiddenException(
        "Payment operations require an owner, admin, or dispatcher role.",
      );
    }
    return true;
  }
}
