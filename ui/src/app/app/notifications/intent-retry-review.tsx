import { useEffect, useRef, useState } from "react";
import type { SmsEnqueueIntentItem, SmsRetryReason } from "@/lib/api";
import { messageLabel } from "@/lib/notification-history";
import styles from "./notifications.module.css";

export function IntentRetryReview({
  item,
  onCancel,
  onConfirm,
}: {
  item: SmsEnqueueIntentItem;
  onCancel: () => void;
  onConfirm: (reason: SmsRetryReason) => void;
}) {
  const [reason, setReason] = useState<SmsRetryReason | "">("");
  const [acknowledged, setAcknowledged] = useState(false);
  const reasonInput = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    reasonInput.current?.focus();
  }, []);
  return (
    <section className={styles.retryReview} aria-label="Review enqueue retry">
      <h3>Review enqueue retry</h3>
      <p>{messageLabel(item.templateKey)} · 5 failed enqueue attempts</p>
      <p>
        Job {item.jobId}
        <br />
        Intent {item.id}
        <br />
        Reviewed version (UTC): {item.updatedAt}
      </p>
      <p>
        This re-arms the worker and may later send an SMS if delivery is enabled
        and policy allows. It does not override consent, repair job state, or
        confirm delivery.
      </p>
      <label>
        Reviewed reason
        <select
          ref={reasonInput}
          value={reason}
          onChange={(event) =>
            setReason(event.target.value as SmsRetryReason | "")
          }
        >
          <option value="">Choose the issue you reviewed</option>
          <option value="CONFIGURATION_REVIEWED">Configuration reviewed</option>
          <option value="CONSENT_POLICY_REVIEWED">
            Consent policy reviewed
          </option>
          <option value="TRANSIENT_FAILURE_REVIEWED">
            Transient failure reviewed
          </option>
        </select>
      </label>
      <label className={styles.acknowledgment}>
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(event) => setAcknowledged(event.target.checked)}
        />
        I reviewed this failed intent and acknowledge that retrying may cause a
        later SMS.
      </label>
      <p>
        Clearing the session after submission does not undo a request already
        accepted by the server.
      </p>
      <div className={styles.retryActions}>
        <button type="button" onClick={onCancel}>
          Cancel review
        </button>
        <button
          type="button"
          disabled={!reason || !acknowledged}
          onClick={() => {
            if (reason && acknowledged) onConfirm(reason);
          }}
        >
          Request retry
        </button>
      </div>
    </section>
  );
}
