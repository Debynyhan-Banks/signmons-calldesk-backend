"use client";
import { useEffect, useRef, useState } from "react";
import {
  readTechnicianNotifications,
  TechnicianInboxError,
  technicianNotificationLabels,
  type TechnicianNotificationSnapshot,
} from "@/lib/technician-notifications";
import styles from "./technician-inbox.module.css";

export function TechnicianInbox({ token }: { token: string }) {
  const binding = useRef({ token, generation: 0 });
  if (binding.current.token !== token) {
    binding.current = { token, generation: binding.current.generation + 1 };
  }
  return <InboxSession key={binding.current.generation} token={token} />;
}

function InboxSession({ token }: { token: string }) {
  const [view, setView] = useState<TechnicianNotificationSnapshot | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [denied, setDenied] = useState(false);
  const generation = useRef(0),
    pending = useRef(false),
    abort = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      generation.current++;
      abort.current?.abort();
    },
    [],
  );
  function clear() {
    generation.current++;
    abort.current?.abort();
    setView(null);
    setNotice("");
  }
  async function refresh() {
    if (pending.current || denied || !token) return;
    pending.current = true;
    setBusy(true);
    setView(null);
    setNotice("Loading notifications…");
    const current = ++generation.current,
      controller = new AbortController();
    abort.current = controller;
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const result = await readTechnicianNotifications(
        token,
        controller.signal,
      );
      if (generation.current !== current) return;
      setView(result);
      setNotice(
        result.items.length
          ? "Notifications loaded."
          : "No recent notifications for your current assignments.",
      );
    } catch (error) {
      if (generation.current !== current) return;
      if (
        error instanceof TechnicianInboxError &&
        [401, 403].includes(error.status)
      ) {
        setDenied(true);
        setNotice(
          "This technician link is invalid, expired or no longer active. Ask dispatch for a new link.",
        );
      } else setNotice("Notifications unavailable. Refresh to try again.");
    } finally {
      clearTimeout(timer);
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <section className={styles.inbox} aria-label="Technician notifications">
      <div className={styles.heading}>
        <div>
          <p className={styles.eyebrow}>Assignment activity</p>
          <h2>Notifications</h2>
        </div>
        <div className={styles.actions}>
          <button
            type="button"
            disabled={busy || denied || !token}
            onClick={() => void refresh()}
          >
            Refresh notifications
          </button>
          <button type="button" onClick={clear}>
            Clear notifications
          </button>
        </div>
      </div>
      <p>
        Recent recorded changes for jobs assigned to you now. Open your jobs
        below for current details.
      </p>
      <p className={styles.boundary}>
        Read-only · Last 90 days · Up to 100 events. This is job activity, not
        proof that a message was sent or read. Reassigned or deleted jobs
        disappear on refresh; earlier activity on your current jobs may be
        included.
      </p>
      <p role="status">{notice || "Refresh to load your notifications."}</p>
      {view && (
        <>
          <p className={styles.meta}>
            Snapshot: {new Date(view.asOf).toLocaleString()} ·{" "}
            {view.items.length} events
            {view.hasMore
              ? " · More events exist; only the latest 100 are shown."
              : ""}
          </p>
          <ol className={styles.list}>
            {view.items.map((item) => (
              <li key={item.id}>
                <div>
                  <strong>{technicianNotificationLabels[item.action]}</strong>
                  <p>
                    Job {item.jobId.replace(/-/g, "").slice(0, 8).toUpperCase()}
                  </p>
                </div>
                <time dateTime={item.occurredAt}>
                  {new Date(item.occurredAt).toLocaleString()}
                </time>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
