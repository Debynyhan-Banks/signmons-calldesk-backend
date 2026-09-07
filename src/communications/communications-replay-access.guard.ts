import { CanActivate, ForbiddenException, Injectable } from "@nestjs/common";
import { getRequestContext } from "../common/context/request-context";

const COMMUNICATIONS_REPLAY_ROLES = new Set(["owner", "admin"]);

@Injectable()
export class CommunicationsReplayAccessGuard implements CanActivate {
  canActivate(): boolean {
    const role = getRequestContext()?.role?.trim().toLowerCase();
    if (!role || !COMMUNICATIONS_REPLAY_ROLES.has(role)) {
      throw new ForbiddenException(
        "Communication replay requires an owner or admin role.",
      );
    }
    return true;
  }
}
