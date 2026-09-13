import { CallLogCleanupService } from "../logging/call-log.cleanup";
import { SmsDeliveryWorker } from "../communications/sms-delivery.worker";
import { envValidationSchema } from "./env.validation";

describe("revision-local background worker switch", () => {
  const original = process.env.BACKGROUND_WORKERS_ENABLED;
  afterEach(() => {
    if (original === undefined) delete process.env.BACKGROUND_WORKERS_ENABLED;
    else process.env.BACKGROUND_WORKERS_ENABLED = original;
  });

  function harness() {
    const prisma = {
      communicationContent: {
        findMany: jest.fn().mockResolvedValue([
          {
            tenantId: "fixture",
            payload: { sessionId: "idle" },
            createdAt: new Date(0),
          },
        ]),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      communicationEvent: { create: jest.fn().mockResolvedValue({}) },
    };
    const intents = { processDue: jest.fn().mockResolvedValue(0) };
    const delivery = { processDue: jest.fn().mockResolvedValue(0) };
    const logging = { warn: jest.fn(), error: jest.fn() };
    const cleanup = new CallLogCleanupService(prisma as never);
    const worker = new SmsDeliveryWorker(
      delivery as never,
      logging as never,
      intents as never,
    );
    return { prisma, intents, delivery, logging, cleanup, worker };
  }

  it.each(["false", "FALSE", "", "typo"])(
    "makes zero collaborator calls for %j, even on repeated ticks",
    async (value) => {
      process.env.BACKGROUND_WORKERS_ENABLED = value;
      const h = harness();
      for (let tick = 0; tick < 2; tick++) {
        await h.cleanup.cleanupIdleSessions();
        await h.worker.processDue();
      }
      for (const mock of [
        h.prisma.communicationContent.findMany,
        h.prisma.communicationContent.findFirst,
        h.prisma.communicationEvent.create,
        h.intents.processDue,
        h.delivery.processDue,
        h.logging.warn,
        h.logging.error,
      ]) {
        expect(mock).not.toHaveBeenCalled();
      }
    },
  );

  it.each([undefined, "true"])(
    "preserves recovery, delivery and cleanup writes with %j",
    async (value) => {
      if (value === undefined) delete process.env.BACKGROUND_WORKERS_ENABLED;
      else process.env.BACKGROUND_WORKERS_ENABLED = value;
      const h = harness();
      await h.cleanup.cleanupIdleSessions();
      await h.worker.processDue();
      expect(h.prisma.communicationEvent.create).toHaveBeenCalledTimes(1);
      expect(h.intents.processDue).toHaveBeenCalledTimes(1);
      expect(h.delivery.processDue).toHaveBeenCalledTimes(1);
      expect(h.intents.processDue.mock.invocationCallOrder[0]).toBeLessThan(
        h.delivery.processDue.mock.invocationCallOrder[0],
      );
    },
  );

  it.each(["true", "false", "FALSE", "", "typo"])(
    "validates only exact boolean strings: %j",
    (value) => {
      const result = envValidationSchema.validate({
        NODE_ENV: "test",
        BACKGROUND_WORKERS_ENABLED: value,
      });
      expect(Boolean(result.error)).toBe(!["true", "false"].includes(value));
    },
  );
});
