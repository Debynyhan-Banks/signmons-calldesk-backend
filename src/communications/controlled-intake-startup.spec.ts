import { readFileSync } from "node:fs";
import * as files from "node:fs/promises";
import * as configModule from "./controlled-intake-runtime-config";
import * as runtimeModule from "./controlled-intake-runtime";
import { prepareControlledIntakeStartup } from "./controlled-intake-startup";

jest.mock("node:fs/promises", () => ({
  ...jest.requireActual<typeof import("node:fs/promises")>("node:fs/promises"),
  readFile: jest.fn(),
}));

describe("controlled intake startup registration", () => {
  afterEach(() => jest.restoreAllMocks());
  const resources = jest.fn(() => ({}) as never);
  const assets = jest.fn(() =>
    Promise.resolve({
      html: "<html></html>",
      script: "// page",
    }),
  );
  beforeEach(() => {
    resources.mockClear();
    assets.mockClear();
  });
  const refs = {
    sessionKeys: { a: "session/1" },
    digestKey: "digest/1",
    fingerprintKey: "fingerprint/1",
    twilioToken: "token/1",
  };
  const secretValues = {
    "session/1": "11".repeat(32),
    "digest/1": "22".repeat(32),
    "fingerprint/1": "33".repeat(32),
    "token/1": "44".repeat(16),
  };
  // Unit-test only the startup seam. Real envelope/current authority/services are
  // exercised without positive mocks by verify-loaded-intake-browser.mjs.
  const validSeam = () => {
    const parse = jest
      .spyOn(configModule, "parseControlledRuntimeConfig")
      .mockReturnValue({ secrets: refs } as never);
    const retire = jest.fn();
    const load = jest
      .spyOn(runtimeModule, "loadControlledIntakeRuntime")
      .mockResolvedValue({ binding: undefined, retire } as never);
    return {
      parse,
      load,
      retire,
      env: {
        CONTROLLED_INTAKE_RUNTIME_JSON: '{"enabled":true}',
        CONTROLLED_INTAKE_SECRETS_JSON: JSON.stringify(secretValues),
      },
    };
  };
  it.each([undefined, '{"enabled":false}'])(
    "leaves both routes closed without touching resources, secrets or assets (%s)",
    async (raw) => {
      const env = { CONTROLLED_INTAKE_RUNTIME_JSON: raw };
      Object.defineProperty(env, "CONTROLLED_INTAKE_SECRETS_JSON", {
        get: () => {
          throw Error("must not read secret");
        },
      });
      const startup = await prepareControlledIntakeStartup(
        env,
        resources,
        assets,
      );
      for (const [handler, url] of [
        [startup.session, "/customer-session/start"],
        [startup.page, "/customer-intake"],
      ] as const) {
        const res = {
          set: jest.fn().mockReturnThis(),
          status: jest.fn().mockReturnThis(),
          end: jest.fn(),
          json: jest.fn(),
        };
        handler({ url, method: "GET" } as never, res as never, jest.fn());
        expect(res.status).toHaveBeenCalledWith(503);
      }
      expect(resources).not.toHaveBeenCalled();
      expect(assets).not.toHaveBeenCalled();
    },
  );
  it.each(["", "private-invalid-json", '{"enabled":true}', "x".repeat(32769)])(
    "sanitizes malformed/incomplete configuration before resources",
    async (raw) => {
      await expect(
        prepareControlledIntakeStartup(
          { CONTROLLED_INTAKE_RUNTIME_JSON: raw },
          resources,
          assets,
        ),
      ).rejects.toThrow("Controlled intake startup unavailable.");
      expect(resources).not.toHaveBeenCalled();
      expect(assets).not.toHaveBeenCalled();
    },
  );
  it("maps only explicit runtime facts, copies key bytes and zeroizes temporary buffers", async () => {
    const { env, parse, load } = validSeam();
    let captured: Buffer | undefined;
    load.mockImplementation((_v, _f, r) => {
      captured = r!.secrets["session/1"] as Buffer;
      expect(captured.equals(Buffer.alloc(32, 0x11))).toBe(true);
      return Promise.resolve({
        binding: undefined,
        retire: jest.fn(),
      } as never);
    });
    await prepareControlledIntakeStartup(
      {
        ...env,
        NODE_ENV: "production",
        GOOGLE_CLOUD_PROJECT: "signmons",
        K_SERVICE: "service",
        K_CONFIGURATION: "configuration",
        K_REVISION: "revision",
        PORT: "8080",
        DEV_AUTH_ENABLED: "false",
      },
      resources,
      assets,
    );
    expect(parse.mock.calls[0][1]).toMatchObject({
      nodeEnv: "production",
      project: "signmons",
      service: "service",
      configuration: "configuration",
      revision: "revision",
      port: "8080",
      flags: { DEV_AUTH_ENABLED: "false", SMS_DELIVERY_ENABLED: undefined },
    });
    expect(captured!.equals(Buffer.alloc(32))).toBe(true);
    expect(resources).toHaveBeenCalledTimes(1);
    expect(assets).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1);
  });
  it.each([
    undefined,
    "private malformed",
    "[]",
    "{}",
    JSON.stringify({ ...secretValues, extra: "secret" }),
    JSON.stringify({ ...secretValues, "session/1": "z".repeat(64) }),
  ])(
    "rejects missing/invalid/extra private material before resources",
    async (encoded) => {
      const { env, load } = validSeam();
      await expect(
        prepareControlledIntakeStartup(
          { ...env, CONTROLLED_INTAKE_SECRETS_JSON: encoded },
          resources,
          assets,
        ),
      ).rejects.toThrow("Controlled intake startup unavailable.");
      expect(resources).not.toHaveBeenCalled();
      expect(assets).not.toHaveBeenCalled();
      expect(load).not.toHaveBeenCalled();
    },
  );
  it("refuses missing or empty packaged assets before constructing runtime", async () => {
    const { env, load } = validSeam();
    await expect(
      prepareControlledIntakeStartup(env, resources, () =>
        Promise.reject(Error("private path")),
      ),
    ).rejects.toThrow("Controlled intake startup unavailable.");
    await expect(
      prepareControlledIntakeStartup(env, resources, () =>
        Promise.resolve({
          html: "",
          script: "x",
        }),
      ),
    ).rejects.toThrow("Controlled intake startup unavailable.");
    expect(load).not.toHaveBeenCalled();
    expect(resources).not.toHaveBeenCalled();
  });
  it("reads exactly the two fixed packaged assets, never an environment path", async () => {
    const { env } = validSeam();
    const read = jest
      .mocked(files.readFile)
      .mockResolvedValue("packaged bytes");
    await prepareControlledIntakeStartup(
      { ...env, CONTROLLED_INTAKE_ASSET_PATH: "/not-allowed" },
      resources,
    );
    expect(read.mock.calls.map((call) => call[0])).toEqual([
      expect.stringMatching(
        /\/customer-intake\/customer-intake-journey\.html$/,
      ),
      expect.stringMatching(/\/customer-intake\/customer-intake-journey\.js$/),
    ]);
  });
  it("sanitizes downstream failure and clears temporary material", async () => {
    const { env, load } = validSeam();
    let captured: Buffer | undefined;
    load.mockImplementation((_v, _f, r) => {
      captured = r!.secrets["digest/1"] as Buffer;
      return Promise.reject(Error("private secret or path"));
    });
    await expect(
      prepareControlledIntakeStartup(env, resources, assets),
    ).rejects.toThrow("Controlled intake startup unavailable.");
    expect(captured!.equals(Buffer.alloc(32))).toBe(true);
  });
  it("main awaits startup before mount, parsers and listener without synthetic ports", () => {
    const main = readFileSync("src/main.ts", "utf8");
    const startup = main.indexOf("await prepareControlledIntakeStartup(");
    expect(startup).toBeGreaterThan(0);
    expect(main.indexOf("app.use(intake.session)")).toBeGreaterThan(startup);
    expect(main.indexOf("app.enableCors(")).toBeGreaterThan(
      main.indexOf("app.use(intake.page)"),
    );
    expect(main.indexOf("await app.listen(port)")).toBeGreaterThan(startup);
    expect(main).not.toMatch(/verifyFactory|googlePorts|fixtures\//);
  });
});
