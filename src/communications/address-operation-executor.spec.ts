import { AddressOperationExecutor } from "./address-operation-executor";

describe("mock-only bounded address executor", () => {
  const input = { sessionToken: "fixture", requestId: "request" };
  const claim = {
    claimed: true,
    attemptId: "attempt",
    executionDeadline: 9000,
  };
  let execute: jest.Mock, complete: jest.Mock;
  beforeEach(() => {
    jest.useFakeTimers({ now: 1000 });
    execute = jest.fn().mockResolvedValue(claim);
    complete = jest
      .fn()
      .mockResolvedValue({ completed: true, state: "OBSERVED" });
  });
  afterEach(() => jest.useRealTimers());
  const executor = () => new AddressOperationExecutor({ execute, complete });
  it("publishes only after durable observation", async () => {
    const run = jest.fn().mockResolvedValue("candidate");
    expect(await executor().run(input, { mode: "FIXTURE_ONLY", run })).toEqual({
      status: "OBSERVED",
      value: "candidate",
    });
    expect(execute).toHaveBeenNthCalledWith(1, { ...input, action: "reserve" });
    expect(execute).toHaveBeenNthCalledWith(2, { ...input, action: "claim" });
    expect(complete).toHaveBeenCalledWith({
      ...input,
      attemptId: "attempt",
      state: "OBSERVED",
    });
  });
  it("lost claim acknowledgment never calls again", async () => {
    execute
      .mockResolvedValueOnce(claim)
      .mockRejectedValueOnce(Error("lost ack"));
    const run = jest.fn();
    expect(await executor().run(input, { mode: "FIXTURE_ONLY", run })).toEqual({
      status: "UNCERTAIN",
    });
    expect(run).not.toHaveBeenCalled();
  });
  it("orphan or duplicate claim does not invoke mock", async () => {
    execute.mockResolvedValue({ ...claim, claimed: false });
    const run = jest.fn();
    expect(await executor().run(input, { mode: "FIXTURE_ONLY", run })).toEqual({
      status: "UNCERTAIN",
    });
    expect(run).not.toHaveBeenCalled();
  });
  it("expired deadline prevents invocation", async () => {
    execute.mockResolvedValue({ ...claim, executionDeadline: 1000 });
    const run = jest.fn();
    expect(await executor().run(input, { mode: "FIXTURE_ONLY", run })).toEqual({
      status: "UNCERTAIN",
    });
    expect(run).not.toHaveBeenCalled();
  });
  it("timeout aborts, preserves uncertainty and ignores late result", async () => {
    let resolve!: (v: string) => void;
    let signal: AbortSignal | undefined;
    const run = jest.fn((s: AbortSignal) => {
      signal = s;
      return new Promise<string>((r) => {
        resolve = r;
      });
    });
    const result = executor().run(input, { mode: "FIXTURE_ONLY", run });
    await jest.advanceTimersByTimeAsync(8000);
    expect(await result).toEqual({ status: "UNCERTAIN" });
    expect(signal?.aborted).toBe(true);
    resolve("late");
    await Promise.resolve();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith({
      ...input,
      attemptId: "attempt",
      state: "UNCERTAIN",
    });
  });
  it("completion failure cannot publish candidate", async () => {
    complete.mockRejectedValue(Error("audit fail"));
    expect(
      await executor().run(input, {
        mode: "FIXTURE_ONLY",
        run: jest.fn().mockResolvedValue("private"),
      }),
    ).toEqual({ status: "UNCERTAIN" });
  });
  it("fenced completion cannot publish", async () => {
    complete.mockResolvedValue({ completed: false, state: "UNCERTAIN" });
    expect(
      await executor().run(input, {
        mode: "FIXTURE_ONLY",
        run: jest.fn().mockResolvedValue("private"),
      }),
    ).toEqual({ status: "UNCERTAIN" });
  });
  it("late synchronous result is not observed", async () => {
    const run = jest.fn(() => {
      jest.setSystemTime(9000);
      return Promise.resolve("late");
    });
    expect(await executor().run(input, { mode: "FIXTURE_ONLY", run })).toEqual({
      status: "UNCERTAIN",
    });
    expect(complete).toHaveBeenCalledWith({
      ...input,
      attemptId: "attempt",
      state: "UNCERTAIN",
    });
  });
  it.each([NaN, 0])(
    "invalid or rolled-back clock refuses publication (%s)",
    async (bad) => {
      let now = 1000;
      const model = new AddressOperationExecutor(
        { execute, complete },
        () => now,
      );
      expect(
        await model.run(input, {
          mode: "FIXTURE_ONLY",
          run: () => {
            now = bad;
            return Promise.resolve("candidate");
          },
        }),
      ).toEqual({ status: "UNCERTAIN" });
      expect(complete).toHaveBeenCalledWith({
        ...input,
        attemptId: "attempt",
        state: "UNCERTAIN",
      });
    },
  );
  it("snapshots request identity before the first asynchronous reservation", async () => {
    const mutable = { ...input };
    execute.mockImplementationOnce(() => {
      mutable.requestId = "changed";
      return Promise.resolve(claim);
    });
    await executor().run(mutable, {
      mode: "FIXTURE_ONLY",
      run: jest.fn().mockResolvedValue("candidate"),
    });
    expect(execute).toHaveBeenNthCalledWith(2, { ...input, action: "claim" });
  });
});
