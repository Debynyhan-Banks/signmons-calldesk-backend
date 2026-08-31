import { ForbiddenException } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import {
  requestContextMiddleware,
  setAuthContext,
} from "../common/context/request-context";
import { ReportingAccessGuard } from "./reporting-access.guard";

describe("ReportingAccessGuard", () => {
  const guard = new ReportingAccessGuard();

  const withRole = <T>(role: string | undefined, callback: () => T) =>
    new Promise<T>((resolve, reject) => {
      requestContextMiddleware(
        { headers: {} } as Request,
        {} as Response,
        (() => {
          setAuthContext({
            userId: "user-1",
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

  it.each(["owner", "admin", "manager", " MANAGER "])(
    "allows %s reporting access",
    async (role) => {
      await expect(withRole(role, () => guard.canActivate())).resolves.toBe(
        true,
      );
    },
  );

  it.each([undefined, "dispatcher", "technician", "viewer"])(
    "rejects the %s role",
    async (role) => {
      await expect(
        withRole(role, () => guard.canActivate()),
      ).rejects.toBeInstanceOf(ForbiddenException);
    },
  );
});
