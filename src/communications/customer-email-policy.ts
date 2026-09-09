import { record } from "./customer-messaging-policy";

export const CUSTOMER_EMAIL_POLICY = "customerEmailPreferences";
export const CUSTOMER_EMAIL_KEYS = [
  "APPOINTMENT_CONFIRMED",
  "APPOINTMENT_RESCHEDULED",
  "APPOINTMENT_CANCELLED",
] as const;
export type CustomerEmailEvents = Record<
  (typeof CUSTOMER_EMAIL_KEYS)[number],
  boolean
>;
export const blockedCustomerEmailEvents = (): CustomerEmailEvents => ({
  APPOINTMENT_CONFIRMED: false,
  APPOINTMENT_RESCHEDULED: false,
  APPOINTMENT_CANCELLED: false,
});
export function validCustomerEmailEvents(
  value: unknown,
): value is CustomerEmailEvents {
  const item = record(value);
  return (
    !!item &&
    Object.keys(item).length === 3 &&
    CUSTOMER_EMAIL_KEYS.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(item, key) &&
        typeof item[key] === "boolean",
    )
  );
}
export function customerEmailPolicy(settings: unknown) {
  const root = record(settings);
  if (
    root &&
    !Object.prototype.hasOwnProperty.call(root, CUSTOMER_EMAIL_POLICY)
  )
    return { source: "default" as const, events: blockedCustomerEmailEvents() };
  const policy = record(root?.[CUSTOMER_EMAIL_POLICY]);
  if (
    policy?.version === 1 &&
    Object.keys(policy).length === 2 &&
    validCustomerEmailEvents(policy.events)
  )
    return { source: "saved" as const, events: { ...policy.events } };
  return { source: "invalid" as const, events: blockedCustomerEmailEvents() };
}
