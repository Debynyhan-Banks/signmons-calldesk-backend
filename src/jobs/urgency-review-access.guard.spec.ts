import { ForbiddenException } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import {
  requestContextMiddleware,
  setAuthContext,
} from "../common/context/request-context";
import { UrgencyReviewAccessGuard } from "./urgency-review-access.guard";

describe("UrgencyReviewAccessGuard", () => {
  const guard = new UrgencyReviewAccessGuard();
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

  it.each(["owner", "admin", "dispatcher", " OWNER "])(
    "allows %s urgency review access",
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
