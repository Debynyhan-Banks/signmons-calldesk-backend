import { SmsDeliveryWorker } from "./sms-delivery.worker";

describe("SmsDeliveryWorker intent recovery", () => {
  function harness() {
    const delivery = { processDue: jest.fn().mockResolvedValue(0) };
    const intents = { processDue: jest.fn().mockResolvedValue(0) };
    const logging = { warn: jest.fn(), error: jest.fn() };
    const worker = new SmsDeliveryWorker(
      delivery as never,
      logging as never,
      intents as never,
    );
    return { delivery, intents, logging, worker };
  }
  it("recovers durable intents before draining queued delivery", async () => {
    const { delivery, intents, worker } = harness();
    await worker.processDue();
    expect(intents.processDue.mock.invocationCallOrder[0]).toBeLessThan(
      delivery.processDue.mock.invocationCallOrder[0],
    );
  });
  it.each([false, true])(
    "does not block existing delivery when recovery fails (logging failure %s)",
    async (loggerFails) => {
      const { delivery, intents, logging, worker } = harness();
      intents.processDue.mockRejectedValue(new Error("private recovery error"));
      if (loggerFails)
        logging.warn.mockImplementation(() => {
          throw new Error("logging unavailable");
        });
      await worker.processDue();
      expect(delivery.processDue).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(logging.warn.mock.calls)).not.toContain("private");
    },
  );
  it("does not overlap worker runs while recovery is pending", async () => {
    const { delivery, intents, worker } = harness();
    let release!: (value: number) => void;
    intents.processDue.mockReturnValue(
      new Promise<number>((resolve) => {
        release = resolve;
      }),
    );
    const first = worker.processDue();
    await worker.processDue();
    expect(intents.processDue).toHaveBeenCalledTimes(1);
    release(0);
    await first;
    expect(delivery.processDue).toHaveBeenCalledTimes(1);
  });
});
