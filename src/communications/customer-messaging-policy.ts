import { ConflictException } from "@nestjs/common";
import { TransactionalMessageTemplateKey as Key } from "./transactional-message-template.service";

export const CUSTOMER_SMS_KEYS = Object.values(Key);
export const CUSTOMER_SMS_POLICY = "customerSmsPreferences";
export type CustomerSmsEvents = Record<Key, boolean>;
export const defaultCustomerSmsEvents = (): CustomerSmsEvents =>
  Object.fromEntries(
    CUSTOMER_SMS_KEYS.map((key) => [key, true]),
  ) as CustomerSmsEvents;

export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
export function validCustomerSmsEvents(
  value: unknown,
): value is CustomerSmsEvents {
  const item = record(value);
  return (
    !!item &&
    Object.keys(item).length === CUSTOMER_SMS_KEYS.length &&
    CUSTOMER_SMS_KEYS.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(item, key) &&
        typeof item[key] === "boolean",
    )
  );
}
export function customerSmsPolicy(settings: unknown) {
  const root = record(settings);
  // Absence preserves existing event eligibility, never enables the delivery worker.
  if (root && !Object.prototype.hasOwnProperty.call(root, CUSTOMER_SMS_POLICY))
    return { source: "legacy" as const, events: defaultCustomerSmsEvents() };
  const policy = record(root?.[CUSTOMER_SMS_POLICY]);
  if (
    policy?.version === 1 &&
    Object.keys(policy).length === 2 &&
    validCustomerSmsEvents(policy.events)
  )
    return { source: "saved" as const, events: { ...policy.events } };
  return {
    source: "invalid" as const,
    events: Object.fromEntries(
      CUSTOMER_SMS_KEYS.map((key) => [key, false]),
    ) as CustomerSmsEvents,
  };
}
export function customerSmsAllowed(settings: unknown, key: Key): boolean {
  return customerSmsPolicy(settings).events[key] === true;
}
export class CustomerSmsPreferenceError extends ConflictException {
  constructor() {
    super("Customer SMS is disabled by tenant messaging preferences.");
  }
}
