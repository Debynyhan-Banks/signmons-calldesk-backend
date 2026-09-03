"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ApiError,
  DispatchBoardDetail,
  DispatchBoardSummary,
  DispatchQueue,
  RequestAuth,
  assignDispatchJob,
  cancelDispatchAssignment,
  createTechnicianLink,
  escalateJobUrgency,
  getDispatchJob,
  evaluateJobRouting,
  listDispatchBoard,
} from "@/lib/api";
import {
  DispatchFilter,
  dispatchMetrics,
  dispatchQueueLabel,
  filterDispatchBoard,
  formatDispatchDate,
  formatDispatchWindow,
} from "@/lib/dispatch-board";
import base from "../intake-review/intake-review.module.css";
import styles from "./dispatch.module.css";

type AuthMode = "firebase" | "dev";

export default function DispatchPage() {
  const hasDevAuth = Boolean(process.env.NEXT_PUBLIC_DEV_AUTH_SECRET);
  const [authMode, setAuthMode] = useState<AuthMode>(
    hasDevAuth ? "dev" : "firebase",
  );
  const [tenantId, setTenantId] = useState(
    process.env.NEXT_PUBLIC_TENANT_ID ?? "",
  );
  const [bearerToken, setBearerToken] = useState("");
  const [items, setItems] = useState<DispatchBoardSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DispatchBoardDetail | null>(null);
  const [filter, setFilter] = useState<DispatchFilter>("all");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [technicianLink, setTechnicianLink] = useState<string | null>(null);

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
      setTechnicianLink(null);
      setError(null);
      try {
        setDetail(await getDispatchJob(jobId, auth, tenantId));
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
      const next = await listDispatchBoard(auth, tenantId);
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
    () => filterDispatchBoard(items, filter, search),
    [filter, items, search],
  );
  const metrics = useMemo(() => dispatchMetrics(items), [items]);

  const refreshSelected = async () => {
    if (!selectedId) return;
    const [nextDetail, nextItems] = await Promise.all([
      getDispatchJob(selectedId, auth, tenantId),
      listDispatchBoard(auth, tenantId),
    ]);
    setDetail(nextDetail);
    setItems(nextItems);
  };

  const assign = async (technicianId: string, reason?: string) => {
    if (!detail) return;
    setActing(true);
    setError(null);
    setNotice(null);
    try {
      const result = await assignDispatchJob(
        detail.jobId,
        {
          technicianId,
          expectedUpdatedAt: detail.updatedAt,
          reason: reason || undefined,
        },
        auth,
        tenantId,
      );
      setNotice(
        result.changed
          ? `Assigned to ${result.assignedTechnician?.fullName ?? "the selected technician"}.`
          : "That technician was already assigned; no duplicate audit was created.",
      );
      await refreshSelected();
    } catch (actionError) {
      setError(errorMessage(actionError));
    } finally {
      setActing(false);
    }
  };

  const cancelAssignment = async (reason: string) => {
    if (!detail) return;
    setActing(true);
    setError(null);
    setNotice(null);
    try {
      const result = await cancelDispatchAssignment(
        detail.jobId,
        { expectedUpdatedAt: detail.updatedAt, reason },
        auth,
        tenantId,
      );
      setNotice(
        result.changed
          ? "Assignment cancelled; the customer job remains active."
          : "This job was already unassigned.",
      );
      await refreshSelected();
    } catch (actionError) {
      setError(errorMessage(actionError));
    } finally {
      setActing(false);
    }
  };

  const escalate = async () => {
    if (!detail) return;
    setActing(true);
    setError(null);
    setNotice(null);
    try {
      const result = await escalateJobUrgency(detail.jobId, auth, tenantId);
      setNotice(
        result.changed
          ? "Escalation recorded and routed to operations."
          : "A recent escalation already exists; no duplicate notification was sent.",
      );
      await refreshSelected();
    } catch (actionError) {
      setError(errorMessage(actionError));
    } finally {
      setActing(false);
    }
  };

  const issueTechnicianLink = async () => {
    if (!detail?.assignedTechnician) return;
    setActing(true);
    setError(null);
    setNotice(null);
    try {
      const result = await createTechnicianLink(
        detail.assignedTechnician.id,
        undefined,
        auth,
        tenantId,
      );
      setTechnicianLink(result.url);
      setNotice(
        `Secure field link created for ${result.technician.fullName}. It expires ${formatDispatchDate(result.expiresAt, detail.timezone)}.`,
      );
    } catch (actionError) {
      setError(errorMessage(actionError));
    } finally {
      setActing(false);
    }
  };

  const evaluateRouting = async () => {
    if (!detail) return;
    setActing(true);
    setError(null);
    setNotice(null);
    try {
      const result = await evaluateJobRouting(detail.jobId, auth, tenantId);
      setNotice(
        result.matchedRule
          ? `Routing evaluated: ${result.matchedRule.name}. The reason trace was audit logged.`
          : "Routing evaluated with the safe default. The reason trace was audit logged.",
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
          <a className={base.disabledNav} href="/app/urgency-review">
            <span aria-hidden="true">02</span> Urgency review
          </a>
          <a className={base.activeNav} href="/app/dispatch">
            <span aria-hidden="true">03</span> Dispatch board
          </a>
          <a className={base.disabledNav} href="/app/routing">
            <span aria-hidden="true">04</span> Routing rules
          </a>
        </nav>
        <div className={base.navFooter}>
          <span className={base.liveDot} /> Human-controlled dispatch
        </div>
      </aside>

      <section className={base.workspace}>
        <header className={base.topbar}>
          <div>
            <p className={base.eyebrow}>Operations / Dispatch</p>
            <h1>Assignment board</h1>
            <p>
              Match qualified technicians, explain overrides and keep control.
            </p>
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

        <section className={styles.metrics} aria-label="Dispatch metrics">
          <Metric label="Open jobs" value={metrics.total} />
          <Metric label="New" value={metrics.newRequests} />
          <Metric label="Ready" value={metrics.ready} tone="warning" />
          <Metric label="Assigned" value={metrics.assigned} tone="success" />
          <Metric label="Escalated" value={metrics.escalated} tone="danger" />
        </section>

        <section className={base.board}>
          <div className={base.queue}>
            <div className={base.queueHeader}>
              <div>
                <h2>Dispatch queue</h2>
                <p>{visible.length} shown</p>
              </div>
              <input
                aria-label="Search dispatch jobs"
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search job or tech"
                type="search"
                value={search}
              />
            </div>
            <div
              className={base.filters}
              role="group"
              aria-label="Dispatch filters"
            >
              {(
                [
                  "all",
                  "NEW_REQUEST",
                  "READY_TO_ASSIGN",
                  "ASSIGNED",
                  "ESCALATED",
                ] as DispatchFilter[]
              ).map((value) => (
                <button
                  className={filter === value ? base.filterActive : ""}
                  key={value}
                  onClick={() => setFilter(value)}
                  type="button"
                >
                  {value === "all" ? "All" : dispatchQueueLabel(value)}
                </button>
              ))}
            </div>
            <div className={base.queueList}>
              {!authReady ? (
                <EmptyState
                  title="Connect your operator account"
                  copy="Use a verified operator identity to load this tenant-scoped board."
                />
              ) : visible.length === 0 && !loading ? (
                <EmptyState
                  title="No matching jobs"
                  copy="Active jobs will appear here as intake and scheduling complete."
                />
              ) : (
                visible.map((item) => (
                  <DispatchCard
                    item={item}
                    key={item.jobId}
                    onSelect={() => void loadDetail(item.jobId)}
                    selected={selectedId === item.jobId}
                  />
                ))
              )}
            </div>
          </div>

          <div className={base.detail} aria-live="polite">
            {detail ? (
              <DispatchDetail
                acting={acting}
                detail={detail}
                onAssign={(technicianId, reason) =>
                  void assign(technicianId, reason)
                }
                onCancel={(reason) => void cancelAssignment(reason)}
                onEscalate={() => void escalate()}
                onIssueLink={() => void issueTechnicianLink()}
                onEvaluateRouting={() => void evaluateRouting()}
                technicianLink={technicianLink}
              />
            ) : (
              <EmptyState
                title="Select a job"
                copy="Review the recommendation and assign a technician without exposing customer contact details."
              />
            )}
          </div>
        </section>
      </section>
    </main>
  );
}

function DispatchCard({
  item,
  onSelect,
  selected,
}: {
  item: DispatchBoardSummary;
  onSelect: () => void;
  selected: boolean;
}) {
  return (
    <button
      className={`${styles.jobCard} ${selected ? styles.selectedCard : ""}`}
      onClick={onSelect}
      type="button"
    >
      <span className={styles.cardTop}>
        <strong>{item.serviceCategory}</strong>
        <time>{formatDispatchDate(item.createdAt, item.timezone)}</time>
      </span>
      <span>
        Job #{item.reference} ·{" "}
        {formatDispatchWindow(
          item.serviceWindowStart,
          item.serviceWindowEnd,
          item.timezone,
        )}
      </span>
      <span className={styles.cardFooter}>
        <QueueBadge queue={item.queue} />
        <small>{item.assignedTechnician?.fullName ?? "Unassigned"}</small>
      </span>
    </button>
  );
}

function DispatchDetail({
  acting,
  detail,
  onAssign,
  onCancel,
  onEscalate,
  onIssueLink,
  onEvaluateRouting,
  technicianLink,
}: {
  acting: boolean;
  detail: DispatchBoardDetail;
  onAssign: (technicianId: string, reason?: string) => void;
  onCancel: (reason: string) => void;
  onEscalate: () => void;
  onIssueLink: () => void;
  onEvaluateRouting: () => void;
  technicianLink: string | null;
}) {
  const recommendedId = detail.recommendation?.technicianId ?? "";
  const [technicianId, setTechnicianId] = useState(
    detail.assignedTechnician?.id ?? recommendedId,
  );
  const [reason, setReason] = useState("");
  const selected = detail.candidates.find(
    (candidate) => candidate.userId === technicianId,
  );
  const isReassignment = Boolean(
    detail.assignedTechnician && detail.assignedTechnician.id !== technicianId,
  );
  const isOverride = Boolean(
    technicianId && (!selected?.eligible || recommendedId !== technicianId),
  );
  const reasonRequired = isReassignment || isOverride;

  useEffect(() => {
    setTechnicianId(
      detail.assignedTechnician?.id ??
        detail.recommendation?.technicianId ??
        "",
    );
    setReason("");
  }, [
    detail.jobId,
    detail.assignedTechnician?.id,
    detail.recommendation?.technicianId,
  ]);

  return (
    <>
      <header className={base.detailHeader}>
        <div>
          <p className={base.eyebrow}>Job #{detail.reference}</p>
          <h2>{detail.serviceCategory}</h2>
          <p>
            {formatDispatchWindow(
              detail.serviceWindowStart,
              detail.serviceWindowEnd,
              detail.timezone,
            )}{" "}
            · {detail.urgency.toLowerCase()}
          </p>
        </div>
        <QueueBadge queue={detail.queue} />
      </header>

      <section className={styles.currentAssignment}>
        <span>Current assignment</span>
        <strong>{detail.assignedTechnician?.fullName ?? "Unassigned"}</strong>
        <small>
          {detail.technicianStatus
            ? detail.technicianStatus.toLowerCase().replace(/_/g, " ")
            : "Awaiting assignment"}
          {" · "}Last changed{" "}
          {formatDispatchDate(detail.updatedAt, detail.timezone)}
        </small>
        {detail.assignedTechnician ? (
          <div className={styles.fieldLinkActions}>
            <button disabled={acting} onClick={onIssueLink} type="button">
              Create secure field link
            </button>
            {technicianLink ? (
              <>
                <a href={technicianLink} rel="noreferrer" target="_blank">
                  Open technician workspace
                </a>
                <button
                  onClick={() =>
                    void navigator.clipboard.writeText(technicianLink)
                  }
                  type="button"
                >
                  Copy link
                </button>
              </>
            ) : null}
          </div>
        ) : null}
      </section>

      <section
        className={`${styles.paymentGate} ${
          detail.paymentGate.state === "LOCKED"
            ? styles.paymentGateLocked
            : styles.paymentGateOpen
        }`}
      >
        <div>
          <p className={base.eyebrow}>Payment gate</p>
          <h3>{detail.paymentGate.label}</h3>
        </div>
        <span>{detail.paymentGate.paymentStatus.replace(/_/g, " ")}</span>
        <small>
          {detail.paymentGate.state === "LOCKED"
            ? "Assignment is disabled until a verified payment update unlocks this job."
            : "This job currently satisfies its payment-before-dispatch policy."}
        </small>
      </section>

      <section
        className={`${styles.customerBooking} ${
          detail.customerBooking.state === "RESCHEDULE_REQUESTED"
            ? styles.customerBookingAttention
            : ""
        }`}
      >
        <div className={styles.sectionHeading}>
          <div>
            <p className={base.eyebrow}>Customer booking response</p>
            <h3>{detail.customerBooking.label}</h3>
          </div>
          <span>{customerBookingStateLabel(detail.customerBooking.state)}</span>
        </div>
        {detail.customerBooking.events.length ? (
          <ol>
            {detail.customerBooking.events.slice(0, 4).map((event) => (
              <li key={event.id}>
                <div>
                  <strong>{event.label}</strong>
                  {event.note ? <p>“{event.note}”</p> : null}
                </div>
                <time>
                  {formatDispatchDate(event.createdAt, detail.timezone)}
                </time>
              </li>
            ))}
          </ol>
        ) : (
          <p>
            The secure customer link is active. Confirmation or a reschedule
            request will appear here without exposing the link token.
          </p>
        )}
      </section>

      <section className={styles.recommendation}>
        <div className={styles.sectionHeading}>
          <div>
            <p className={base.eyebrow}>Dispatch recommendation</p>
            <h3>
              {detail.recommendation?.technicianName ?? "No eligible match"}
            </h3>
          </div>
          <span>dispatch-v2 + routing-v1</span>
        </div>
        {detail.recommendation ? (
          <ul>
            {detail.recommendation.reasons.map((reasonLabel) => (
              <li key={reasonLabel}>{reasonLabel}</li>
            ))}
          </ul>
        ) : detail.paymentGate.state === "LOCKED" ? (
          <p>
            Dispatch recommendations are paused while the required payment gate
            is locked.
          </p>
        ) : (
          <p>
            No technician currently meets both service capability and
            availability rules. An authorized override requires a reason.
          </p>
        )}
        <small>
          Decision support only. An authorized operator makes the assignment.
        </small>
        <div className={styles.routingTrace}>
          <strong>
            {detail.routing.covered
              ? "Service area allowed"
              : "Service area blocked"}
          </strong>
          <span>
            {detail.routing.matchedRule?.name ?? "Safe default policy"}
          </span>
          <ul>
            {detail.routing.reasons.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          {detail.routing.escalationPath.length ? (
            <p>
              Escalation:{" "}
              {detail.routing.escalationPath
                .map(
                  (item) => `${item.fullName} (${item.reason.toLowerCase()})`,
                )
                .join(", ")}
            </p>
          ) : null}
          <button disabled={acting} onClick={onEvaluateRouting} type="button">
            Re-evaluate and audit trace
          </button>
        </div>
      </section>

      <section className={styles.assignmentPanel}>
        <h3>
          {detail.assignedTechnician
            ? "Reassign technician"
            : "Assign technician"}
        </h3>
        <label>
          Technician
          <select
            disabled={detail.paymentGate.state === "LOCKED"}
            value={technicianId}
            onChange={(event) => setTechnicianId(event.target.value)}
          >
            <option value="">Select a technician</option>
            {detail.candidates.map((candidate) => (
              <option key={candidate.userId} value={candidate.userId}>
                {candidate.fullName} ·{" "}
                {candidate.proficiency?.toLowerCase() ?? "no capability"} ·{" "}
                {candidate.activeAssignments} active
                {candidate.eligible ? "" : " · override"}
              </option>
            ))}
          </select>
        </label>
        {selected ? (
          <div className={styles.candidateFactors}>
            {selected.reasons.map((candidateReason) => (
              <span
                className={
                  selected.eligible ? styles.factorGood : styles.factorWarn
                }
                key={candidateReason}
              >
                {candidateReason}
              </span>
            ))}
          </div>
        ) : null}
        <label>
          Operator reason{" "}
          {reasonRequired ? <strong>Required</strong> : <small>Optional</small>}
          <textarea
            maxLength={500}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Explain a reassignment or why a different technician is the better operational choice."
            value={reason}
          />
        </label>
        <button
          className={styles.assignButton}
          disabled={
            detail.paymentGate.state === "LOCKED" ||
            !technicianId ||
            acting ||
            (reasonRequired && reason.trim().length < 10)
          }
          onClick={() => onAssign(technicianId, reason.trim() || undefined)}
          type="button"
        >
          {detail.paymentGate.state === "LOCKED"
            ? "Payment required before assignment"
            : acting
              ? "Saving…"
              : detail.assignedTechnician
                ? "Save reassignment"
                : "Confirm assignment"}
        </button>
      </section>

      <section className={styles.secondaryActions}>
        <button disabled={acting} onClick={onEscalate} type="button">
          Escalate to operations
        </button>
        {detail.assignedTechnician ? (
          <button
            disabled={acting || reason.trim().length < 10}
            onClick={() => onCancel(reason.trim())}
            type="button"
          >
            Cancel assignment
          </button>
        ) : null}
        {detail.assignedTechnician ? (
          <small>
            Enter a 10-character reason above before cancelling. The customer
            job stays active.
          </small>
        ) : null}
      </section>

      <section className={styles.historySection}>
        <div>
          <h3>Assignment history</h3>
          <span>{detail.assignmentHistory.length} events</span>
        </div>
        {detail.assignmentHistory.length ? (
          <div className={styles.historyList}>
            {detail.assignmentHistory.map((event) => (
              <article key={event.id}>
                <strong>{historyLabel(event.action)}</strong>
                <time>
                  {formatDispatchDate(event.createdAt, detail.timezone)}
                </time>
                <p>
                  {event.reason ??
                    event.note ??
                    (event.override
                      ? "Authorized recommendation override."
                      : "Recommended assignment accepted.")}
                </p>
                <small>Actor: {event.actorId}</small>
              </article>
            ))}
          </div>
        ) : (
          <p className={styles.noHistory}>No assignment changes recorded.</p>
        )}
      </section>
    </>
  );
}

function QueueBadge({ queue }: { queue: DispatchQueue }) {
  return (
    <span className={`${styles.queueBadge} ${styles[queue.toLowerCase()]}`}>
      {dispatchQueueLabel(queue)}
    </span>
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

function EmptyState({ title, copy }: { title: string; copy: string }) {
  return (
    <div className={base.emptyState}>
      <span aria-hidden="true">↗</span>
      <h3>{title}</h3>
      <p>{copy}</p>
    </div>
  );
}

function historyLabel(
  action: DispatchBoardDetail["assignmentHistory"][number]["action"],
) {
  if (action === "job.assigned") return "Technician assigned";
  if (action === "job.reassigned") return "Technician reassigned";
  if (action === "job.assignment_cancelled") return "Assignment cancelled";
  if (action === "job.technician_accepted") return "Technician accepted";
  if (action === "job.technician_declined") return "Technician declined";
  if (action === "job.technician_en_route") return "Technician is on the way";
  if (action === "job.technician_started") return "Work started";
  if (action === "job.technician_completed") return "Work completed";
  return "Technician cannot take job";
}

function customerBookingStateLabel(
  state: DispatchBoardDetail["customerBooking"]["state"],
) {
  if (state === "CONFIRMED") return "Confirmed";
  if (state === "RESCHEDULE_REQUESTED") return "Action needed";
  return "Awaiting response";
}

function errorMessage(error: unknown) {
  return error instanceof ApiError
    ? `${error.status}: ${error.message}`
    : "CallDesk could not complete the dispatch request.";
}
