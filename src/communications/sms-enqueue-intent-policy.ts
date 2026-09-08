import { parseTransactionalMessageTemplateKey } from "./transactional-message-state";
import { TransactionalMessageTemplateKey } from "./transactional-message-template.service";

export const SMS_ENQUEUE_MAX_FAILURES = 5;

export enum EnqueueRetryReason {
  CONFIGURATION_REVIEWED = "CONFIGURATION_REVIEWED",
  CONSENT_POLICY_REVIEWED = "CONSENT_POLICY_REVIEWED",
  TRANSIENT_FAILURE_REVIEWED = "TRANSIENT_FAILURE_REVIEWED",
}

const supported = new Set([
  TransactionalMessageTemplateKey.TECHNICIAN_ON_THE_WAY,
  TransactionalMessageTemplateKey.APPOINTMENT_CONFIRMED,
]);

export function parseEnqueueIntentTemplate(value: unknown) {
  const key = parseTransactionalMessageTemplateKey(value);
  return key && supported.has(key) ? key : null;
}
