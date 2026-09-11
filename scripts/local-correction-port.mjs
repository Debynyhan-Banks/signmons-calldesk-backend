// Single-customer loopback fixture only. No provider, durable candidate or activation.
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
const require = createRequire(import.meta.url);
const {
  LocalAddressCorrection,
} = require("../dist/communications/local-address-correction.js");
const {
  lockCustomerConsentSession,
} = require("../dist/communications/customer-consent-session-lock.js");

export function localCorrectionPort({ prisma, credentials, adapter }) {
  const digest = (value) =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex");
  let scope = null,
    candidateId,
    fingerprint,
    intent,
    revision = 0,
    busy = false;
  const flow = new LocalAddressCorrection(adapter, () => scope);
  const refused = () => ({
    status: "REFUSED",
    fixtureOnly: true,
    addressVerified: false,
    county: "UNKNOWN",
    admissionAuthorized: false,
    deliveryAuthorized: false,
  });
  return {
    clear() {
      flow.clear();
      scope = null;
      fingerprint = intent = undefined;
      candidateId = undefined;
    },
    async handle(input) {
      if (busy) return refused();
      busy = true;
      try {
        const claims = credentials.verifySession(input.sessionToken);
        return await prisma.$transaction(async (tx) => {
          if (
            (await lockCustomerConsentSession(tx, claims)).status !== "ONGOING"
          ) {
            this.clear();
            return refused();
          }
          const conversation = await tx.conversation.findUnique({
            where: { id: claims.conversationId },
            select: { updatedAt: true },
          });
          const current = JSON.stringify([
            claims.tenantId,
            claims.sessionId,
            claims.expiresAt,
            conversation?.updatedAt,
          ]);
          if (fingerprint !== current) this.clear();
          if (
            input.action === "clear" &&
            input.input === null &&
            input.confirmed === false &&
            input.candidateId === candidateId &&
            input.revision === scope?.revision
          ) {
            this.clear();
            return refused();
          }
          if (
            input.action === "propose" &&
            input.candidateId === "" &&
            input.confirmed === false &&
            input.revision === 0
          ) {
            fingerprint = current;
            scope = {
              tenantId: claims.tenantId,
              sessionId: claims.sessionId,
              expiresAt: claims.expiresAt,
              revision: ++revision,
            };
            intent = digest(input.input);
            const result = await flow.propose(input.input);
            candidateId = result.candidateId;
            return {
              ...result,
              deliveryAuthorized: false,
            };
          }
          if (input.action !== "confirm" || digest(input.input) !== intent)
            return refused();
          return {
            ...flow.confirm({
              candidateId: input.candidateId,
              confirmed: input.confirmed,
              revision: input.revision,
            }),
            deliveryAuthorized: false,
          };
        });
      } catch {
        this.clear();
        return refused();
      } finally {
        busy = false;
      }
    },
  };
}
