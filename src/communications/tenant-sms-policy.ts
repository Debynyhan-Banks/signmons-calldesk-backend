import { BadRequestException } from "@nestjs/common";
import { createHash } from "node:crypto";

export type SmsPolicyContent = {
  legalSender: string;
  purpose: "APPOINTMENT_UPDATES_V1";
  supportEmail: string;
  disclosure: string;
  disclosureVersion: string;
  privacyUrl: string;
  privacyVersion: string;
  termsUrl: string;
  termsVersion: string;
  effectiveAt: string;
  expiresAt: string;
};
const keys = [
  "legalSender",
  "purpose",
  "supportEmail",
  "disclosure",
  "disclosureVersion",
  "privacyUrl",
  "privacyVersion",
  "termsUrl",
  "termsVersion",
  "effectiveAt",
  "expiresAt",
] as const;
const invalid = () =>
  new BadRequestException("SMS policy content is invalid or unapproved.");
export function exactPolicyKeys(
  value: unknown,
  allowed: readonly string[],
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== [...allowed].sort().join(",")
  )
    throw invalid();
}
export function validateSmsPolicy(
  value: unknown,
  allowedUrls: readonly string[],
): SmsPolicyContent {
  exactPolicyKeys(value, keys);
  for (const key of keys)
    if (
      typeof value[key] !== "string" ||
      !value[key] ||
      value[key].trim() !== value[key] ||
      [...value[key]].some(
        (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
      )
    )
      throw invalid();
  const p = value as unknown as SmsPolicyContent;
  if (
    p.legalSender.length > 120 ||
    p.disclosure.length > 2000 ||
    p.purpose !== "APPOINTMENT_UPDATES_V1" ||
    p.supportEmail.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.supportEmail)
  )
    throw invalid();
  for (const key of [
    "disclosureVersion",
    "privacyVersion",
    "termsVersion",
  ] as const)
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(p[key])) throw invalid();
  for (const key of ["privacyUrl", "termsUrl"] as const) {
    let u: URL;
    try {
      u = new URL(p[key]);
    } catch {
      throw invalid();
    }
    if (
      p[key].length > 500 ||
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      u.port ||
      u.href !== p[key] ||
      !allowedUrls.includes(p[key]) ||
      /[%\\]/.test(p[key]) ||
      !/^[a-z][a-z0-9.-]*\.[a-z]{2,}$/i.test(u.hostname)
    )
      throw invalid();
  }
  for (const key of ["effectiveAt", "expiresAt"] as const)
    if (
      !Number.isFinite(Date.parse(p[key])) ||
      new Date(p[key]).toISOString() !== p[key]
    )
      throw invalid();
  if (p.expiresAt <= p.effectiveAt) throw invalid();
  return Object.fromEntries(
    keys.map((key) => [key, p[key]]),
  ) as SmsPolicyContent;
}
export const smsPolicyDigest = (value: SmsPolicyContent) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function policyRevision(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < 0 ||
    Number(value) >= 2147483647
  )
    throw invalid();
  return Number(value);
}
export function policyReference(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,120}$/.test(value))
    throw invalid();
  return value;
}
