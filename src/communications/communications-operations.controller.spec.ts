import type { NextFunction, Request, Response } from "express";
import {
  requestContextMiddleware,
  setAuthContext,
} from "../common/context/request-context";
import { CommunicationsOperationsController } from "./communications-operations.controller";
import type { SmsDeliveryService } from "./sms-delivery.service";
import { TransactionalMessageTemplateKey } from "./transactional-message-template.service";
import type { TransactionalMessagingService } from "./transactional-messaging.service";
import type { SmsEnqueueIntentService } from "./sms-enqueue-intent.service";

describe("CommunicationsOperationsController", () => {
  const delivery = {
    listDeadLetters: jest.fn(),
    metrics: jest.fn(),
    replayDeadLetter: jest.fn(),
    listHistory: jest.fn(),
  };
  const transactional = { queue: jest.fn() };
  const intents = { list: jest.fn() };
  const controller = new CommunicationsOperationsController(
    delivery as unknown as SmsDeliveryService,
    transactional as unknown as TransactionalMessagingService,
    intents as unknown as SmsEnqueueIntentService,
  );

  beforeEach(() => jest.clearAllMocks());

  it("lists enqueue intent status only for the authenticated tenant", async () => {
    intents.list.mockResolvedValue([]);
    await withContext(async () => {
      await expect(controller.enqueueIntents()).resolves.toEqual([]);
    });
    expect(intents.list).toHaveBeenCalledWith("tenant-1");
  });

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

  it("queues a template only inside the authenticated tenant", async () => {
    transactional.queue.mockResolvedValue({ id: "event-1", status: "QUEUED" });
    await withContext(async () => {
      await expect(
        controller.queueTransactional({
          jobId: "10000000-0000-4000-8000-000000000001",
          templateKey: TransactionalMessageTemplateKey.APPOINTMENT_CONFIRMED,
          idempotencyKey: "appointment-confirmed:1",
        }),
      ).resolves.toEqual({ id: "event-1", status: "QUEUED" });
    });
    expect(transactional.queue).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "tenant-1" }),
    );
  });

  it("returns tenant-scoped history with a bounded limit", async () => {
    delivery.listHistory.mockResolvedValue([]);
    await withContext(async () => {
      await expect(controller.history(undefined, 25)).resolves.toEqual([]);
    });
    expect(delivery.listHistory).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      jobId: undefined,
      limit: 25,
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
