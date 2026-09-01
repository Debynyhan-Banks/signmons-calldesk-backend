import { ForbiddenException } from "@nestjs/common";
import {
  requestContextMiddleware,
  setAuthContext,
} from "../common/context/request-context";
import { DispatchAccessGuard } from "./dispatch-access.guard";

describe("DispatchAccessGuard", () => {
  const guard = new DispatchAccessGuard();

  const inContext = (role: string, action: () => void) =>
    new Promise<void>((resolve, reject) => {
      requestContextMiddleware({ headers: {} } as never, {} as never, () => {
        try {
          setAuthContext({ userId: "user-1", tenantId: "tenant-1", role });
          action();
          resolve();
        } catch (error) {
          reject(error as Error);
        }
      });
    });

  it.each(["owner", "admin", "dispatcher"])(
    "allows %s operators",
    async (role) => {
      await inContext(role, () => expect(guard.canActivate()).toBe(true));
    },
  );

  it.each(["tech", "read_only"])("rejects %s operators", async (role) => {
    await expect(
      inContext(role, () => guard.canActivate()),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
