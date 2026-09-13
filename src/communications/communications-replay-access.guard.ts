import { CanActivate, ForbiddenException, Injectable } from "@nestjs/common";
import { getRequestContext } from "../common/context/request-context";

const COMMUNICATIONS_REPLAY_ROLES = new Set(["owner", "admin"]);

export function canReplayCommunications(role?: string): boolean {
  return COMMUNICATIONS_REPLAY_ROLES.has(role?.trim().toLowerCase() ?? "");
}

@Injectable()
export class CommunicationsReplayAccessGuard implements CanActivate {
  canActivate(): boolean {
    if (!canReplayCommunications(getRequestContext()?.role)) {
      throw new ForbiddenException(
        "Communication replay requires an owner or admin role.",
      );
    }
    return true;
  }
}
