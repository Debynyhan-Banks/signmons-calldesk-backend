// Bounded per-session fixture ownership; no live client or production bootstrap.
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { localFreshnessPolicy } from "./local-freshness-policy.mjs";
const require = createRequire(import.meta.url);
const {
  LocalAddressCorrection,
} = require("../dist/communications/local-address-correction.js");
const {
  AddressOperationLedger,
} = require("../dist/communications/address-operation-ledger.js");
const {
  AddressOperationExecutor,
} = require("../dist/communications/address-operation-executor.js");
const {
  lockCustomerConsentSession,
} = require("../dist/communications/customer-consent-session-lock.js");

function singleCorrectionPort({
  prisma,
  credentials,
  adapter,
  readPolicy = localFreshnessPolicy,
}) {
  const digest = (value) =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const accountId = "00000000-0000-4000-8000-000000000013"; // Stable fictional shared account across service reconstruction.
  const policy = {
    mode: "FIXTURE_ONLY",
    approved: true,
    version: "vo2-local",
    rateVersion: "fictional-not-a-price",
    validUntil: Date.now() + 3600000,
    costMicros: 10,
    account: { micros: 1000, requests: 100 },
    tenant: { micros: 100, requests: 10 },
    session: { micros: 30, requests: 3 },
    execution: "VO2_FIXTURE_8S_3_ATTEMPTS_30S",
  };
  let scope = null,
    active,
    receipt,
    expiryTimer,
    revision = 0,
    busy = false;
  const flow = new LocalAddressCorrection(adapter, () => scope);
  const refused = (status = "REFUSED") => ({
    status,
    fixtureOnly: true,
    addressVerified: false,
    county: "UNKNOWN",
    admissionAuthorized: false,
    deliveryAuthorized: false,
  });
  async function snapshot(tx, claims) {
    if ((await lockCustomerConsentSession(tx, claims)).status !== "ONGOING")
      throw Error("closed");
    const freshnessPolicy = await readPolicy(tx, claims.tenantId);
    if (!freshnessPolicy) throw Error("missing freshness policy");
    return JSON.stringify([
      claims.tenantId,
      claims.sessionId,
      claims.expiresAt,
      freshnessPolicy,
    ]);
  }
  const ledger = new AddressOperationLedger(prisma, credentials, {
    accountId,
    readBinding: async (tx, claims) => {
      // The ledger already holds the session lock; do not reacquire it here.
      const freshnessPolicy = await readPolicy(tx, claims.tenantId);
      const current = JSON.stringify([
        claims.tenantId,
        claims.sessionId,
        active?.expiresAt,
        freshnessPolicy,
      ]);
      return active && current === active.snapshot
        ? { intentId: active.intentId, revision: active.revision, policy }
        : null;
    },
  });
  const executor = new AddressOperationExecutor(ledger);
  return {
    clear() {
      clearTimeout(expiryTimer);
      expiryTimer = undefined;
      flow.clear();
      scope = null;
      active = receipt = undefined;
    },
    async handle(input) {
      if (busy) return refused("UNCERTAIN");
      busy = true;
      try {
        const claims = credentials.verifySession(input.sessionToken);
        const current = await prisma.$transaction((tx) => snapshot(tx, claims));
        if (active && active.snapshot !== current) this.clear();
        if (
          input.action === "clear" &&
          input.requestId === "" &&
          input.input === null &&
          input.confirmed === false &&
          input.candidateId === receipt?.candidateId &&
          input.revision === scope?.revision
        ) {
          this.clear();
          return refused();
        }
        if (
          input.action === "propose" &&
          input.candidateId === "" &&
          input.confirmed === false &&
          input.revision === 0 &&
          typeof input.requestId === "string" &&
          /^[0-9a-f-]{36}$/.test(input.requestId)
        ) {
          const intent = digest(input.input);
          if (!active || active.digest !== intent) {
            this.clear();
            scope = {
              tenantId: claims.tenantId,
              sessionId: claims.sessionId,
              revision: ++revision,
              expiresAt: claims.expiresAt,
              policy: JSON.parse(current)[3],
            };
            active = {
              snapshot: current,
              digest: intent,
              intentId: randomUUID(),
              revision,
              expiresAt: claims.expiresAt,
            };
            expiryTimer = setTimeout(
              () => this.clear(),
              Math.max(0, Math.min(claims.expiresAt - Date.now(), 86400000)),
            );
            expiryTimer.unref();
          }
          // Exact observed retry may reuse a live candidate; never reconstruct it after restart.
          const prior = await ledger.execute({
            sessionToken: input.sessionToken,
            requestId: input.requestId,
            action: "reserve",
          });
          if (
            prior.state === "OBSERVED" &&
            receipt &&
            Date.now() < receipt.expiresAt
          )
            return structuredClone(receipt);
          const result = await executor.run(
            { sessionToken: input.sessionToken, requestId: input.requestId },
            {
              mode: "FIXTURE_ONLY",
              run: async (signal) => {
                if (signal.aborted) throw Error("aborted");
                const abort = () => flow.clear();
                signal.addEventListener("abort", abort, { once: true });
                try {
                  const proposed = await flow.propose(input.input);
                  if (proposed.status !== "CONFIRMATION_REQUIRED")
                    throw Error("unavailable");
                  return proposed;
                } finally {
                  signal.removeEventListener("abort", abort);
                }
              },
            },
          );
          if (result.status !== "OBSERVED") {
            flow.clear();
            receipt = undefined;
            return refused("UNCERTAIN");
          }
          receipt = { ...result.value, deliveryAuthorized: false };
          return structuredClone(receipt);
        }
        if (
          input.action !== "confirm" ||
          input.requestId !== "" ||
          !active ||
          digest(input.input) !== active.digest
        )
          return refused();
        return {
          ...flow.confirm({
            candidateId: input.candidateId,
            confirmed: input.confirmed,
            revision: input.revision,
          }),
          deliveryAuthorized: false,
        };
      } catch {
        flow.clear();
        receipt = undefined;
        return refused();
      } finally {
        busy = false;
      }
    },
  };
}

export function localCorrectionPort(options) {
  const entries = new Map();
  let sweeping = false;
  const key = (claims) =>
    `${claims.tenantId}:${claims.conversationId}:${claims.sessionId}`;
  const refused = () => ({
    status: "REFUSED",
    fixtureOnly: true,
    addressVerified: false,
    county: "UNKNOWN",
    admissionAuthorized: false,
    deliveryAuthorized: false,
  });
  const drop = (id) => {
    entries.get(id)?.port.clear();
    entries.delete(id);
  };
  const sweep = async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      for (const [id, entry] of entries) {
        try {
          if (Date.now() >= entry.expiresAt) throw Error("expired");
          const state = await options.prisma.$transaction((tx) =>
            lockCustomerConsentSession(tx, entry.claims),
          );
          if (state.status !== "ONGOING") throw Error("closed");
        } catch {
          drop(id);
        } // Unknown lifecycle is unusable; no provider work or liability release.
      }
    } finally {
      sweeping = false;
    }
  };
  const timer = setInterval(() => {
    void sweep();
  }, 1000);
  timer.unref();
  return {
    async handle(input) {
      try {
        input = structuredClone(input);
        const claims = options.credentials.verifySession(input.sessionToken);
        const id = key(claims);
        if (!entries.has(id)) {
          if (entries.size >= 64) return refused();
          entries.set(id, {
            claims,
            expiresAt: Math.min(claims.expiresAt, Date.now() + 86400000),
            port: singleCorrectionPort(options),
          });
        }
        return await entries.get(id).port.handle(input);
      } catch {
        return refused();
      }
    },
    discard(sessionToken) {
      const claims = options.credentials.verifySession(sessionToken);
      drop(key(claims));
    },
    sweep,
    size() {
      return entries.size;
    }, // Fixture evidence only, never transported.
    clear() {
      clearInterval(timer);
      for (const id of entries.keys()) drop(id);
    },
  };
}
