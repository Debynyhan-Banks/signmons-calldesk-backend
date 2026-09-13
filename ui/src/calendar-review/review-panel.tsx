"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { CalendarReviewClient } from "./client.ts";
import type { ReviewReader, ReviewView } from "./client.ts";
import { operationLabel, validReference } from "./contract.ts";
import type { ReviewResource } from "./contract.ts";
import styles from "./review-panel.module.css";

type Props = {
  sessionKey: string;
  role: string | null;
  read: ReviewReader;
  onClearSession?: () => void;
};

/** Unlinked component contract. Parent identity is a display gate, not authority.
 * sessionKey is a non-secret generation marker, never a bearer token.
 * Future real API reads must still verify bearer identity and tenant server-side.
 */
export function CalendarReviewPanel(props: Props) {
  return (
    <ReviewWorkspace
      key={JSON.stringify([props.sessionKey, props.role])}
      {...props}
    />
  );
}

function ReviewWorkspace({ sessionKey, role, read, onClearSession }: Props) {
  const client = useMemo(() => new CalendarReviewClient(read), [read]);
  const state = useSyncExternalStore(
    client.subscribe,
    client.getState,
    client.getState,
  );
  const [jobId, setJobId] = useState("");
  const [operationId, setOperationId] = useState("");
  useEffect(() => {
    setJobId("");
    setOperationId("");
    client.setScope({ sessionKey, role, jobId: "", operationId: "" });
    return () => client.clear();
  }, [client, sessionKey, role]);
  function edit(job: string, operation: string) {
    setJobId(job);
    setOperationId(operation);
    client.setScope({ sessionKey, role, jobId: job, operationId: operation });
  }
  const names: Record<ReviewResource, string> = {
    job: "Job operation history",
    operation: "Exact operation snapshot",
    requests: "Recovery request history",
  };
  return (
    <section className={styles.panel} aria-label="Calendar review">
      <header>
        <span className={styles.tag}>Read-only · inactive preview</span>
        <h2>Calendar review</h2>
        <p>
          Review journal snapshots and recorded requests. Nothing here confirms
          a current booking or starts recovery.
        </p>
      </header>
      {!state.allowed ? (
        <p role="status" className={styles.notice}>
          Owner or admin review access is required. Start a new authorized
          session to continue.
        </p>
      ) : (
        <>
          <div className={styles.references}>
            <label>
              Job reference
              <input
                value={jobId}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => edit(event.target.value, operationId)}
              />
            </label>
            <label>
              Operation reference
              <input
                value={operationId}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => edit(jobId, event.target.value)}
              />
            </label>
            <button
              type="button"
              onClick={() => {
                setJobId("");
                setOperationId("");
                client.clear();
                onClearSession?.();
              }}
            >
              Clear review session
            </button>
          </div>
          <p className={styles.notice}>
            These are separate reads, not one combined receipt. Changing either
            reference clears all displayed snapshots.
          </p>
          <div className={styles.views}>
            {(["job", "operation", "requests"] as ReviewResource[]).map(
              (resource) => (
                <section
                  key={resource}
                  aria-label={names[resource]}
                  className={styles.view}
                >
                  <div className={styles.heading}>
                    <h3>{names[resource]}</h3>
                    <button
                      type="button"
                      disabled={
                        state.views[resource].state === "loading" ||
                        !validReference(
                          resource === "job" ? jobId : operationId,
                        )
                      }
                      onClick={() => void client.load(resource)}
                    >
                      {state.views[resource].state === "loading"
                        ? "Loading…"
                        : "Load snapshot"}
                    </button>
                  </div>
                  <SnapshotView
                    view={state.views[resource]}
                    resource={resource}
                  />
                </section>
              ),
            )}
          </div>
        </>
      )}
      <footer>
        Snapshot hints are not permission to act. Request records do not prove
        execution or success. Refresh manually when needed; no automatic
        recovery or retry is available.
      </footer>
    </section>
  );
}

function SnapshotView({
  view,
  resource,
}: {
  view: ReviewView;
  resource: ReviewResource;
}) {
  if (view.state === "error")
    return (
      <p role="alert" className={styles.error}>
        {view.message}
      </p>
    );
  if (view.state !== "ready" || !view.data)
    return (
      <p role="status">
        {view.state === "loading"
          ? "Loading a new snapshot. Earlier data has been cleared."
          : "No snapshot loaded."}
      </p>
    );
  return (
    <div aria-live="polite">
      {resource === "requests" && (
        <p className={styles.notice}>Requests only · not completion evidence</p>
      )}
      {view.data.items.length === 0 && (
        <p>
          No records returned. This does not prove that no earlier Calendar work
          or recovery exists.
        </p>
      )}
      {view.data.hasMore && (
        <p className={styles.notice}>
          Showing the newest 100 records. Older records are omitted; this is not
          a complete inventory.
        </p>
      )}
      <ul className={styles.records}>
        {view.data.items.map((item) =>
          "requestId" in item ? (
            <li key={item.requestId}>
              <h4>
                {item.kind === "applied_create"
                  ? "Ended-attempt read-back requested"
                  : "Uncertain-attempt read-back requested"}
              </h4>
              <p>Request {item.requestId}</p>
              <p>
                Requested (UTC):{" "}
                <time dateTime={item.requestedAt}>{item.requestedAt}</time>
              </p>
            </li>
          ) : (
            <li key={item.operationId}>
              <h4>{operationLabel(item.status)}</h4>
              <dl>
                <div>
                  <dt>Operation</dt>
                  <dd>{item.operationId}</dd>
                </div>
                <div>
                  <dt>Job</dt>
                  <dd>{item.jobId}</dd>
                </div>
                <div>
                  <dt>Action</dt>
                  <dd>{item.action}</dd>
                </div>
                <div>
                  <dt>Observed version (UTC)</dt>
                  <dd>
                    <time dateTime={item.updatedAt}>{item.updatedAt}</time>
                  </dd>
                </div>
              </dl>
              {item.pendingHoldReviewCandidate && (
                <p>
                  Unattempted CREATE observed. No hold action is available here.
                </p>
              )}
              {item.recoveryReadbackNotBefore && (
                <p>
                  Saved read-back boundary (UTC):{" "}
                  {item.recoveryReadbackNotBefore}. This is not a countdown or
                  permission.
                </p>
              )}
              <p>
                {item.recoveryReviewCandidate
                  ? "The server reported a local review timing hint at read time. Eligibility must be checked again before any future action."
                  : "No recovery review hint was reported in this snapshot."}
              </p>
            </li>
          ),
        )}
      </ul>
    </div>
  );
}
