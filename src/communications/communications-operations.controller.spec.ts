import type { NextFunction, Request, Response } from "express";
import {
  requestContextMiddleware,
  setAuthContext,
} from "../common/context/request-context";
import { CommunicationsOperationsController } from "./communications-operations.controller";
import type { SmsDeliveryService } from "./sms-delivery.service";

describe("CommunicationsOperationsController", () => {
  const delivery = {
    listDeadLetters: jest.fn(),
    metrics: jest.fn(),
    replayDeadLetter: jest.fn(),
  };
  const controller = new CommunicationsOperationsController(
    delivery as unknown as SmsDeliveryService,
  );

  beforeEach(() => jest.clearAllMocks());

  it("scopes privacy-safe metrics to the authenticated tenant", async () => {
    delivery.metrics.mockResolvedValue({ total: 0 });
    await withContext(async () => {
      await expect(controller.metrics("30")).resolves.toEqual({ total: 0 });
    });
    expect(delivery.metrics).toHaveBeenCalledWith("tenant-1", 30);
  });

  it("passes actor, reason, and risk acknowledgment to replay", async () => {
    delivery.replayDeadLetter.mockResolvedValue(undefined);
    await withContext(async () => {
      await expect(
        controller.replay("10000000-0000-4000-8000-000000000001", {
          acknowledgeDuplicateRisk: true,
          reason: "Provider history was reconciled by the owner.",
        }),
      ).resolves.toEqual({ status: "queued" });
    });
    expect(delivery.replayDeadLetter).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      eventId: "10000000-0000-4000-8000-000000000001",
      actorId: "user-1",
      acknowledgeDuplicateRisk: true,
      reason: "Provider history was reconciled by the owner.",
    });
  });
});

function withContext(callback: () => Promise<void>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    requestContextMiddleware(
      { headers: {} } as Request,
      {} as Response,
      (() => {
        setAuthContext({
          userId: "user-1",
          tenantId: "tenant-1",
          role: "owner",
        });
        callback().then(resolve, reject);
      }) as NextFunction,
    );
  });
}
