"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ApiError,
  RequestAuth,
  UrgencyLevel,
  UrgencyReviewDetail,
  UrgencyReviewSummary,
  escalateJobUrgency,
  getUrgencyReview,
  listUrgencyReviews,
  overrideJobUrgency,
} from "@/lib/api";
import {
  UrgencyFilter,
  filterUrgencyReviews,
  urgencyLabel,
  urgencyMetrics,
} from "@/lib/urgency-review";
import base from "../intake-review/intake-review.module.css";
import styles from "./urgency-review.module.css";

type AuthMode = "firebase" | "dev";

const formatDate = (value: string) =>
  new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));

export default function UrgencyReviewPage() {
  const hasDevAuth = Boolean(process.env.NEXT_PUBLIC_DEV_AUTH_SECRET);
  const [authMode, setAuthMode] = useState<AuthMode>(
    hasDevAuth ? "dev" : "firebase",
  );
  const [tenantId, setTenantId] = useState(
    process.env.NEXT_PUBLIC_TENANT_ID ?? "",
  );
  const [bearerToken, setBearerToken] = useState("");
  const [items, setItems] = useState<UrgencyReviewSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<UrgencyReviewDetail | null>(null);
  const [filter, setFilter] = useState<UrgencyFilter>("all");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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
      setError(null);
      try {
        setDetail(await getUrgencyReview(jobId, auth, tenantId));
      } catch (loadError) {
        setError(errorMessage(loadError));
        setDetail(null);
      }
    },
    [auth, tenantId],
  );

  const loadItems = useCallback(async () => {
    if (!authReady) return;
    setLoading(true);
    setError(null);
    try {
      const next = await listUrgencyReviews(auth, tenantId);
      setItems(next);
      const nextId =
        next.find((item) => item.jobId === selectedId)?.jobId ??
        next[0]?.jobId ??
        null;
      if (nextId) await loadDetail(nextId);
      else setDetail(null);
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, [auth, authReady, loadDetail, selectedId, tenantId]);

  useEffect(() => {
    if (hasDevAuth && tenantId) void loadItems();
    // Initial local load only; later refreshes are operator initiated.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visible = useMemo(
    () => filterUrgencyReviews(items, filter, search),
    [filter, items, search],
  );
  const metrics = useMemo(() => urgencyMetrics(items), [items]);

  const refreshSelected = async () => {
    if (!selectedId) return;
    await loadDetail(selectedId);
    setItems(await listUrgencyReviews(auth, tenantId));
  };

  const override = async (urgency: UrgencyLevel, reason: string) => {
    if (!selectedId) return;
    setActing(true);
    setError(null);
    setNotice(null);
    try {
      const result = await overrideJobUrgency(
        selectedId,
        { urgency, reason },
        auth,
        tenantId,
      );
      setNotice(
        result.changed
          ? `Urgency changed to ${urgencyLabel(result.urgency)}.`
          : "That urgency was already selected; no duplicate audit was created.",
      );
      await refreshSelected();
    } catch (actionError) {
      setError(errorMessage(actionError));
    } finally {
      setActing(false);
    }
  };

  const escalate = async () => {
    if (!selectedId) return;
    setActing(true);
    setError(null);
    setNotice(null);
    try {
      const result = await escalateJobUrgency(selectedId, auth, tenantId);
      const outcomes = result.escalation.deliveries
        .map((delivery) => `${delivery.channel}: ${delivery.outcome}`)
        .join(", ");
      setNotice(
        result.changed
          ? `Escalation recorded — ${outcomes}.`
          : `A recent escalation already exists — ${outcomes}. No duplicate notification was sent.`,
      );
      await refreshSelected();
    } catch (actionError) {
      setError(errorMessage(actionError));
    } finally {
      setActing(false);
    }
  };

  return (
    <main className={base.shell}>
      <aside className={base.nav}>
        <a className={base.brand} href="/">
          <span className={base.mark}>S</span>
          <span>
            <strong>Signmons</strong>
            <small>CallDesk</small>
          </span>
        </a>
        <nav aria-label="CallDesk">
          <a className={base.disabledNav} href="/app/intake-review">
            <span aria-hidden="true">01</span> Intake review
          </a>
          <a className={base.activeNav} href="/app/urgency-review">
            <span aria-hidden="true">02</span> Urgency review
          </a>
          <a className={base.disabledNav} href="/app/dispatch">
            <span aria-hidden="true">03</span> Dispatch board
          </a>
        </nav>
        <div className={base.navFooter}>
          <span className={base.liveDot} /> Explainable operator decisions
        </div>
      </aside>

      <section className={base.workspace}>
        <header className={base.topbar}>
          <div>
            <p className={base.eyebrow}>Operations / Urgency</p>
            <h1>Escalation review</h1>
            <p>Understand the classification, then act with an audit trail.</p>
          </div>
          <div className={base.connectionPanel}>
            <div
              className={base.authTabs}
              role="group"
              aria-label="Authentication mode"
            >
              <button
                className={authMode === "firebase" ? base.authActive : ""}
                onClick={() => setAuthMode("firebase")}
                type="button"
              >
                Operator token
              </button>
              {hasDevAuth ? (
                <button
                  className={authMode === "dev" ? base.authActive : ""}
                  onClick={() => setAuthMode("dev")}
                  type="button"
                >
                  Local dev
                </button>
              ) : null}
            </div>
            <input
              aria-label={
                authMode === "firebase"
                  ? "Firebase operator ID token"
                  : "Tenant ID"
              }
              onChange={(event) =>
                authMode === "firebase"
                  ? setBearerToken(event.target.value)
                  : setTenantId(event.target.value)
              }
              placeholder={
                authMode === "firebase"
                  ? "Paste Firebase operator ID token"
                  : "Tenant ID"
              }
              type={authMode === "firebase" ? "password" : "text"}
              value={authMode === "firebase" ? bearerToken : tenantId}
            />
            <button
              className={base.refreshButton}
              disabled={!authReady || loading}
              onClick={() => void loadItems()}
              type="button"
            >
              {loading ? "Loading…" : items.length ? "Refresh" : "Connect"}
            </button>
          </div>
        </header>

        {error ? (
          <div className={base.error} role="alert">
            {error}
          </div>
        ) : null}
        {notice ? (
          <div className={styles.notice} role="status">
            {notice}
          </div>
        ) : null}

        <section className={base.metrics} aria-label="Urgency metrics">
          <Metric label="Open reviews" value={metrics.total} />
          <Metric label="Emergency" value={metrics.emergency} tone="danger" />
          <Metric label="High priority" value={metrics.high} tone="warning" />
          <Metric label="Standard" value={metrics.standard} tone="success" />
        </section>

        <section className={base.board}>
          <div className={base.queue}>
            <div className={base.queueHeader}>
              <div>
                <h2>Priority queue</h2>
                <p>{visible.length} shown</p>
              </div>
              <input
                aria-label="Search urgency reviews"
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search service or job"
                type="search"
                value={search}
              />
            </div>
            <div
              className={base.filters}
              role="group"
              aria-label="Urgency filters"
            >
              {(
                ["all", "emergency", "high", "standard"] as UrgencyFilter[]
              ).map((value) => (
                <button
                  className={filter === value ? base.filterActive : ""}
                  key={value}
                  onClick={() => setFilter(value)}
                  type="button"
                >
                  {value}
                </button>
              ))}
            </div>
            <div className={base.queueList}>
              {!authReady ? (
                <EmptyState
                  title="Connect your operator account"
                  copy="Use a verified operator identity to load this tenant-scoped queue."
                />
              ) : visible.length === 0 && !loading ? (
                <EmptyState
                  title="No matching reviews"
                  copy="Urgency decisions will appear here as jobs are created."
                />
              ) : (
                visible.map((item) => (
                  <button
                    className={`${styles.reviewCard} ${selectedId === item.jobId ? styles.selectedCard : ""}`}
                    key={item.jobId}
                    onClick={() => void loadDetail(item.jobId)}
                    type="button"
                  >
                    <span className={styles.cardTop}>
                      <strong>{item.serviceCategory}</strong>
                      <time>{formatDate(item.createdAt)}</time>
                    </span>
                    <span>
                      Job #{item.reference} · {item.status}
                    </span>
                    <UrgencyBadge urgency={item.urgency} />
                  </button>
                ))
              )}
            </div>
          </div>

          <div className={base.detail} aria-live="polite">
            {detail ? (
              <UrgencyDetail
                acting={acting}
                detail={detail}
                onEscalate={() => void escalate()}
                onOverride={(urgency, reason) => void override(urgency, reason)}
              />
            ) : (
              <EmptyState
                title="Select a request"
                copy="Review rationale, escalation path and operator history without exposing customer contact details."
              />
            )}
          </div>
        </section>
      </section>
    </main>
  );
}

function UrgencyDetail({
  acting,
  detail,
  onEscalate,
  onOverride,
}: {
  acting: boolean;
  detail: UrgencyReviewDetail;
  onEscalate: () => void;
  onOverride: (urgency: UrgencyLevel, reason: string) => void;
}) {
  const [urgency, setUrgency] = useState<UrgencyLevel>(detail.urgency);
  const [reason, setReason] = useState("");

  useEffect(() => {
    setUrgency(detail.urgency);
    setReason("");
  }, [detail.jobId, detail.urgency]);

  return (
    <>
      <header className={base.detailHeader}>
        <div>
          <p className={base.eyebrow}>Job #{detail.reference}</p>
          <h2>{detail.serviceCategory}</h2>
          <p>
            Received {formatDate(detail.createdAt)} · {detail.status}
          </p>
        </div>
        <UrgencyBadge urgency={detail.urgency} />
      </header>

      <section className={styles.explanation}>
        <div className={styles.sectionHeading}>
          <div>
            <span>Decision source</span>
            <strong>{sourceLabel(detail.rationale.decisionSource)}</strong>
          </div>
          <p>{detail.rationale.confidenceNote}</p>
        </div>
        <h3>Why Signmons routed it here</h3>
        <ul>
          {detail.rationale.triggerDetails.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <p className={styles.safetyNote}>
          Operational routing only—not a diagnosis or emergency-services
          determination.
        </p>
      </section>

      <section className={styles.pathSection}>
        <h3>Escalation path preview</h3>
        <ol>
          {detail.escalationPath.map((step) => (
            <li key={step.order}>
              <span>{step.order}</span>
              <div>
                <strong>{step.label}</strong>
                <small>
                  {step.required
                    ? "Required by current urgency"
                    : "Routine path"}
                </small>
              </div>
            </li>
          ))}
        </ol>
        <button
          className={styles.escalateButton}
          disabled={acting}
          onClick={onEscalate}
          type="button"
        >
          {acting ? "Recording…" : "Notify operations and record outcome"}
        </button>
      </section>

      <section className={styles.overrideSection}>
        <h3>Authorized override</h3>
        <p>Choose a new level and explain the observable operational reason.</p>
        <div className={styles.overrideControls}>
          <select
            aria-label="New urgency"
            onChange={(event) => setUrgency(event.target.value as UrgencyLevel)}
            value={urgency}
          >
            <option value="EMERGENCY">Emergency</option>
            <option value="HIGH">High priority</option>
            <option value="STANDARD">Standard</option>
          </select>
          <textarea
            aria-label="Override reason"
            maxLength={500}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Required: what changed or what verified evidence supports this decision?"
            value={reason}
          />
          <button
            disabled={acting || reason.trim().length < 10}
            onClick={() => onOverride(urgency, reason)}
            type="button"
          >
            Save audited override
          </button>
        </div>
      </section>

      <section className={styles.historySection}>
        <div>
          <h3>Decision history</h3>
          <span>{detail.history.length} events</span>
        </div>
        {detail.history.length ? (
          <div className={styles.historyList}>
            {detail.history.map((event) => (
              <article key={event.id}>
                <strong>
                  {event.type === "override"
                    ? "Urgency overridden"
                    : "Operations escalation"}
                </strong>
                <time>{formatDate(event.createdAt)}</time>
                <p>{historyDescription(event)}</p>
                <small>Actor: {event.actorId}</small>
              </article>
            ))}
          </div>
        ) : (
          <p className={styles.noHistory}>
            No operator overrides or escalation attempts recorded.
          </p>
        )}
      </section>
    </>
  );
}

function Metric({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number;
  tone?: string;
}) {
  return (
    <article className={`${base.metric} ${base[tone]}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function UrgencyBadge({ urgency }: { urgency: UrgencyLevel }) {
  return (
    <span className={`${styles.urgencyBadge} ${styles[urgency.toLowerCase()]}`}>
      {urgencyLabel(urgency)}
    </span>
  );
}

function EmptyState({ title, copy }: { title: string; copy: string }) {
  return (
    <div className={base.emptyState}>
      <span aria-hidden="true">↗</span>
      <h3>{title}</h3>
      <p>{copy}</p>
    </div>
  );
}

function sourceLabel(
  source: UrgencyReviewDetail["rationale"]["decisionSource"],
) {
  if (source === "AI_INTAKE") return "AI intake + bounded rules";
  if (source === "OPERATOR_OVERRIDE") return "Authorized operator";
  return "Legacy persisted decision";
}

function historyDescription(event: UrgencyReviewDetail["history"][number]) {
  if (event.type === "override") {
    return `${event.details.previousUrgency || "Unknown"} → ${event.details.urgency || "Unknown"}. ${event.details.reason || "No reason retained."}`;
  }
  const deliveries = event.details.deliveries ?? [];
  return deliveries.length
    ? deliveries
        .map((delivery) => `${delivery.channel}: ${delivery.outcome}`)
        .join(" · ")
    : "Escalation recorded without a delivery result.";
}

function errorMessage(error: unknown) {
  return error instanceof ApiError
    ? `${error.status}: ${error.message}`
    : "CallDesk could not complete the urgency review request.";
}
