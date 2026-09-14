import { ServiceUnavailableException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { parseControlledIntakeActivation } from "./controlled-intake-authority";
import {
  ControlledCustomerAdmission,
  ControlledCustomerAdmissionPolicy,
} from "./controlled-customer-admission";
import { SharedBrowserPolicy } from "./shared-customer-browser-budget";
import { ControlledAddressOperationPolicy } from "./address-operation-ledger";

export type RuntimeFacts = {
  nodeEnv: string;
  project: string;
  service: string;
  configuration: string;
  revision: string;
  port: string;
  flags: Record<string, string | undefined>;
};
const seals = new WeakMap<
  object,
  { origin: string; startsAt: number; expiresAt: number }
>();
const fail = () =>
  new ServiceUnavailableException(
    "Controlled runtime configuration unavailable.",
  );
const object = (v: unknown): Record<string, unknown> => {
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.getPrototypeOf(v) !== Object.prototype
  )
    throw fail();
  return v as Record<string, unknown>;
};
const exact = (v: Record<string, unknown>, keys: string) => {
  if (Object.keys(v).sort().join() !== keys.split(",").sort().join())
    throw fail();
};
const copy = (v: unknown): unknown => {
  if (v === null || ["string", "number", "boolean"].includes(typeof v))
    return v;
  if (Array.isArray(v)) return v.map(copy);
  return Object.fromEntries(
    Object.entries(object(v)).map(([key, value]) => [key, copy(value)]),
  );
};
const label = (v: unknown): v is string =>
  typeof v === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(v);
const uuid = (v: unknown) =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    v,
  );
export function managedRuntimeOrigin(
  seal: object | undefined,
  now = Date.now(),
) {
  const bound = seal && seals.get(seal);
  return bound &&
    Number.isSafeInteger(now) &&
    now >= bound.startsAt &&
    now < bound.expiresAt
    ? bound.origin
    : undefined;
}

/** Pure startup validation. No environment reads, keys, clients or activation.
 * Facts are supplied only by the reviewed loader, never from HTTP. */
export function parseControlledRuntimeConfig(
  value: unknown,
  facts: RuntimeFacts,
  now = Date.now(),
) {
  if (value === undefined || value === null) return undefined;
  try {
    const v = object(copy(value));
    if (v.enabled === false) return undefined;
    exact(
      v,
      "version,enabled,project,service,configuration,revision,origin,activation,phone,addressAccountId,addressPolicy,browserBudget,secrets",
    );
    if (
      v.version !== 1 ||
      v.enabled !== true ||
      ![v.project, v.service, v.configuration, v.revision].every(label) ||
      facts.nodeEnv !== "production" ||
      facts.port !== "8080" ||
      v.project !== facts.project ||
      v.service !== facts.service ||
      v.configuration !== facts.configuration ||
      v.revision !== facts.revision
    )
      throw fail();
    for (const flag of [
      "DEV_AUTH_ENABLED",
      "SCHEDULING_ENABLED",
      "STRIPE_WEBHOOK_LIVEMODE",
      "SMS_DELIVERY_ENABLED",
      "BACKGROUND_WORKERS_ENABLED",
      "STAGING_PHONE_TEST_ENABLED",
    ])
      if (facts.flags[flag] !== "false") throw fail();
    const activation = parseControlledIntakeActivation(v.activation);
    const from = Date.parse(activation.validFrom),
      until = Date.parse(activation.validUntil);
    if (
      !activation.enabled ||
      v.origin !== activation.origin ||
      !Number.isSafeInteger(now) ||
      now < from ||
      now >= until ||
      until - from > 900000
    )
      throw fail();
    const phone = new ControlledCustomerAdmission(
      object(v.phone) as ControlledCustomerAdmissionPolicy,
    ).validatedPolicy();
    if (
      phone.packetId !== activation.packetId ||
      phone.tenantId !== activation.tenantId ||
      phone.startsAt !== from ||
      phone.expiresAt !== until
    )
      throw fail();
    const b = object(v.browserBudget);
    exact(
      b,
      "packetId,tenantId,validFrom,validUntil,total,tenant,session,starts,inFlight",
    );
    if (
      b.packetId !== activation.packetId ||
      b.tenantId !== activation.tenantId ||
      b.validFrom !== from ||
      b.validUntil !== until ||
      ![b.total, b.tenant, b.session, b.starts, b.inFlight].every(
        (n) =>
          typeof n === "number" &&
          Number.isSafeInteger(n) &&
          n > 0 &&
          n <= 1000,
      ) ||
      Number(b.tenant) > Number(b.total) ||
      Number(b.session) > Number(b.tenant) ||
      b.starts !== 1 ||
      Number(b.inFlight) > Number(b.total)
    )
      throw fail();
    const a = object(v.addressPolicy);
    exact(
      a,
      "mode,approved,version,rateVersion,validUntil,costMicros,account,tenant,session,execution",
    );
    if (
      !uuid(v.addressAccountId) ||
      a.mode !== "CONTROLLED_ADDRESS_V1" ||
      a.execution !== "CONTROLLED_8S_2_ATTEMPTS" ||
      a.approved !== true ||
      !label(a.version) ||
      !label(a.rateVersion) ||
      a.validUntil !== until ||
      typeof a.costMicros !== "number" ||
      !Number.isSafeInteger(a.costMicros) ||
      a.costMicros <= 0
    )
      throw fail();
    for (const key of ["account", "tenant", "session"]) {
      const limit = object(a[key]);
      exact(limit, "micros,requests");
      if (
        ![limit.micros, limit.requests].every(
          (n) => typeof n === "number" && Number.isSafeInteger(n) && n > 0,
        ) ||
        Number(limit.micros) < a.costMicros
      )
        throw fail();
      Object.freeze(limit);
    }
    if (object(a.session).requests !== 2) throw fail();
    const s = object(v.secrets);
    exact(
      s,
      "activeKeyId,sessionKeys,digestKey,twilioToken,fingerprintKey,fingerprintKeyVersion",
    );
    const keys = object(s.sessionKeys);
    const reference = (r: unknown) =>
      typeof r === "string" &&
      r.startsWith(`projects/${String(v.project)}/secrets/`) &&
      /^projects\/[a-zA-Z0-9_-]+\/secrets\/[a-zA-Z0-9_-]+\/versions\/[1-9][0-9]*$/.test(
        r,
      );
    if (
      typeof s.activeKeyId !== "string" ||
      !/^[a-zA-Z0-9_-]{1,32}$/.test(s.activeKeyId) ||
      !Object.prototype.hasOwnProperty.call(keys, s.activeKeyId) ||
      Object.keys(keys).length < 1 ||
      Object.keys(keys).length > 2 ||
      !Object.keys(keys).every((k) => /^[a-zA-Z0-9_-]{1,32}$/.test(k)) ||
      ![
        ...Object.values(keys),
        s.digestKey,
        s.twilioToken,
        s.fingerprintKey,
      ].every(reference) ||
      typeof s.fingerprintKeyVersion !== "string" ||
      !/^[a-zA-Z0-9_-]{1,32}$/.test(s.fingerprintKeyVersion) ||
      new Set([
        ...Object.values(keys),
        s.digestKey,
        s.twilioToken,
        s.fingerprintKey,
      ]).size !==
        Object.keys(keys).length + 3
    )
      throw fail();
    // A different version of another purpose's secret is still key reuse.
    const fingerprintResource = (s.fingerprintKey as string).split(
      "/versions/",
    )[0];
    if (
      [...Object.values(keys), s.digestKey, s.twilioToken].some(
        (r) => (r as string).split("/versions/")[0] === fingerprintResource,
      )
    )
      throw fail();
    const security = Object.freeze({
      mode: "CLOUD_RUN_MANAGED_HTTPS_V1" as const,
    });
    seals.set(security, {
      origin: activation.origin,
      startsAt: from,
      expiresAt: until,
    });
    return Object.freeze({
      project: v.project,
      service: v.service,
      configuration: v.configuration,
      revision: v.revision,
      origin: activation.origin,
      activation,
      phone,
      browserBudget: Object.freeze(b) as Readonly<SharedBrowserPolicy>,
      addressAccountId: v.addressAccountId as string,
      addressPolicy: Object.freeze(
        a,
      ) as Readonly<ControlledAddressOperationPolicy>,
      secrets: Object.freeze({
        activeKeyId: s.activeKeyId,
        sessionKeys: Object.freeze(keys) as Readonly<Record<string, string>>,
        digestKey: s.digestKey as string,
        twilioToken: s.twilioToken as string,
        fingerprintKey: s.fingerprintKey as string,
        fingerprintKeyVersion: s.fingerprintKeyVersion,
      }),
      security,
      digest: createHash("sha256").update(JSON.stringify(v)).digest("hex"),
    });
  } catch {
    throw fail();
  }
}
