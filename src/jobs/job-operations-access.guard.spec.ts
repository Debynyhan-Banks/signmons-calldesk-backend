import { ForbiddenException } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import {
  requestContextMiddleware,
  setAuthContext,
} from "../common/context/request-context";
import { JobOperationsAccessGuard } from "./job-operations-access.guard";

describe("JobOperationsAccessGuard", () => {
  const guard = new JobOperationsAccessGuard();

  const withRole = <T>(role: string | undefined, callback: () => T) =>
    new Promise<T>((resolve, reject) => {
      requestContextMiddleware(
        { headers: {} } as Request,
        {} as Response,
        (() => {
          setAuthContext({
            userId: "operator-1",
            tenantId: "tenant-1",
            role,
          });
          try {
            resolve(callback());
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        }) as NextFunction,
      );
    });

  it.each(["owner", "admin", " OWNER "])(
    "allows %s job completion access",
    async (role) => {
      await expect(withRole(role, () => guard.canActivate())).resolves.toBe(
        true,
      );
    },
  );

  it.each([undefined, "manager", "dispatcher", "tech", "read_only"])(
    "rejects the %s role",
    async (role) => {
      await expect(
        withRole(role, () => guard.canActivate()),
      ).rejects.toBeInstanceOf(ForbiddenException);
    },
  );
});
