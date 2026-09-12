import { createHash } from "node:crypto";

export type StagingPhonePolicy = {
  version: 1;
  tenantId: string;
  operatorId: string;
  sessionId: string;
  conversationId: string;
  accountSid: string;
  serviceSid: string;
  phoneDigest: string;
  startsAt: number;
  expiresAt: number;
  rateVersion: string;
  flowUpperBoundMicros: number;
  noticeVersion: string;
};

/** Trusted deployment input only; never parse a policy from an HTTP request. */
export function stagingPhonePolicy(raw: unknown): StagingPhonePolicy | null {
  try {
    if (typeof raw !== "string" || raw.length > 4096) return null;
    const p = JSON.parse(raw) as StagingPhonePolicy;
    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (
      !p ||
      Object.keys(p).sort().join(",") !==
        "accountSid,conversationId,expiresAt,flowUpperBoundMicros,noticeVersion,operatorId,phoneDigest,rateVersion,serviceSid,sessionId,startsAt,tenantId,version" ||
      p.version !== 1 ||
      ![p.tenantId, p.sessionId, p.conversationId].every(
        (v) => typeof v === "string" && uuid.test(v),
      ) ||
      typeof p.operatorId !== "string" ||
      !p.operatorId.trim() ||
      p.operatorId.length > 128 ||
      typeof p.accountSid !== "string" ||
      typeof p.serviceSid !== "string" ||
      typeof p.phoneDigest !== "string" ||
      !/^AC[0-9a-f]{32}$/i.test(p.accountSid) ||
      !/^VA[0-9a-f]{32}$/i.test(p.serviceSid) ||
      !/^[0-9a-f]{64}$/.test(p.phoneDigest) ||
      !Number.isSafeInteger(p.startsAt) ||
      !Number.isSafeInteger(p.expiresAt) ||
      p.startsAt < 0 ||
      p.expiresAt <= p.startsAt ||
      p.expiresAt - p.startsAt > 30 * 60_000 ||
      !Number.isSafeInteger(p.flowUpperBoundMicros) ||
      p.flowUpperBoundMicros <= 0 ||
      p.flowUpperBoundMicros > 500_000 ||
      ![p.rateVersion, p.noticeVersion].every(
        (v) => typeof v === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(v),
      )
    )
      return null;
    return Object.freeze(p);
  } catch {
    return null;
  }
}
export function stagingPhoneDigest(p: StagingPhonePolicy) {
  return createHash("sha256")
    .update(
      JSON.stringify(Object.entries(p).sort(([a], [b]) => a.localeCompare(b))),
    )
    .digest("hex");
}
