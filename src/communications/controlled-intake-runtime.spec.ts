import { loadControlledIntakeRuntime } from "./controlled-intake-runtime";
import { RuntimeFacts } from "./controlled-intake-runtime-config";
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
    await expect(
      loadControlledIntakeRuntime(
        { enabled: true },
        facts,
        new Proxy({}, { get }) as never,
      ),
    ).rejects.toThrow("unavailable");
    expect(get).not.toHaveBeenCalled();
  });
});
