import { ForbiddenException } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import {
  requestContextMiddleware,
  setAuthContext,
} from "../common/context/request-context";
import { CommunicationsOperationsAccessGuard } from "./communications-operations-access.guard";
import { CommunicationsReplayAccessGuard } from "./communications-replay-access.guard";

describe("communications access guards", () => {
  const operations = new CommunicationsOperationsAccessGuard();
  const replay = new CommunicationsReplayAccessGuard();

  it.each(["owner", "admin", "dispatcher", " DISPATCHER "])(
    "allows %s to inspect communication operations",
    async (role) => {
      await expect(
        withRole(role, () => operations.canActivate()),
      ).resolves.toBe(true);
    },
  );

  it.each(["owner", "admin"])("allows %s to replay", async (role) => {
    await expect(withRole(role, () => replay.canActivate())).resolves.toBe(
      true,
    );
  });

  it.each([undefined, "technician", "viewer"])(
    "rejects %s from communication operations",
    async (role) => {
      await expect(
        withRole(role, () => operations.canActivate()),
      ).rejects.toBeInstanceOf(ForbiddenException);
    },
  );

  it.each([undefined, "dispatcher", "technician", "viewer"])(
    "rejects %s from replay",
    async (role) => {
      await expect(
        withRole(role, () => replay.canActivate()),
      ).rejects.toBeInstanceOf(ForbiddenException);
    },
  );
});

function withRole<T>(role: string | undefined, callback: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    requestContextMiddleware(
      { headers: {} } as Request,
      {} as Response,
      (() => {
        setAuthContext({ userId: "user-1", tenantId: "tenant-1", role });
        try {
          resolve(callback());
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      }) as NextFunction,
    );
  });
}
