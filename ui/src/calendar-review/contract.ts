export type ReviewResource = "job" | "operation" | "requests";
export type OperationSnapshot = {
  snapshotOnly: true;
  operationId: string;
  jobId: string;
  action: "CREATE" | "RESCHEDULE" | "CANCEL";
  status:
    | "PENDING"
    | "APPLIED"
    | "UNCERTAIN"
    | "NEEDS_REVIEW"
    | "FINALIZED"
    | "ABORTED";
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  pendingHoldReviewCandidate: boolean;
  recoveryReviewCandidate: "applied_create" | "uncertain_create" | null;
  recoveryReadbackNotBefore: string | null;
};
export type RequestSnapshot = {
  requestId: string;
  kind: "applied_create" | "uncertain_create";
  requestedAt: string;
};
export type ReviewData = {
  snapshotOnly: true;
  items: OperationSnapshot[] | RequestSnapshot[];
  hasMore: boolean;
  requestOnly: boolean;
};

export function validReference(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid snapshot");
  return value as Record<string, unknown>;
}
function requireValue(condition: unknown): asserts condition {
  if (!condition) throw new Error("Invalid snapshot");
}
function id(value: unknown): string {
  requireValue(typeof value === "string" && validReference(value));
  return value.toLowerCase();
}
function timestamp(value: unknown): string {
  requireValue(
    typeof value === "string" &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value,
  );
  return value;
}
function nullableTime(value: unknown): string | null {
  return value === null ? null : timestamp(value);
}
function operation(value: unknown): OperationSnapshot {
  const row = record(value);
  requireValue(row.snapshotOnly === true);
  requireValue(
    typeof row.action === "string" &&
      ["CREATE", "RESCHEDULE", "CANCEL"].includes(row.action),
  );
  requireValue(
    typeof row.status === "string" &&
      [
        "PENDING",
        "APPLIED",
        "UNCERTAIN",
        "NEEDS_REVIEW",
        "FINALIZED",
        "ABORTED",
      ].includes(row.status),
  );
  requireValue(typeof row.pendingHoldReviewCandidate === "boolean");
  requireValue(
    row.recoveryReviewCandidate === null ||
      (typeof row.recoveryReviewCandidate === "string" &&
        ["applied_create", "uncertain_create"].includes(
          row.recoveryReviewCandidate,
        )),
  );
  const finishedAt = nullableTime(row.finishedAt);
  const boundary = nullableTime(row.recoveryReadbackNotBefore);
  const unfinishedCreate = row.action === "CREATE" && finishedAt === null;
  requireValue(
    row.pendingHoldReviewCandidate ===
      (unfinishedCreate && row.status === "PENDING"),
  );
  requireValue(
    row.recoveryReviewCandidate !== "applied_create" ||
      (unfinishedCreate && row.status === "APPLIED"),
  );
  requireValue(
    row.recoveryReviewCandidate !== "uncertain_create" ||
      (unfinishedCreate && row.status === "UNCERTAIN" && boundary !== null),
  );
  requireValue(
    boundary === null || (unfinishedCreate && row.status === "UNCERTAIN"),
  );
  // Map only the declared fields; never retain private/unknown response payloads.
  return {
    snapshotOnly: true,
    operationId: id(row.operationId),
    jobId: id(row.jobId),
    action: row.action as OperationSnapshot["action"],
    status: row.status as OperationSnapshot["status"],
    createdAt: timestamp(row.createdAt),
    updatedAt: timestamp(row.updatedAt),
    finishedAt,
    pendingHoldReviewCandidate: row.pendingHoldReviewCandidate,
    recoveryReviewCandidate:
      row.recoveryReviewCandidate as OperationSnapshot["recoveryReviewCandidate"],
    recoveryReadbackNotBefore: boundary,
  };
}
function requestItem(value: unknown): RequestSnapshot {
  const row = record(value);
  requireValue(
    row.kind === "applied_create" || row.kind === "uncertain_create",
  );
  return {
    requestId: id(row.requestId),
    kind: row.kind,
    requestedAt: timestamp(row.requestedAt),
  };
}
export function parseReview(
  resource: ReviewResource,
  value: unknown,
  reference: string,
): ReviewData {
  requireValue(validReference(reference));
  if (resource === "operation") {
    const item = operation(value);
    requireValue(item.operationId === reference.toLowerCase());
    return {
      snapshotOnly: true,
      items: [item],
      hasMore: false,
      requestOnly: false,
    };
  }
  const envelope = record(value);
  requireValue(
    envelope.snapshotOnly === true && typeof envelope.hasMore === "boolean",
  );
  requireValue(Array.isArray(envelope.items) && envelope.items.length <= 100);
  requireValue(!envelope.hasMore || envelope.items.length === 100);
  if (resource === "requests") requireValue(envelope.requestOnly === true);
  const items =
    resource === "requests"
      ? envelope.items.map(requestItem)
      : envelope.items.map(operation);
  if (resource === "job")
    requireValue(
      (items as OperationSnapshot[]).every(
        (item) => item.jobId === reference.toLowerCase(),
      ),
    );
  const ids = items.map((item) =>
    "requestId" in item ? item.requestId : item.operationId,
  );
  requireValue(new Set(ids).size === ids.length);
  return {
    snapshotOnly: true,
    items,
    hasMore: envelope.hasMore,
    requestOnly: resource === "requests",
  };
}

export function reviewError(status?: number) {
  if (status === 401 || status === 403)
    return "Review access denied. Start a new authorized session to continue.";
  if (status === 400) return "Check the reference, then load a new snapshot.";
  if (status === 404)
    return "This operation is unavailable in this session. Check the reference.";
  if (status === 429)
    return "Read limit reached. Wait a minute, then refresh manually.";
  return "Snapshot unavailable. Refresh manually; no recovery action was requested.";
}

export function operationLabel(status: OperationSnapshot["status"]) {
  return {
    PENDING: "Pending journal operation",
    APPLIED: "Write attempt ended · outcome unverified",
    UNCERTAIN: "Calendar outcome uncertain",
    NEEDS_REVIEW: "Office review needed",
    FINALIZED: "Journal finalized · not a current booking receipt",
    ABORTED: "Journal aborted · not proof of provider absence",
  }[status];
}
