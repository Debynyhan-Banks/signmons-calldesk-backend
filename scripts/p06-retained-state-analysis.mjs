import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  sameControlledPhonePolicy,
  controlledPhoneProofCurrent,
} = require("../dist/communications/controlled-phone-proof.js");
export function analyze({
  ledger,
  scope,
  phoneDigest,
  policy,
  eventMs,
  lifecycle,
  postEventInvalidation,
  jobCount,
  address,
  observations,
}) {
  const out = {
    jobCount,
    addressStage: address?.state ?? "NO_ADDRESS_ROW",
    phoneStage: "INCONCLUSIVE",
    observationCount: observations.length,
    postEventInvalidation: Boolean(postEventInvalidation),
    sessionOpenAtEvent:
      lifecycle?.closedAt === null || lifecycle?.closedAt > eventMs,
    sessionUnexpiredAtEvent:
      Number.isSafeInteger(lifecycle?.expiresAt) &&
      eventMs < lifecycle.expiresAt,
  };
  if (
    !ledger ||
    ledger.version !== 1 ||
    !Array.isArray(ledger.entries) ||
    ledger.entries.length > 6
  ) {
    out.phoneStage = "LEDGER_UNAVAILABLE";
    return out;
  }
  const e = ledger.entries.find(
    (x) =>
      x.kind === "CHECK" &&
      x.phoneDigest === phoneDigest &&
      x.result?.outcome === "APPROVED",
  );
  const anyStart = ledger.entries.find(
    (x) => x.kind === "START" && x.phoneDigest === phoneDigest,
  );
  const start = ledger.entries.find(
    (x) => x.kind === "START" && x.id === e?.startId,
  );
  out.startRecordPresent = !!anyStart;
  const proof = e?.controlledProof;
  const checks = {
    approvedCheckPresent: !!e,
    linkedStartPresent: !!start,
    startPending: start?.result?.outcome === "PENDING",
    startNotRevoked: !!start && start.controlledProof !== null,
    proofPresent: !!proof,
    phoneBindingMatches: !!start && start.phoneDigest === phoneDigest,
    providerReferenceMatches:
      !!start &&
      !!e &&
      typeof start.result?.verificationSid === "string" &&
      start.result.verificationSid === e.result?.verificationSid,
    startPolicyMatches: sameControlledPhonePolicy(
      start?.controlledPolicy,
      policy,
    ),
    proofPolicyMatches: sameControlledPhonePolicy(proof?.policy, policy),
    proofCurrentAtEvent: controlledPhoneProofCurrent(
      proof,
      scope,
      policy,
      eventMs,
    ),
  };
  out.checks = checks;
  if (postEventInvalidation) {
    out.phoneStage = "POST_EVENT_CHANGE_INCONCLUSIVE";
    return out;
  }
  if (!e) out.phoneStage = "APPROVED_CHECK_ABSENT";
  else if (!proof) out.phoneStage = "CONTROLLED_PROOF_ABSENT";
  else if (!checks.startPolicyMatches || !checks.proofPolicyMatches)
    out.phoneStage = "PHONE_POLICY_MISMATCH";
  else if (!checks.proofCurrentAtEvent)
    out.phoneStage = "PHONE_PROOF_SCOPE_OR_TIME_MISMATCH";
  else if (!Object.values(checks).every(Boolean))
    out.phoneStage = "PHONE_LEDGER_BINDING_MISMATCH";
  else out.phoneStage = "RETAINED_PHONE_PREDICATES_PASS";
  if (Number.isSafeInteger(proof?.checkedAt))
    out.proofCheckedAt = new Date(proof.checkedAt).toISOString();
  if (Number.isSafeInteger(proof?.expiresAt))
    out.proofExpiresAt = new Date(proof.expiresAt).toISOString();
  return out;
}

// Per-client parser: PostgreSQL timestamp without timezone fields in this schema
// represent UTC. Never mutate the global pg parser or depend on the host TZ.
const { types: pgTypes } = require("pg");
export const retainedStateTypes = Object.freeze({
  getTypeParser(oid, format = "text") {
    if (oid !== 1114 || format !== "text")
      return pgTypes.getTypeParser(oid, format);
    return (value) => {
      if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/.test(value))
        throw Error("Invalid diagnostic UTC timestamp");
      const result = pgTypes.getTypeParser(1184, "text")(value + "+00");
      if (!(result instanceof Date) || !Number.isFinite(result.getTime()))
        throw Error("Invalid diagnostic UTC timestamp");
      return result;
    };
  },
});
