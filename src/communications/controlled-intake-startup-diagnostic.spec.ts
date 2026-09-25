import {
  ConsoleLogger,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { LoggingService } from "../logging/logging.service";
import {
  CONTROLLED_INTAKE_STARTUP_STAGES,
  ControlledIntakeStartupStage,
  controlledIntakeStartupFailureStage,
  markControlledIntakeStartupFailure,
  recordControlledIntakeStartupFailure,
} from "./controlled-intake-startup-diagnostic";

describe("controlled startup failure evidence", () => {
  const privateValue = "synthetic secret /private/path tenant@example.invalid";

  afterEach(() => {
    Logger.flush();
    jest.restoreAllMocks();
  });

  it("emits through the actual buffered Nest logger without flushing other records", () => {
    const sink = jest
      .spyOn(ConsoleLogger.prototype, "warn")
      .mockImplementation();
    const logging = new LoggingService();
    Logger.attachBuffer();
    logging.warn(privateValue);
    expect(sink).not.toHaveBeenCalled();
    const error = markControlledIntakeStartupFailure(
      new Error(privateValue),
      "CONFIGURATION",
    );
    recordControlledIntakeStartupFailure(logging, error);
    expect(sink.mock.calls).toEqual([
      [
        "CONTROLLED_INTAKE_STARTUP_FAILURE stage=CONFIGURATION",
        undefined,
        "CallDeskLogger",
      ],
    ]);
    logging.warn("later buffered closeout record");
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it("restores buffering and reaches close after a real logger sink throws", async () => {
    const sink = jest
      .spyOn(ConsoleLogger.prototype, "warn")
      .mockImplementation(() => {
        throw Error(privateValue);
      });
    const logging = new LoggingService();
    const close = jest.fn();
    const error = markControlledIntakeStartupFailure(
      new ServiceUnavailableException("Controlled intake startup unavailable."),
      "RUNTIME_APPROVAL",
    );
    Logger.attachBuffer();
    const refused = Promise.reject(error).catch(async (failure: unknown) => {
      recordControlledIntakeStartupFailure(logging, failure);
      await close();
      throw failure;
    });
    await expect(refused).rejects.toBe(error);
    expect(close).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(() => logging.warn("buffered after logger failure")).not.toThrow();
    expect(sink).toHaveBeenCalledTimes(1);
    sink.mockImplementation();
  });

  it.each(CONTROLLED_INTAKE_STARTUP_STAGES)(
    "records only the fixed %s stage, without serializing the error",
    (stage) => {
      const error = new Error(privateValue);
      Object.defineProperty(error, "cause", {
        get: () => {
          throw Error("must not inspect the cause");
        },
      });
      const warn = jest.fn();
      markControlledIntakeStartupFailure(error, stage);
      recordControlledIntakeStartupFailure({ warn }, error);
      expect(warn.mock.calls).toEqual([
        [`CONTROLLED_INTAKE_STARTUP_FAILURE stage=${stage}`],
      ]);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(privateValue);
    },
  );

  it("keeps the public exception unchanged and preserves the first stage", () => {
    const error = new ServiceUnavailableException(
      "Controlled runtime unavailable.",
    );
    const response = error.getResponse();
    const keys = Object.keys(error);
    expect(markControlledIntakeStartupFailure(error, "RUNTIME_AUTHORITY")).toBe(
      error,
    );
    markControlledIntakeStartupFailure(error, "RUNTIME_LOADING");
    expect(controlledIntakeStartupFailureStage(error)).toBe(
      "RUNTIME_AUTHORITY",
    );
    expect(error.getResponse()).toEqual(response);
    expect(Object.keys(error)).toEqual(keys);
  });

  it("ignores forged stages and unmarked or primitive failures", () => {
    const warn = jest.fn();
    const forged = { stage: "CONFIGURATION", message: privateValue };
    const invalid = markControlledIntakeStartupFailure(
      new Error(privateValue),
      privateValue as ControlledIntakeStartupStage,
    );
    for (const error of [
      undefined,
      null,
      privateValue,
      new Error(privateValue),
      forged,
      invalid,
    ]) {
      recordControlledIntakeStartupFailure({ warn }, error);
      expect(controlledIntakeStartupFailureStage(error)).toBeUndefined();
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it("cannot let a failing logger replace refusal or interrupt closeout", () => {
    const error = markControlledIntakeStartupFailure(
      new Error(privateValue),
      "INJECTED_MATERIAL",
    );
    const logging = {
      warn: jest.fn(() => {
        throw Error(privateValue);
      }),
    };
    expect(() =>
      recordControlledIntakeStartupFailure(logging, error),
    ).not.toThrow();
    expect(logging.warn).toHaveBeenCalledTimes(1);
    expect(controlledIntakeStartupFailureStage(error)).toBe(
      "INJECTED_MATERIAL",
    );
  });
});
