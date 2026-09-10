import { BadRequestException, ConflictException } from "@nestjs/common";

export const ORGANIZATION_PROFILE = "organizationProfileV1";
export type OrganizationDraft = {
  companyName: string;
  timezone: string;
  hours: string;
  services: string;
  fallback: string;
  greeting: string;
  tone: "warm" | "concise";
  faqs: { question: string; answer: string; source: string }[];
};
export type OrganizationProfile = {
  version: 1;
  draft: OrganizationDraft;
  approved: null | {
    draft: OrganizationDraft;
    actorId: string;
    approvedAt: string;
  };
};
export function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
export function exact(value: unknown, keys: string[]) {
  const row = object(value);
  return (
    row &&
    Object.keys(row).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(row, key))
  );
}
function text(value: unknown, max: number) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    [...value].some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    )
  )
    throw new BadRequestException(
      "Complete the organization fields using plain text within the limits.",
    );
  return value.trim();
}
export function draft(value: unknown): OrganizationDraft {
  if (
    !exact(value, [
      "companyName",
      "timezone",
      "hours",
      "services",
      "fallback",
      "greeting",
      "tone",
      "faqs",
    ])
  )
    throw new BadRequestException("Organization fields are invalid.");
  const row = object(value)!;
  const timezone = text(row.timezone, 80);
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
  } catch {
    throw new BadRequestException("Choose a valid timezone.");
  }
  if (
    !["warm", "concise"].includes(String(row.tone)) ||
    !Array.isArray(row.faqs) ||
    row.faqs.length < 1 ||
    row.faqs.length > 10
  )
    throw new BadRequestException(
      "Choose a tone and one to ten approved-answer drafts.",
    );
  const faqs = row.faqs.map((faq: unknown) => {
    if (!exact(faq, ["question", "answer", "source"]))
      throw new BadRequestException("FAQ fields are invalid.");
    const item = object(faq)!;
    return {
      question: text(item.question, 200),
      answer: text(item.answer, 1000),
      source: text(item.source, 200),
    };
  });
  if (
    new Set(faqs.map((faq) => faq.question.toLowerCase())).size !== faqs.length
  )
    throw new BadRequestException("FAQ questions must be distinct.");
  return {
    companyName: text(row.companyName, 120),
    timezone,
    hours: text(row.hours, 500),
    services: text(row.services, 500),
    fallback: text(row.fallback, 500),
    greeting: text(row.greeting, 200),
    tone: row.tone as OrganizationDraft["tone"],
    faqs,
  };
}
export function timestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
export function profile(value: unknown): OrganizationProfile | null {
  if (value === undefined) return null;
  try {
    if (!exact(value, ["version", "draft", "approved"])) throw new Error();
    const row = object(value)!;
    if (row.version !== 1) throw new Error();
    const current = draft(row.draft);
    if (row.approved === null)
      return { version: 1, draft: current, approved: null };
    if (!exact(row.approved, ["draft", "actorId", "approvedAt"]))
      throw new Error();
    const approved = object(row.approved)!;
    if (!timestamp(approved.approvedAt)) throw new Error();
    return {
      version: 1,
      draft: current,
      approved: {
        draft: draft(approved.draft),
        actorId: text(approved.actorId, 200),
        approvedAt: approved.approvedAt,
      },
    };
  } catch {
    throw new ConflictException(
      "Stored organization profile requires administrator review.",
    );
  }
}
export function preview(
  approved: NonNullable<OrganizationProfile["approved"]>,
  question: unknown,
  maxQuestionLength = 200,
) {
  const query = text(question, maxQuestionLength).toLowerCase();
  const facts = approved.draft;
  const match = facts.faqs.find((faq) => faq.question.toLowerCase() === query);
  return {
    approvedAt: approved.approvedAt,
    mode: "DETERMINISTIC_PREVIEW" as const,
    matched: Boolean(match),
    requiresHumanFollowup: !match,
    answer: `${facts.greeting} I’m the automated assistant for ${facts.companyName}. ${facts.tone === "warm" ? "Thanks for asking. " : ""}${match ? match.answer : facts.fallback}`,
    source: match?.source ?? null,
    actionsAuthorized: false,
  };
}
