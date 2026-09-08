"use client";

import { useEffect, useRef, useState } from "react";
import {
  ApiError,
  listSmsHistory,
  listSmsEnqueueIntents,
  getSmsCapabilities,
  retrySmsEnqueueIntent,
  type SmsRetryReason,
  type SmsHistoryItem,
  type SmsEnqueueIntentItem,
} from "@/lib/api";
import {
  canReviewIntentRetry,
  retryOutcomeMessage,
  type IntentFilter,
} from "@/lib/notification-intents";
import { EnqueueIntents } from "./enqueue-intents";
import { IntentRetryReview } from "./intent-retry-review";
import {
  filterHistory,
  historyTime,
  messageLabel,
  statusLabel,
  validHistoryJobId,
  type HistoryFilter,
} from "@/lib/notification-history";
import styles from "./notifications.module.css";

export default function NotificationsPage() {
  const [token, setToken] = useState("");
  const [jobId, setJobId] = useState("");
  const [items, setItems] = useState<SmsHistoryItem[]>([]);
  const [filter, setFilter] = useState<HistoryFilter>("all");
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">(
    "idle",
  );
  const [error, setError] = useState("");
  const [intents, setIntents] = useState<SmsEnqueueIntentItem[]>([]);
  const [intentState, setIntentState] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [intentError, setIntentError] = useState("");
  const [intentFilter, setIntentFilter] = useState<IntentFilter>("all");
  const generation = useRef(0);
  const [canRetry, setCanRetry] = useState(false);
  const [capabilityNote, setCapabilityNote] = useState("");
  const [review, setReview] = useState<SmsEnqueueIntentItem | null>(null);
  const [retryNote, setRetryNote] = useState("");
  const [retryBusy, setRetryBusy] = useState(false);
  const retryInFlight = useRef(false);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );

  function clearResults() {
    generation.current += 1;
    setItems([]);
    setState("idle");
    setError("");
    setIntents([]);
    setIntentState("idle");
    setIntentError("");
    setCanRetry(false);
    setCapabilityNote("");
    setReview(null);
    setRetryNote("");
  }

  async function submitRetry(reasonCode: SmsRetryReason) {
    if (
      retryInFlight.current ||
      !review ||
      !canReviewIntentRetry(review, canRetry)
    )
      return;
    const item = review;
    const request = generation.current;
    retryInFlight.current = true;
    setRetryBusy(true);
    setReview(null);
    setIntents([]);
    setIntentState("idle");
    setCanRetry(false);
    setCapabilityNote("");
    setRetryNote("");
    try {
      await retrySmsEnqueueIntent(token, item.id, {
        acknowledgeRetry: true,
        reasonCode,
        expectedUpdatedAt: item.updatedAt,
      });
      if (request === generation.current)
        setRetryNote(
          "Retry requested. Pending is not queued, sent or delivered. Load history to refresh before any further review.",
        );
    } catch (failure) {
      if (request === generation.current)
        setRetryNote(
          retryOutcomeMessage(
            failure instanceof ApiError ? failure.status : undefined,
          ),
        );
    } finally {
      retryInFlight.current = false;
      setRetryBusy(false);
    }
  }

  async function load() {
    if (
      retryInFlight.current ||
      !token.trim() ||
      !validHistoryJobId(jobId.trim())
    )
      return;
    const request = ++generation.current;
    setItems([]);
    setError("");
    setState("loading");
    setIntents([]);
    setIntentError("");
    setIntentState("loading");
    setCanRetry(false);
    setReview(null);
    setRetryNote("");
    setCapabilityNote("Checking retry access…");
    void getSmsCapabilities(token)
      .then((result) => {
        if (request !== generation.current) return;
        const allowed = result?.canRetryEnqueueIntent === true;
        setCanRetry(allowed);
        setCapabilityNote(
          allowed
            ? "Owner/admin retry access verified for this snapshot."
            : "Read-only access: retry requires an owner or admin.",
        );
      })
      .catch(() => {
        if (request !== generation.current) return;
        setCanRetry(false);
        setCapabilityNote(
          "Retry access could not be verified. Recovery controls remain unavailable; load history to check again.",
        );
      });
    void listSmsEnqueueIntents(token)
      .then((result) => {
        if (request !== generation.current) return;
        setIntents(result);
        setIntentState("ready");
      })
      .catch((failure: unknown) => {
        if (request !== generation.current) return;
        setIntentError(
          failure instanceof ApiError && [401, 403].includes(failure.status)
            ? "Enqueue intent access denied. Use a current owner, admin or dispatcher token for this tenant."
            : "Enqueue intents could not be loaded. Check the connection and try again.",
        );
        setIntentState("error");
      });
    try {
      const result = await listSmsHistory(token, jobId.trim());
      if (request !== generation.current) return;
      setItems(result);
      setState("ready");
    } catch (failure) {
      if (request !== generation.current) return;
      setError(
        failure instanceof ApiError && [401, 403].includes(failure.status)
          ? "Access denied. Use a current owner, admin or dispatcher token for this tenant."
          : "Message history could not be loaded. Check the connection and try again.",
      );
      setState("error");
    }
  }

  const visible = filterHistory(items, filter);
  const validJob = validHistoryJobId(jobId.trim());
  return (
    <main className={styles.shell}>
      <aside className={styles.nav}>
        <a href="/app/dispatch" className={styles.brand}>
          <span>S</span>
          <div>
            Signmons<small>CALLDESK</small>
          </div>
        </a>
        <nav aria-label="CallDesk">
          <a href="/app/dispatch">Dispatch board</a>
          <a href="/app/notifications" aria-current="page">
            Notification center
          </a>
        </nav>
        <p>
          Operational visibility.
          <br />
          Human-controlled recovery.
        </p>
      </aside>
      <section className={styles.workspace}>
        <header>
          <p className={styles.eyebrow}>Operations / Communications</p>
          <h1>Notification center</h1>
          <p>Track customer SMS without exposing message content.</p>
          <span className={styles.readOnly}>Guarded recovery checkpoint</span>
        </header>
        <form
          className={styles.connection}
          onSubmit={(event) => {
            event.preventDefault();
            void load();
          }}
        >
          <label>
            Operator ID token
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={token}
              onChange={(event) => {
                clearResults();
                setToken(event.target.value);
              }}
              placeholder="Paste Firebase operator ID token"
            />
          </label>
          <label>
            <span>
              Job ID <small>(optional)</small>
            </span>
            <input
              value={jobId}
              spellCheck={false}
              aria-invalid={!validJob}
              aria-describedby={!validJob ? "job-error" : undefined}
              onChange={(event) => {
                clearResults();
                setJobId(event.target.value);
              }}
              placeholder="All jobs in your tenant"
            />
          </label>
          <button
            disabled={
              !token.trim() ||
              !validJob ||
              retryBusy ||
              state === "loading" ||
              intentState === "loading"
            }
            type="submit"
          >
            {state === "loading" || intentState === "loading"
              ? "Loading…"
              : "Load history"}
          </button>
          <button
            type="button"
            onClick={() => {
              clearResults();
              setToken("");
              setJobId("");
            }}
          >
            Clear session
          </button>
          {!validJob && (
            <p id="job-error" className={styles.error}>
              Enter a complete job UUID or leave the field empty.
            </p>
          )}
          <p className={styles.help}>
            Tenant and role are verified by the server. Tokens stay in memory
            only.
          </p>
        </form>
        <div className={styles.summary} aria-label="Loaded history counts">
          <div>
            <span>Loaded records</span>
            <strong>{items.length}</strong>
          </div>
          <div>
            <span>Needs attention</span>
            <strong>{filterHistory(items, "attention").length}</strong>
          </div>
          <div>
            <span>Delivery unconfirmed</span>
            <strong>{filterHistory(items, "pending").length}</strong>
          </div>
          <div>
            <span>Delivered</span>
            <strong>{filterHistory(items, "delivered").length}</strong>
          </div>
        </div>
        <section
          className={styles.history}
          aria-label="SMS history"
          aria-busy={state === "loading"}
        >
          <div className={styles.listHeader}>
            <div>
              <h2>Message activity</h2>
              <p>
                Latest 100 records for this query · timestamps in UTC · refresh
                manually
              </p>
            </div>
            <label>
              Show
              <select
                aria-label="History status"
                value={filter}
                onChange={(event) =>
                  setFilter(event.target.value as HistoryFilter)
                }
              >
                <option value="all">All activity</option>
                <option value="attention">Needs attention</option>
                <option value="pending">Delivery unconfirmed</option>
                <option value="delivered">Delivered</option>
              </select>
            </label>
          </div>
          {error && (
            <p role="alert" className={styles.error}>
              {error}
            </p>
          )}
          <div role="status" className={styles.status}>
            {state === "idle"
              ? "Enter an operator token and load history to begin."
              : state === "loading"
                ? "Loading message activity…"
                : state === "ready"
                  ? `${visible.length} records shown from ${items.length} loaded.`
                  : "No records displayed."}
          </div>
          {state === "ready" && visible.length === 0 && (
            <div className={styles.empty}>
              <h3>
                {items.length
                  ? "No activity matches this filter"
                  : "No message activity found"}
              </h3>
              <p>
                {items.length
                  ? "Choose another status to review the loaded records."
                  : "This query returned no records. That does not prove every job has a notification."}
              </p>
            </div>
          )}
          <ol className={styles.list}>
            {visible.map((item) => (
              <li key={item.id}>
                <div className={styles.eventTop}>
                  <div>
                    <span className={styles.direction}>
                      {item.direction === "INBOUND"
                        ? "Inbound SMS"
                        : "Outbound SMS"}
                    </span>
                    <h3>{messageLabel(item.templateKey)}</h3>
                  </div>
                  <span
                    className={styles.badge}
                    data-attention={["FAILED", "DEAD_LETTER"].includes(
                      item.status,
                    )}
                  >
                    {statusLabel(item.status)}
                  </span>
                </div>
                <dl>
                  <div>
                    <dt>Job</dt>
                    <dd>{item.jobId ?? "Not linked to a job"}</dd>
                  </div>
                  <div>
                    <dt>Recorded</dt>
                    <dd>
                      <time dateTime={item.occurredAt}>
                        {historyTime(item.occurredAt)}
                      </time>
                    </dd>
                  </div>
                  <div>
                    <dt>Attempts / template</dt>
                    <dd>
                      {item.attemptCount}{" "}
                      {item.attemptCount === 1 ? "attempt" : "attempts"} ·{" "}
                      {item.templateVersion
                        ? `v${item.templateVersion}`
                        : "Not versioned"}
                    </dd>
                  </div>
                  <div>
                    <dt>Failure code</dt>
                    <dd>
                      {item.lastErrorCode === "calendar_sync_pending"
                        ? "On hold for Calendar review"
                        : (item.lastErrorCode ?? "None recorded")}
                    </dd>
                  </div>
                </dl>
                <p className={styles.eventId}>Event {item.id}</p>
              </li>
            ))}
          </ol>
        </section>
        <EnqueueIntents
          items={intents}
          state={intentState}
          error={intentError}
          filter={intentFilter}
          jobId={jobId.trim()}
          onFilter={setIntentFilter}
          canRetry={canRetry && !retryBusy && !review}
          onReview={setReview}
          recovery={
            <>
              {capabilityNote && (
                <p role="status" className={styles.status}>
                  {capabilityNote}
                </p>
              )}
              {retryBusy && (
                <p role="status" className={styles.status}>
                  Submitting retry… Clearing the session does not undo a request
                  already accepted by the server.
                </p>
              )}
              {retryNote && (
                <p role="status" className={styles.status}>
                  {retryNote}
                </p>
              )}
              {review && (
                <IntentRetryReview
                  key={review.id}
                  item={review}
                  onCancel={() => setReview(null)}
                  onConfirm={(reason) => {
                    void submitRetry(reason);
                  }}
                />
              )}
            </>
          }
        />
        <p className={styles.footnote}>
          History and intents are separate snapshots, not a complete
          notification audit. Queue acknowledgment and sent status are not proof
          of delivery. Message bodies, phone numbers and provider IDs are
          withheld. Direct sending, dead-letter replay, template editing and
          email are not available in this screen. Intent retry requires
          owner/admin review.
        </p>
      </section>
    </main>
  );
}
