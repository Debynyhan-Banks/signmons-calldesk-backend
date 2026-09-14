import express from "express";
import { createServer, request } from "node:http";
import { AddressInfo } from "node:net";
import {
  parseControlledRuntimeConfig,
  managedRuntimeOrigin,
  RuntimeFacts,
} from "./controlled-intake-runtime-config";
import { customerSessionHttp } from "./customer-session-http";
import { CustomerConsentBrowserTransport } from "./customer-consent-browser-transport";

const now = Date.now();
const tenantId = "11111111-1111-4111-8111-111111111111";
const packetId = "33333333-3333-4333-8333-333333333333";
const origin = "https://staging.example.invalid";
const facts = (): RuntimeFacts => ({
  nodeEnv: "production",
  project: "test-project",
  service: "test-service",
  configuration: "test-config",
  revision: "test-revision",
  port: "8080",
  flags: Object.fromEntries(
    [
      "DEV_AUTH_ENABLED",
      "SCHEDULING_ENABLED",
      "STRIPE_WEBHOOK_LIVEMODE",
      "SMS_DELIVERY_ENABLED",
      "BACKGROUND_WORKERS_ENABLED",
      "STAGING_PHONE_TEST_ENABLED",
    ].map((k) => [k, "false"]),
  ),
});
const config = () => ({
  version: 1,
  enabled: true,
  project: "test-project",
  service: "test-service",
  configuration: "test-config",
  revision: "test-revision",
  origin,
  activation: {
    version: 1,
    enabled: true,
    tenantId,
    packetId,
    integrationId: "controlled-intake",
    origin,
    policyVersion: "v1",
    organizationApprovedAt: new Date(now - 2000).toISOString(),
    organizationDigest: "a".repeat(64),
    paymentApprovedAt: new Date(now - 2000).toISOString(),
    paymentDigest: "b".repeat(64),
    allowedServiceCategoryIds: [tenantId],
    priorityPolicy: "AUTO_INTAKE_STANDARD_V1",
    validFrom: new Date(now - 1000).toISOString(),
    validUntil: new Date(now + 60000).toISOString(),
  },
  phone: {
    packetId,
    tenantId,
    accountSid: "AC" + "a".repeat(32),
    serviceSid: "VA" + "b".repeat(32),
    participantHmac: "c".repeat(64),
    noticeVersion: "v1",
    rateVersion: "synthetic",
    startsAt: now - 1000,
    expiresAt: now + 60000,
    flowUpperBoundMicros: 10,
    accountCeilingMicros: 20,
  },
  browserBudget: {
    packetId,
    tenantId,
    validFrom: now - 1000,
    validUntil: now + 60000,
    total: 100,
    tenant: 100,
    session: 90,
    starts: 1,
    inFlight: 2,
  },
  addressAccountId: tenantId,
  addressPolicy: {
    mode: "CONTROLLED_ADDRESS_V1",
    approved: true,
    version: "v1",
    rateVersion: "synthetic",
    validUntil: now + 60000,
    costMicros: 1,
    account: { micros: 2, requests: 2 },
    tenant: { micros: 2, requests: 2 },
    session: { micros: 2, requests: 2 },
    execution: "CONTROLLED_8S_2_ATTEMPTS",
  },
  secrets: {
    activeKeyId: "current",
    sessionKeys: {
      current: "projects/test-project/secrets/session/versions/1",
    },
    digestKey: "projects/test-project/secrets/digest/versions/2",
    twilioToken: "projects/test-project/secrets/twilio/versions/3",
    fingerprintKey:
      "projects/test-project/secrets/mailbox-fingerprint/versions/4",
    fingerprintKeyVersion: "mailbox-v1",
  },
});
describe("controlled runtime configuration and ingress", () => {
  it("stays absent when disabled and rejects malformed enabled configuration", () => {
    expect(
      parseControlledRuntimeConfig(undefined, facts(), now),
    ).toBeUndefined();
    expect(
      parseControlledRuntimeConfig({ enabled: false }, facts(), now),
    ).toBeUndefined();
    for (const value of [[], "config", {}, { ...config(), extra: true }])
      expect(() => parseControlledRuntimeConfig(value, facts(), now)).toThrow(
        "unavailable",
      );
    for (const key of Object.keys(config())) {
      const v: Record<string, unknown> = config();
      delete v[key];
      expect(() => parseControlledRuntimeConfig(v, facts(), now)).toThrow(
        "unavailable",
      );
    }
  });
  it("requires exact server runtime facts and explicit disabled flags", () => {
    for (const key of [
      "nodeEnv",
      "project",
      "service",
      "configuration",
      "revision",
      "port",
    ])
      expect(() =>
        parseControlledRuntimeConfig(
          config(),
          { ...facts(), [key]: "wrong" },
          now,
        ),
      ).toThrow("unavailable");
    for (const key of Object.keys(facts().flags))
      for (const value of [undefined, "true", "0"]) {
        const f = facts();
        f.flags[key] = value;
        expect(() => parseControlledRuntimeConfig(config(), f, now)).toThrow(
          "unavailable",
        );
      }
  });
  it("binds packet, tenant, budgets, origin, validity and numeric distinct secret versions", () => {
    const mutations: Array<(v: ReturnType<typeof config>) => void> = [
      (v) => {
        v.origin = "https://other.invalid";
      },
      (v) => {
        v.phone.tenantId = packetId;
      },
      (v) => {
        v.phone.packetId = tenantId;
      },
      (v) => {
        v.phone.expiresAt++;
      },
      (v) => {
        v.phone.accountCeilingMicros = 0;
      },
      (v) => {
        v.browserBudget.starts = 2;
      },
      (v) => {
        v.browserBudget.session = 101;
      },
      (v) => {
        v.browserBudget.validUntil++;
      },
      (v) => {
        v.browserBudget.packetId = tenantId;
      },
      (v) => {
        v.addressPolicy.session.requests = 3;
      },
      (v) => {
        v.addressPolicy.costMicros = 0;
      },
      (v) => {
        v.addressPolicy.validUntil++;
      },
      (v) => {
        v.addressAccountId = "invalid";
      },
      (v) => {
        v.secrets.twilioToken = "plaintext";
      },
      (v) => {
        v.secrets.twilioToken = "projects/other/secrets/twilio/versions/3";
      },
      (v) => {
        v.secrets.twilioToken =
          "projects/test-project/secrets/twilio/versions/latest";
      },
      (v) => {
        v.secrets.twilioToken = v.secrets.digestKey;
      },
      (v) => {
        v.secrets.activeKeyId = "missing";
      },
    ];
    for (const mutate of mutations) {
      const v = config();
      mutate(v);
      expect(() => parseControlledRuntimeConfig(v, facts(), now)).toThrow(
        "unavailable",
      );
    }
    for (const time of [now - 2000, now + 60000, NaN])
      expect(() =>
        parseControlledRuntimeConfig(config(), facts(), time),
      ).toThrow("unavailable");
  });
  it("requires a dedicated versioned fingerprint reference, never another purpose's secret", () => {
    for (const ref of [
      "",
      "plaintext",
      "projects/test-project/secrets/mailbox-fingerprint/versions/latest",
      "projects/other/secrets/mailbox-fingerprint/versions/1",
      "projects/test-project/secrets/session/versions/99",
      "projects/test-project/secrets/digest/versions/99",
      "projects/test-project/secrets/twilio/versions/99",
    ]) {
      const v = config();
      v.secrets.fingerprintKey = ref;
      expect(() => parseControlledRuntimeConfig(v, facts(), now)).toThrow(
        "unavailable",
      );
    }
    for (const key of ["fingerprintKey", "fingerprintKeyVersion"]) {
      const v = config();
      delete (v.secrets as Record<string, unknown>)[key];
      expect(() => parseControlledRuntimeConfig(v, facts(), now)).toThrow(
        "unavailable",
      );
    }
    const v = config();
    v.secrets.fingerprintKeyVersion = "bad version";
    expect(() => parseControlledRuntimeConfig(v, facts(), now)).toThrow(
      "unavailable",
    );
    const parsed = parseControlledRuntimeConfig(config(), facts(), now)!;
    expect(parsed.secrets.fingerprintKeyVersion).toBe("mailbox-v1");
  });
  it("copies and freezes nested policy; only the original unexpired seal qualifies ingress", () => {
    const input = config();
    const parsed = parseControlledRuntimeConfig(input, facts(), now)!;
    input.secrets.sessionKeys.current = "changed";
    input.activation.allowedServiceCategoryIds.length = 0;
    expect(parsed.activation.allowedServiceCategoryIds).toEqual([tenantId]);
    for (const value of [
      parsed,
      parsed.phone,
      parsed.browserBudget,
      parsed.addressPolicy,
      parsed.addressPolicy.session,
      parsed.secrets,
      parsed.secrets.sessionKeys,
      parsed.security,
    ])
      expect(Object.isFrozen(value)).toBe(true);
    expect(managedRuntimeOrigin(parsed.security, now)).toBe(origin);
    expect(managedRuntimeOrigin({ ...parsed.security }, now)).toBeUndefined();
    expect(managedRuntimeOrigin(parsed.security, now + 60000)).toBeUndefined();
    expect(managedRuntimeOrigin(parsed.security, now - 2000)).toBeUndefined();
  });
  it("qualifies managed HTTP only with the opaque binding and exact host before transport", async () => {
    const security = parseControlledRuntimeConfig(
      config(),
      facts(),
      now,
    )!.security;
    for (const [seal, host, expected] of [
      [security, "staging.example.invalid", 200],
      [security, "other.invalid", 503],
      [{ ...security }, "staging.example.invalid", 503],
    ] as const) {
      const handleStream = jest
        .fn()
        .mockResolvedValue({ status: 200, headers: {}, body: { ok: true } });
      const app = express();
      app.use(
        customerSessionHttp({
          security: seal,
          tenantId,
          integrationId: "test",
          transport: {
            handleStream,
          } as unknown as CustomerConsentBrowserTransport,
        }),
      );
      const server = createServer(app);
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      try {
        const status = await new Promise<number | undefined>(
          (resolve, reject) => {
            const req = request(
              `http://127.0.0.1:${(server.address() as AddressInfo).port}/customer-session/start`,
              {
                method: "POST",
                headers: { host, "X-Forwarded-Proto": "https" },
              },
              (res) => {
                res.resume();
                res.on("end", () => resolve(res.statusCode));
              },
            );
            req.on("error", reject);
            req.end("{}");
          },
        );
        expect(status).toBe(expected);
        if (expected === 200)
          expect(handleStream).toHaveBeenCalledWith(
            expect.objectContaining({ encrypted: true }),
            expect.anything(),
          );
        else expect(handleStream).not.toHaveBeenCalled();
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  });
});
