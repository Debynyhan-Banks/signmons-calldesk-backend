import { loadControlledIntakeRuntime } from "./controlled-intake-runtime";
import { RuntimeFacts } from "./controlled-intake-runtime-config";
import * as configModule from "./controlled-intake-runtime-config";
import { ControlledIntakeAuthority } from "./controlled-intake-authority";
import {
  controlledIntakeStartupFailureStage,
  ControlledIntakeStartupStage,
} from "./controlled-intake-startup-diagnostic";
describe("controlled runtime startup refusal", () => {
  const facts: RuntimeFacts = {
    nodeEnv: "production",
    project: "signmons",
    service: "staging",
    configuration: "staging",
    revision: "r1",
    port: "8080",
    flags: {},
  };
  afterEach(() => jest.restoreAllMocks());
  it("does not touch resources when absent or explicitly disabled", async () => {
    const resources = new Proxy(
      {},
      {
        get: () => {
          throw Error("Unexpected resource access");
        },
      },
    ) as never;
    expect(
      await loadControlledIntakeRuntime(undefined, facts, resources),
    ).toBeUndefined();
    expect(
      await loadControlledIntakeRuntime({ enabled: false }, facts, resources),
    ).toBeUndefined();
  });
  it("rejects incomplete enabled envelopes before accessing resources", async () => {
    const get = jest.fn(() => {
      throw Error("Unexpected private resource");
    });
    const error = await loadControlledIntakeRuntime(
      { enabled: true },
      facts,
      new Proxy({}, { get }) as never,
    ).catch((failure: unknown) => failure);
    expect(error).toMatchObject({
      message: "Controlled runtime configuration unavailable.",
    });
    expect(controlledIntakeStartupFailureStage(error)).toBe(
      "RUNTIME_CONFIGURATION",
    );
    expect(get).not.toHaveBeenCalled();
  });

  // Isolate construction boundaries here; the disposable runtime harness uses
  // the real parser, approval/current-authority transactions and services.
  const seam = () => {
    const secrets = {
      sessionKeys: { active: "session" },
      activeKeyId: "active",
      digestKey: "digest",
      fingerprintKey: "fingerprint",
      fingerprintKeyVersion: "synthetic",
      twilioToken: "token",
    };
    const config = {
      project: "signmons",
      activation: { allowedServiceCategoryIds: ["category"] },
      secrets,
    };
    jest
      .spyOn(configModule, "parseControlledRuntimeConfig")
      .mockReturnValue(config as never);
    const transaction = jest.fn().mockResolvedValue(undefined);
    const warn = jest.fn();
    const verifyFactory = jest.fn();
    const token = jest.fn();
    const fetch = jest.fn();
    const resources = {
      prisma: { $transaction: transaction },
      cipher: { encrypt: jest.fn(), decrypt: jest.fn() },
      logging: { warn },
      secrets: {
        session: Buffer.alloc(32, 1),
        digest: Buffer.alloc(32, 2),
        fingerprint: Buffer.alloc(32, 3),
        token: "a".repeat(32),
      },
      verifyFactory,
      googlePorts: { token, fetch },
    };
    return {
      config,
      resources,
      transaction,
      warn,
      verifyFactory,
      token,
      fetch,
    };
  };

  it.each<ControlledIntakeStartupStage>([
    "RUNTIME_RESOURCES",
    "RUNTIME_APPROVAL",
    "RUNTIME_KEY_MATERIAL",
    "RUNTIME_SERVICES",
    "RUNTIME_AUTHORITY",
    "RUNTIME_BINDING",
  ])(
    "marks %s without raw causes, provider actions or direct logging",
    async (stage) => {
      const test = seam();
      const privateCause = new Error("SYNTHETIC_PRIVATE_SECRET_PATH");
      if (stage === "RUNTIME_APPROVAL")
        test.transaction.mockRejectedValueOnce(privateCause);
      if (stage === "RUNTIME_KEY_MATERIAL")
        test.resources.secrets.token = "invalid";
      if (stage === "RUNTIME_SERVICES")
        test.config.secrets.activeKeyId = "missing";
      if (stage === "RUNTIME_AUTHORITY" || stage === "RUNTIME_BINDING")
        jest
          .spyOn(ControlledIntakeAuthority.prototype, "issue")
          .mockReturnValue({});
      if (stage === "RUNTIME_AUTHORITY")
        test.transaction
          .mockReset()
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(privateCause);
      if (stage === "RUNTIME_BINDING")
        Object.defineProperty(test.config, "phone", {
          get: () => {
            throw privateCause;
          },
        });
      const error = await loadControlledIntakeRuntime(
        {},
        facts,
        stage === "RUNTIME_RESOURCES" ? undefined : (test.resources as never),
      ).catch((failure: unknown) => failure);
      expect(error).toMatchObject({
        message: "Controlled runtime unavailable.",
      });
      expect(controlledIntakeStartupFailureStage(error)).toBe(stage);
      expect(error).not.toBe(privateCause);
      expect(error).not.toHaveProperty("cause");
      expect(error).not.toHaveProperty("stage");
      expect(JSON.stringify(error)).not.toContain(
        "SYNTHETIC_PRIVATE_SECRET_PATH",
      );
      expect(test.warn).not.toHaveBeenCalled();
      expect(test.verifyFactory).not.toHaveBeenCalled();
      expect(test.token).not.toHaveBeenCalled();
      expect(test.fetch).not.toHaveBeenCalled();
    },
  );
});
