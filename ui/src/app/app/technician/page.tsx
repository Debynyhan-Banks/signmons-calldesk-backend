"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ApiError,
  TechnicianJobAction,
  TechnicianJobDetail,
  TechnicianJobList,
  TechnicianJobSummary,
  getTechnicianJob,
  listTechnicianJobs,
  updateTechnicianJob,
} from "@/lib/api";
import {
  TechnicianJobGroup,
  primaryTechnicianAction,
  secondaryTechnicianActions,
  technicianActionLabel,
  technicianStatusLabel,
  technicianTokenFromHash,
} from "@/lib/technician-workflow";
import styles from "./technician.module.css";

const groupLabels: Record<TechnicianJobGroup, string> = {
  today: "Today",
  upcoming: "Upcoming",
  completed: "Completed",
};

function formatWindow(
  start: string | null,
  end: string | null,
  timezone: string,
) {
  if (!start) return "Schedule pending";
  const date = new Date(start);
  const dateLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(date);
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
  const endTime = end
    ? new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(end))
    : null;
  return `${dateLabel} · ${time}${endTime ? `–${endTime}` : ""}`;
}

export default function TechnicianPage() {
  const [token, setToken] = useState("");
  const [data, setData] = useState<TechnicianJobList | null>(null);
  const [group, setGroup] = useState<TechnicianJobGroup>("today");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TechnicianJobDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(
    async (accessToken: string, preferredId?: string) => {
      setLoading(true);
      setError(null);
      try {
        const next = await listTechnicianJobs(accessToken);
        setData(next);
        const all = [
          ...next.groups.today,
          ...next.groups.upcoming,
          ...next.groups.completed,
        ];
        const nextId =
          all.find((job) => job.jobId === preferredId)?.jobId ??
          next.groups.today[0]?.jobId ??
          next.groups.upcoming[0]?.jobId ??
          next.groups.completed[0]?.jobId ??
          null;
        setSelectedId(nextId);
        if (nextId) setDetail(await getTechnicianJob(accessToken, nextId));
        else setDetail(null);
      } catch (loadError) {
        setData(null);
        setDetail(null);
        setError(messageFor(loadError));
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    const accessToken = technicianTokenFromHash(window.location.hash);
    setToken(accessToken);
    if (!accessToken) {
      setLoading(false);
      setError(
        "This technician link is missing. Ask dispatch for a new secure link.",
      );
      return;
    }
    void load(accessToken);
  }, [load]);

  const jobs = data?.groups[group] ?? [];
  const counts = useMemo(
    () => ({
      today: data?.groups.today.length ?? 0,
      upcoming: data?.groups.upcoming.length ?? 0,
      completed: data?.groups.completed.length ?? 0,
    }),
    [data],
  );

  const selectJob = async (job: TechnicianJobSummary) => {
    setSelectedId(job.jobId);
    setError(null);
    setNotice(null);
    try {
      setDetail(await getTechnicianJob(token, job.jobId));
    } catch (loadError) {
      setError(messageFor(loadError));
    }
  };

  const takeAction = async (action: TechnicianJobAction) => {
    if (!detail || !token) return;
    if (
      ["decline", "cannot_take", "complete"].includes(action) &&
      !window.confirm(`${technicianActionLabel(action)}?`)
    ) {
      return;
    }
    setActing(true);
    setError(null);
    setNotice(null);
    try {
      const result = await updateTechnicianJob(token, detail.jobId, {
        action,
        expectedUpdatedAt: detail.updatedAt,
      });
      setNotice(
        action === "decline" || action === "cannot_take"
          ? "Dispatch was notified and the job was returned for reassignment."
          : `${technicianActionLabel(action)} recorded for dispatch.`,
      );
      const keepSelected =
        "assignmentReleased" in result ? undefined : detail.jobId;
      await load(token, keepSelected);
    } catch (actionError) {
      setError(messageFor(actionError));
    } finally {
      setActing(false);
    }
  };

  const primary = detail ? primaryTechnicianAction(detail) : null;
  const secondary = detail ? secondaryTechnicianActions(detail) : [];

  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <a className={styles.brand} href="/" aria-label="Signmons CallDesk">
          <span className={styles.mark}>S</span>
          <span>
            <strong>Signmons</strong>
            <small>CallDesk field</small>
          </span>
        </a>
        {data && (
          <div className={styles.identity}>
            <span className={styles.secureDot} />
            <span>
              <small>Signed in as</small>
              <strong>{data.technician.fullName}</strong>
            </span>
          </div>
        )}
      </header>

      <section className={styles.content}>
        <div className={styles.titleRow}>
          <div>
            <p className={styles.eyebrow}>Technician workspace</p>
            <h1>Your jobs</h1>
            <p>
              Review the assignment, update your status and keep dispatch in
              sync.
            </p>
          </div>
          <button
            type="button"
            className={styles.refresh}
            disabled={!token || loading}
            onClick={() => void load(token, selectedId ?? undefined)}
          >
            Refresh
          </button>
        </div>

        {error && (
          <div className={styles.error} role="alert">
            {error}
          </div>
        )}
        {notice && (
          <div className={styles.notice} role="status">
            {notice}
          </div>
        )}

        {loading && (
          <div className={styles.loading}>Loading secure assignments…</div>
        )}

        {!loading && data && (
          <>
            <nav className={styles.tabs} aria-label="Job groups">
              {(Object.keys(groupLabels) as TechnicianJobGroup[]).map((key) => (
                <button
                  key={key}
                  type="button"
                  className={group === key ? styles.activeTab : ""}
                  onClick={() => setGroup(key)}
                >
                  {groupLabels[key]} <span>{counts[key]}</span>
                </button>
              ))}
            </nav>

            <div className={styles.workspace}>
              <section
                className={styles.list}
                aria-label={`${groupLabels[group]} jobs`}
              >
                {jobs.length === 0 && (
                  <div className={styles.empty}>
                    No {groupLabels[group].toLowerCase()} jobs.
                  </div>
                )}
                {jobs.map((job) => (
                  <button
                    type="button"
                    key={job.jobId}
                    className={`${styles.jobCard} ${selectedId === job.jobId ? styles.selected : ""}`}
                    onClick={() => void selectJob(job)}
                  >
                    <span className={styles.cardTop}>
                      <strong>{job.serviceCategory}</strong>
                      <span className={styles.status}>
                        {technicianStatusLabel(job.technicianStatus)}
                      </span>
                    </span>
                    <span className={styles.window}>
                      {formatWindow(
                        job.serviceWindowStart,
                        job.serviceWindowEnd,
                        data.timezone,
                      )}
                    </span>
                    <span className={styles.address}>{job.serviceAddress}</span>
                    <span className={styles.reference}>
                      Job {job.reference} · {job.urgency.toLowerCase()}
                    </span>
                  </button>
                ))}
              </section>

              <section className={styles.detail} aria-live="polite">
                {!detail && (
                  <div className={styles.empty}>
                    Select a job to see its details.
                  </div>
                )}
                {detail && (
                  <>
                    <div className={styles.detailHeader}>
                      <div>
                        <p className={styles.eyebrow}>Job {detail.reference}</p>
                        <h2>{detail.serviceCategory}</h2>
                      </div>
                      <span className={styles.detailStatus}>
                        {technicianStatusLabel(detail.technicianStatus)}
                      </span>
                    </div>

                    <div className={styles.callout}>
                      <span>Scheduled</span>
                      <strong>
                        {formatWindow(
                          detail.serviceWindowStart,
                          detail.serviceWindowEnd,
                          data.timezone,
                        )}
                      </strong>
                    </div>

                    <dl className={styles.details}>
                      <div>
                        <dt>Customer</dt>
                        <dd>{detail.customer.fullName}</dd>
                      </div>
                      <div>
                        <dt>Phone</dt>
                        <dd>
                          <a href={`tel:${detail.customer.phone}`}>
                            {detail.customer.phone}
                          </a>
                        </dd>
                      </div>
                      <div>
                        <dt>Service address</dt>
                        <dd>{detail.serviceAddress}</dd>
                      </div>
                      <div>
                        <dt>Issue</dt>
                        <dd>
                          {detail.issueSummary || "No issue summary provided."}
                        </dd>
                      </div>
                      {detail.accessNotes && (
                        <div>
                          <dt>Access notes</dt>
                          <dd>{detail.accessNotes}</dd>
                        </div>
                      )}
                    </dl>

                    <div className={styles.actions}>
                      {primary && (
                        <button
                          type="button"
                          className={styles.primaryAction}
                          disabled={acting}
                          onClick={() => void takeAction(primary)}
                        >
                          {acting
                            ? "Updating…"
                            : technicianActionLabel(primary)}
                        </button>
                      )}
                      {secondary.map((action) => (
                        <button
                          type="button"
                          className={styles.secondaryAction}
                          disabled={acting}
                          key={action}
                          onClick={() => void takeAction(action)}
                        >
                          {technicianActionLabel(action)}
                        </button>
                      ))}
                      <a
                        className={styles.callAction}
                        href={`tel:${detail.customer.phone}`}
                      >
                        Call customer
                      </a>
                    </div>
                  </>
                )}
              </section>
            </div>

            <p className={styles.expiry}>
              Secure link expires{" "}
              {new Intl.DateTimeFormat("en-US", {
                dateStyle: "medium",
                timeStyle: "short",
                timeZone: data.timezone,
              }).format(new Date(data.linkExpiresAt))}
              .
            </p>
          </>
        )}
      </section>
    </main>
  );
}

function messageFor(error: unknown): string {
  if (
    error instanceof ApiError &&
    (error.status === 401 || error.status === 403)
  ) {
    return "This secure link is invalid, expired or no longer active. Ask dispatch for a new link.";
  }
  if (error instanceof ApiError && error.status === 409) {
    return "This job changed in dispatch. Refresh before trying again.";
  }
  return error instanceof Error
    ? error.message
    : "The request could not be completed.";
}
