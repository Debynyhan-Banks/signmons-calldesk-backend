"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ApiError,
  IntakeReviewDetail,
  IntakeReviewSummary,
  RequestAuth,
  getIntakeReview,
  listIntakeReviews,
  reviewIntakeReadiness,
} from "@/lib/api";
import {
  IntakeFilter,
  filterIntakes,
  intakeMetrics,
  missingFieldLabels,
} from "@/lib/intake-review";
import styles from "./intake-review.module.css";

type AuthMode = "firebase" | "dev";

const formatDate = (value: string) =>
  new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));

const display = (value: string | null) => value || "Missing";

export default function IntakeReviewPage() {
  const hasDevAuth = Boolean(process.env.NEXT_PUBLIC_DEV_AUTH_SECRET);
  const [authMode, setAuthMode] = useState<AuthMode>(
    hasDevAuth ? "dev" : "firebase",
  );
  const [tenantId, setTenantId] = useState(
    process.env.NEXT_PUBLIC_TENANT_ID ?? "",
  );
  const [bearerToken, setBearerToken] = useState("");
  const [intakes, setIntakes] = useState<IntakeReviewSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<IntakeReviewDetail | null>(null);
  const [filter, setFilter] = useState<IntakeFilter>("all");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const auth = useMemo<RequestAuth>(() => {
    if (authMode === "firebase") return { bearerToken };
    return {
      devAuth: {
        secret: process.env.NEXT_PUBLIC_DEV_AUTH_SECRET ?? "",
        role: process.env.NEXT_PUBLIC_DEV_AUTH_ROLE ?? "dispatcher",
        userId: process.env.NEXT_PUBLIC_DEV_AUTH_USER_ID ?? "dev-dispatcher",
        tenantId,
      },
    };
  }, [authMode, bearerToken, tenantId]);

  const authReady =
    authMode === "firebase"
      ? Boolean(bearerToken.trim())
      : Boolean(hasDevAuth && tenantId.trim());

  const loadDetail = useCallback(
    async (jobId: string) => {
      setSelectedId(jobId);
      setDetailLoading(true);
      setError(null);
      try {
        setDetail(await getIntakeReview(jobId, auth, tenantId));
      } catch (loadError) {
        setError(errorMessage(loadError));
        setDetail(null);
      } finally {
        setDetailLoading(false);
      }
    },
    [auth, tenantId],
  );

  const loadIntakes = useCallback(async () => {
    if (!authReady) return;
    setLoading(true);
    setError(null);
    try {
      const next = await listIntakeReviews(auth, tenantId);
      setIntakes(next);
      const nextSelection =
        next.find((item) => item.jobId === selectedId)?.jobId ??
        next[0]?.jobId ??
        null;
      if (nextSelection) await loadDetail(nextSelection);
      else {
        setSelectedId(null);
        setDetail(null);
      }
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, [auth, authReady, loadDetail, selectedId, tenantId]);

  useEffect(() => {
    if (hasDevAuth && tenantId) void loadIntakes();
    // First dev-mode load only; subsequent requests are operator initiated.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visibleIntakes = useMemo(
    () => filterIntakes(intakes, filter, search),
    [filter, intakes, search],
  );
  const metrics = useMemo(() => intakeMetrics(intakes), [intakes]);

  const confirmReview = async () => {
    if (!selectedId) return;
    setReviewing(true);
    setError(null);
    try {
      await reviewIntakeReadiness(selectedId, auth, tenantId);
      await loadDetail(selectedId);
      const refreshed = await listIntakeReviews(auth, tenantId);
      setIntakes(refreshed);
    } catch (reviewError) {
      setError(errorMessage(reviewError));
    } finally {
      setReviewing(false);
    }
  };

  return (
    <main className={styles.shell}>
      <aside className={styles.nav}>
        <a className={styles.brand} href="/">
          <span className={styles.mark}>S</span>
          <span>
            <strong>Signmons</strong>
            <small>CallDesk</small>
          </span>
        </a>
        <nav aria-label="CallDesk">
          <a className={styles.activeNav} href="/app/intake-review">
            <span aria-hidden="true">01</span> Intake review
          </a>
          <a className={styles.disabledNav} href="/app/urgency-review">
            <span aria-hidden="true">02</span> Urgency review
          </a>
          <a className={styles.disabledNav} href="/app/dispatch">
            <span aria-hidden="true">03</span> Dispatch board
          </a>
        </nav>
        <div className={styles.navFooter}>
          <span className={styles.liveDot} /> Secure operator workspace
        </div>
      </aside>

      <section className={styles.workspace}>
        <header className={styles.topbar}>
          <div>
            <p className={styles.eyebrow}>Operations / Intake</p>
            <h1>Booking readiness</h1>
            <p>
              Know what is ready to dispatch—and what still needs attention.
            </p>
          </div>
          <div className={styles.connectionPanel}>
            <div
              className={styles.authTabs}
              role="group"
              aria-label="Authentication mode"
            >
              <button
                className={authMode === "firebase" ? styles.authActive : ""}
                onClick={() => setAuthMode("firebase")}
                type="button"
              >
                Operator token
              </button>
              {hasDevAuth ? (
                <button
                  className={authMode === "dev" ? styles.authActive : ""}
                  onClick={() => setAuthMode("dev")}
                  type="button"
                >
                  Local dev
                </button>
              ) : null}
            </div>
            {authMode === "firebase" ? (
              <input
                aria-label="Firebase operator ID token"
                onChange={(event) => setBearerToken(event.target.value)}
                placeholder="Paste Firebase operator ID token"
                type="password"
                value={bearerToken}
              />
            ) : (
              <input
                aria-label="Tenant ID"
                onChange={(event) => setTenantId(event.target.value)}
                placeholder="Tenant ID"
                value={tenantId}
              />
            )}
            <button
              className={styles.refreshButton}
              disabled={!authReady || loading}
              onClick={() => void loadIntakes()}
              type="button"
            >
              {loading ? "Loading…" : intakes.length ? "Refresh" : "Connect"}
            </button>
          </div>
        </header>

        {error ? (
          <div className={styles.error} role="alert">
            {error}
          </div>
        ) : null}

        <section className={styles.metrics} aria-label="Intake metrics">
          <Metric label="Open intakes" value={metrics.total} tone="neutral" />
          <Metric
            label="Needs information"
            value={metrics.missing}
            tone="warning"
          />
          <Metric
            label="Ready to assign"
            value={metrics.ready}
            tone="success"
          />
          <Metric
            label="Priority calls"
            value={metrics.priority}
            tone="danger"
          />
        </section>

        <section className={styles.board}>
          <div className={styles.queue}>
            <div className={styles.queueHeader}>
              <div>
                <h2>Incoming requests</h2>
                <p>{visibleIntakes.length} shown</p>
              </div>
              <input
                aria-label="Search intake requests"
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search customer, phone, or job"
                type="search"
                value={search}
              />
            </div>
            <div
              className={styles.filters}
              role="group"
              aria-label="Intake filters"
            >
              {(["all", "missing", "ready", "priority"] as IntakeFilter[]).map(
                (value) => (
                  <button
                    className={filter === value ? styles.filterActive : ""}
                    key={value}
                    onClick={() => setFilter(value)}
                    type="button"
                  >
                    {value}
                  </button>
                ),
              )}
            </div>
            <div className={styles.queueList}>
              {!authReady ? (
                <EmptyState
                  title="Connect your operator account"
                  copy="Use a verified Firebase operator token to load tenant-scoped requests."
                />
              ) : !loading && visibleIntakes.length === 0 ? (
                <EmptyState
                  title="No matching requests"
                  copy="New CallDesk jobs will appear here automatically."
                />
              ) : (
                visibleIntakes.map((intake) => (
                  <button
                    className={`${styles.intakeCard} ${selectedId === intake.jobId ? styles.intakeSelected : ""}`}
                    key={intake.jobId}
                    onClick={() => void loadDetail(intake.jobId)}
                    type="button"
                  >
                    <span className={styles.cardTopline}>
                      <strong>{display(intake.customerName)}</strong>
                      <time>{formatDate(intake.createdAt)}</time>
                    </span>
                    <span className={styles.cardCategory}>
                      {display(intake.serviceCategory)} · #{intake.reference}
                    </span>
                    <span className={styles.cardSummary}>
                      {display(intake.issueSummary)}
                    </span>
                    <span className={styles.badgeRow}>
                      <ReadinessBadge intake={intake} />
                      {intake.priority !== "STANDARD" ? (
                        <span className={styles.priorityBadge}>
                          {intake.priority}
                        </span>
                      ) : null}
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>

          <div className={styles.detail} aria-live="polite">
            {detailLoading ? (
              <EmptyState
                title="Loading request…"
                copy="Checking readiness and conversation history."
              />
            ) : detail ? (
              <IntakeDetail
                detail={detail}
                onReview={() => void confirmReview()}
                reviewing={reviewing}
              />
            ) : (
              <EmptyState
                title="Select an intake"
                copy="Review the request, missing fields, and conversation trace before dispatch."
              />
            )}
          </div>
        </section>
      </section>
    </main>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: string;
}) {
  return (
    <article className={`${styles.metric} ${styles[tone]}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function ReadinessBadge({ intake }: { intake: IntakeReviewSummary }) {
  const ready = intake.readiness.state === "READY_TO_ASSIGN";
  return (
    <span className={ready ? styles.readyBadge : styles.missingBadge}>
      {ready
        ? "Ready to assign"
        : `${intake.readiness.missingFields.length} missing`}
    </span>
  );
}

function IntakeDetail({
  detail,
  onReview,
  reviewing,
}: {
  detail: IntakeReviewDetail;
  onReview: () => void;
  reviewing: boolean;
}) {
  const ready = detail.readiness.state === "READY_TO_ASSIGN";
  return (
    <>
      <header className={styles.detailHeader}>
        <div>
          <p className={styles.eyebrow}>Job #{detail.reference}</p>
          <h2>{display(detail.customerName)}</h2>
          <p>Received {formatDate(detail.createdAt)}</p>
        </div>
        <ReadinessBadge intake={detail} />
      </header>

      {detail.priority !== "STANDARD" ? (
        <div className={styles.priorityAlert}>
          <strong>{detail.priority} request</strong>
          <span>Review immediately before routine work.</span>
        </div>
      ) : null}

      {!ready ? (
        <section className={styles.missingPanel}>
          <h3>Complete before assignment</h3>
          <div>
            {detail.readiness.missingFields.map((field) => (
              <span key={field}>{missingFieldLabels[field] ?? field}</span>
            ))}
          </div>
        </section>
      ) : (
        <section className={styles.readyPanel}>
          <strong>All required booking details are present.</strong>
          <span>This request can move to technician assignment.</span>
        </section>
      )}

      <section className={styles.fieldSection}>
        <h3>Request details</h3>
        <dl className={styles.fieldGrid}>
          <Field label="Phone" value={detail.phone} />
          <Field label="Service" value={detail.serviceCategory} />
          <Field label="Address" value={detail.serviceAddress} wide />
          <Field label="Preferred window" value={detail.preferredWindow} />
          <Field label="Urgency" value={detail.urgency} />
          <Field
            label="Deposit"
            value={
              detail.depositRequired ? detail.paymentStatus : "Not required"
            }
          />
          <Field
            label="Source"
            value={detail.sourceChannel || "Direct / untracked"}
          />
          <Field
            label="Photos"
            value={
              detail.photos.length
                ? `${detail.photos.length} attached`
                : "None provided"
            }
          />
          <Field label="Issue summary" value={detail.issueSummary} wide />
        </dl>
      </section>

      <section className={styles.transcriptSection}>
        <div className={styles.sectionTitle}>
          <h3>Conversation trace</h3>
          <span>{detail.transcript.length} messages</span>
        </div>
        <div className={styles.transcript}>
          {detail.transcript.length ? (
            detail.transcript.map((entry) => (
              <article className={styles.transcriptEntry} key={entry.id}>
                <span>{entry.role}</span>
                <p>{entry.content}</p>
                <time>{formatDate(entry.occurredAt)}</time>
              </article>
            ))
          ) : (
            <p className={styles.noTranscript}>
              No linked transcript was retained for this intake.
            </p>
          )}
        </div>
      </section>

      {detail.photos.length ? (
        <section className={styles.attachmentSection}>
          <h3>Customer attachments</h3>
          <div>
            {detail.photos.map((photo, index) => (
              <a href={photo} key={photo} rel="noreferrer" target="_blank">
                View photo {index + 1}
              </a>
            ))}
          </div>
        </section>
      ) : null}

      <footer className={styles.reviewFooter}>
        <div>
          <strong>
            {detail.reviewHistory.length} recorded review
            {detail.reviewHistory.length === 1 ? "" : "s"}
          </strong>
          <span>
            Reviewing records the current result without changing the job.
          </span>
        </div>
        <button disabled={reviewing} onClick={onReview} type="button">
          {reviewing ? "Recording…" : "Record readiness review"}
        </button>
      </footer>
    </>
  );
}

function Field({
  label,
  value,
  wide = false,
}: {
  label: string;
  value: string | null;
  wide?: boolean;
}) {
  return (
    <div className={wide ? styles.wideField : undefined}>
      <dt>{label}</dt>
      <dd className={!value ? styles.fieldMissing : undefined}>
        {display(value)}
      </dd>
    </div>
  );
}

function EmptyState({ title, copy }: { title: string; copy: string }) {
  return (
    <div className={styles.emptyState}>
      <span aria-hidden="true">✓</span>
      <h3>{title}</h3>
      <p>{copy}</p>
    </div>
  );
}

function errorMessage(error: unknown) {
  return error instanceof ApiError
    ? `${error.status}: ${error.message}`
    : "CallDesk could not load the intake queue.";
}
