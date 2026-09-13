import { ForbiddenException } from "@nestjs/common";

export const CUSTOMER_SESSION_MARKER = "customerSessionVersion";

/** Legacy callers must never adopt a protected session, even with a malformed marker.
 * This is a server-owned marker, not an authorization field accepted from a caller.
 */
export function refuseProtectedCustomerSession(data: unknown) {
  if (
    data &&
    typeof data === "object" &&
    Object.prototype.hasOwnProperty.call(data, CUSTOMER_SESSION_MARKER)
  )
    throw new ForbiddenException(
      "This session requires the protected customer flow.",
    );
}
