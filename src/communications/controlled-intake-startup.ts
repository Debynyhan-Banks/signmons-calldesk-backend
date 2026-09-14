import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ServiceUnavailableException } from "@nestjs/common";
import { loadControlledIntakeRuntime } from "./controlled-intake-runtime";
import { parseControlledRuntimeConfig } from "./controlled-intake-runtime-config";
import { customerSessionHttp } from "./customer-session-http";
import { customerIntakePage } from "./customer-intake-page";

type Resources = NonNullable<Parameters<typeof loadControlledIntakeRuntime>[2]>;
type Assets = { html: string; script: string };
const packagedAssets = async (): Promise<Assets> => {
  const directory = resolve(__dirname, "../../customer-intake");
  const [html, script] = await Promise.all([
    readFile(resolve(directory, "customer-intake-journey.html"), "utf8"),
    readFile(resolve(directory, "customer-intake-journey.js"), "utf8"),
  ]);
  return { html, script };
};

/** Called once before parsers/listen. No network secret lookup or activation writer.
 * Environment material must be independently bound to reviewed numeric versions.
 * Optional ports are for local synthetic verification; main supplies only Nest resources.
 */
export async function prepareControlledIntakeStartup(
  env: Readonly<Record<string, string | undefined>>,
  resources: () => Omit<Resources, "secrets">,
  readAssets: () => Promise<Assets> = packagedAssets,
) {
  let runtime: Awaited<ReturnType<typeof loadControlledIntakeRuntime>>;
  const material: Record<string, Buffer | string> = {};
  try {
    const raw = env.CONTROLLED_INTAKE_RUNTIME_JSON;
    if (raw !== undefined && raw.length > 32768) throw Error();
    const envelope: unknown = raw === undefined ? undefined : JSON.parse(raw);
    const facts = {
      nodeEnv: env.NODE_ENV ?? "",
      project: env.GOOGLE_CLOUD_PROJECT ?? "",
      service: env.K_SERVICE ?? "",
      configuration: env.K_CONFIGURATION ?? "",
      revision: env.K_REVISION ?? "",
      port: env.PORT ?? "",
      flags: Object.fromEntries(
        [
          "DEV_AUTH_ENABLED",
          "SCHEDULING_ENABLED",
          "STRIPE_WEBHOOK_LIVEMODE",
          "SMS_DELIVERY_ENABLED",
          "BACKGROUND_WORKERS_ENABLED",
          "STAGING_PHONE_TEST_ENABLED",
        ].map((name) => [name, env[name]]),
      ),
    };
    const config = parseControlledRuntimeConfig(envelope, facts);
    if (!config)
      return Object.freeze({
        session: customerSessionHttp(),
        page: customerIntakePage(),
        retire: () => undefined,
      });
    const encoded = env.CONTROLLED_INTAKE_SECRETS_JSON;
    if (!encoded || encoded.length > 8192) throw Error();
    const values: unknown = JSON.parse(encoded);
    if (!values || typeof values !== "object" || Array.isArray(values))
      throw Error();
    const refs = [
      ...Object.values(config.secrets.sessionKeys),
      config.secrets.digestKey,
      config.secrets.fingerprintKey,
      config.secrets.twilioToken,
    ];
    if (Object.keys(values).sort().join() !== [...refs].sort().join())
      throw Error();
    for (const ref of refs) {
      const value = (values as Record<string, unknown>)[ref];
      const token = ref === config.secrets.twilioToken;
      if (
        typeof value !== "string" ||
        !(token ? /^[a-f0-9]{32}$/i : /^[a-f0-9]{64}$/i).test(value)
      )
        throw Error();
      material[ref] = token ? value : Buffer.from(value, "hex");
    }
    const assets = await readAssets();
    if (
      typeof assets.html !== "string" ||
      !assets.html.trim() ||
      typeof assets.script !== "string" ||
      !assets.script.trim()
    )
      throw Error();
    runtime = await loadControlledIntakeRuntime(envelope, facts, {
      ...resources(),
      secrets: material,
    });
    if (!runtime) throw Error();
    return Object.freeze({
      session: customerSessionHttp(runtime.binding),
      page: customerIntakePage(assets),
      retire: runtime.retire,
    });
  } catch {
    runtime?.retire();
    // Never attach raw JSON, secret values, filesystem paths or a cause.
    throw new ServiceUnavailableException(
      "Controlled intake startup unavailable.",
    );
  } finally {
    for (const value of Object.values(material))
      if (Buffer.isBuffer(value)) value.fill(0);
  }
}
