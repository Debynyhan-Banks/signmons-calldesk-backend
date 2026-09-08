import type { SmsEnqueueIntentItem } from "@/lib/api";
import { historyTime, messageLabel } from "@/lib/notification-history";
import {
  filterIntents,
  intentFailureLabel,
  intentStatusLabel,
  type IntentFilter,
} from "@/lib/notification-intents";
import styles from "./notifications.module.css";

export function EnqueueIntents({
  items,
  state,
  error,
  filter,
  jobId,
  onFilter,
}: {
  items: SmsEnqueueIntentItem[];
  state: "idle" | "loading" | "ready" | "error";
  error: string;
  filter: IntentFilter;
  jobId: string;
  onFilter: (filter: IntentFilter) => void;
}) {
  const matching = filterIntents(items, "all", jobId);
  const visible = filterIntents(items, filter, jobId);
  return (
    <section
      className={styles.history}
      aria-label="SMS enqueue intents"
      aria-busy={state === "loading"}
    >
      <div className={styles.listHeader}>
        <div>
          <h2>Before the message queue</h2>
          <p>
            Technician departure intents only · latest 100 tenant records · job
            and status filters apply to this loaded subset
          </p>
        </div>
        <label>
          Show
          <select
            aria-label="Intent status"
            value={filter}
            onChange={(event) => onFilter(event.target.value as IntentFilter)}
          >
            <option value="all">All intents</option>
            <option value="pending">Pending enqueue</option>
            <option value="attention">Stopped · review required</option>
            <option value="queued">Queue acknowledged</option>
          </select>
        </label>
      </div>
      <p className={styles.status}>
        Pending is not proof of active retry: delivery may be disabled, or a
        claim/backoff may be in effect. The scheduled time is not a promised
        send time. Stopped intents require operator review; no retry action is
        available here.
      </p>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      <div role="status" className={styles.status}>
        {state === "idle"
          ? "Load history to inspect enqueue intents."
          : state === "loading"
            ? "Loading enqueue intents…"
            : state === "error"
              ? "Intent status unavailable. Message history is shown independently."
              : `${visible.length} intents shown · ${matching.length} match this job filter from ${items.length} loaded tenant records. ${filterIntents(matching, "pending").length} pending; ${filterIntents(matching, "attention").length} stopped.`}
      </div>
      {state === "ready" && visible.length === 0 && (
        <div className={styles.empty}>
          <h3>No enqueue intents match</h3>
          <p>
            This limited view cannot prove every job has a notification.
            Appointment intents and historical backfill are not implemented.
          </p>
        </div>
      )}
      <ol className={styles.list}>
        {visible.map((item) => (
          <li key={item.id}>
            <div className={styles.eventTop}>
              <div>
                <span className={styles.direction}>Enqueue intent</span>
                <h3>{messageLabel(item.templateKey)}</h3>
              </div>
              <span
                className={styles.badge}
                data-attention={["STALE", "FAILED"].includes(item.status)}
              >
                {intentStatusLabel(item.status)}
              </span>
            </div>
            <dl>
              <div>
                <dt>Job</dt>
                <dd>{item.jobId}</dd>
              </div>
              <div>
                <dt>Recorded (UTC)</dt>
                <dd>{historyTime(item.createdAt)}</dd>
              </div>
              <div>
                <dt>Failed enqueue attempts</dt>
                <dd>{item.attemptCount} / 5</dd>
              </div>
              <div>
                <dt>Failure reason</dt>
                <dd>{intentFailureLabel(item.lastErrorCode)}</dd>
              </div>
              <div>
                <dt>Retry / claim time (UTC)</dt>
                <dd>
                  {item.status === "PENDING"
                    ? historyTime(item.nextAttemptAt)
                    : "Not pending"}
                </dd>
              </div>
              <div>
                <dt>Queue event</dt>
                <dd>
                  {item.communicationEventId ??
                    "No queue acknowledgment recorded"}
                </dd>
              </div>
            </dl>
            <p className={styles.eventId}>Intent {item.id}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
