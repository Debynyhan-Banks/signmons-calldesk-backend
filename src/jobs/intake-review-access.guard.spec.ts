import { ForbiddenException } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import {
  requestContextMiddleware,
  setAuthContext,
} from "../common/context/request-context";
import { IntakeReviewAccessGuard } from "./intake-review-access.guard";

describe("IntakeReviewAccessGuard", () => {
  const guard = new IntakeReviewAccessGuard();

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

  it.each(["owner", "admin", "dispatcher", " DISPATCHER "])(
    "allows %s intake-review access",
    async (role) => {
      await expect(withRole(role, () => guard.canActivate())).resolves.toBe(
        true,
      );
    },
  );

  it.each([undefined, "manager", "tech", "read_only"])(
    "rejects the %s role",
    async (role) => {
      await expect(
        withRole(role, () => guard.canActivate()),
      ).rejects.toBeInstanceOf(ForbiddenException);
    },
  );
});
