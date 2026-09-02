const DEFAULT_API_URL = "http://localhost:3000";

const apiBase =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ?? DEFAULT_API_URL;

type JsonRecord = Record<string, unknown>;

export interface TenantRequest {
  name: string;
  displayName: string;
  instructions: string;
}

export interface TenantResponse {
  tenantId: string;
  displayName: string;
  instructions: string;
  prompt: string;
}

export interface TriageRequest {
  sessionId: string;
  message: string;
}

export type TriageResponse =
  | {
      status: "reply";
      reply: string;
    }
  | {
      status: "job_created";
      message: string;
      job: {
        id: string;
        tenantId: string;
        customerName: string;
        phone?: string;
        address?: string;
        issueCategory?: string;
        urgency?: string;
        description?: string;
        preferredTime?: string;
        status?: string;
        createdAt?: string;
      };
    }
  | JsonRecord;

export interface DevAuthConfig {
  secret?: string;
  role?: string;
  userId?: string;
  tenantId?: string;
}

export interface RequestAuth {
  adminToken?: string;
  bearerToken?: string;
  devAuth?: DevAuthConfig;
}

export interface IntakeReadiness {
  state: "READY_TO_ASSIGN" | "MISSING_INFO";
  missingFields: string[];
  assessedAt: string;
}

export interface IntakeReviewSummary {
  jobId: string;
  reference: string;
  customerName: string | null;
  phone: string | null;
  serviceAddress: string | null;
  serviceCategory: string | null;
  issueSummary: string | null;
  urgency: string | null;
  priority: "EMERGENCY" | "HIGH" | "STANDARD";
  preferredWindow: string | null;
  photos: string[];
  paymentStatus: string;
  depositRequired: boolean;
  status: string;
  sourceChannel: string | null;
  createdAt: string;
  readiness: IntakeReadiness;
}

export interface IntakeReviewDetail extends IntakeReviewSummary {
  transcript: Array<{
    id: string;
    role: "caller" | "assistant" | "system";
    content: string;
    occurredAt: string;
  }>;
  reviewHistory: Array<{
    id: string;
    state: IntakeReadiness["state"];
    missingFields: string[];
    actorId: string;
    createdAt: string;
  }>;
}

export type UrgencyLevel = "EMERGENCY" | "HIGH" | "STANDARD";

export interface NotificationDeliveryOutcome {
  channel: "email" | "sms" | "internal";
  recipientGroup: "operations";
  outcome: "delivered" | "failed" | "misconfigured" | "not_configured";
}

export interface UrgencyReviewSummary {
  jobId: string;
  reference: string;
  urgency: UrgencyLevel;
  serviceCategory: string;
  status: string;
  createdAt: string;
  rationale: {
    decisionSource: "AI_INTAKE" | "OPERATOR_OVERRIDE" | "LEGACY_PERSISTED";
    reasonCodes: string[];
    triggerDetails: string[];
    confidenceNote: string;
  };
  escalationPath: Array<{
    order: number;
    label: string;
    required: boolean;
  }>;
}

export interface UrgencyReviewDetail extends UrgencyReviewSummary {
  history: Array<{
    id: string;
    type: "override" | "escalation";
    actorId: string;
    createdAt: string;
    details: {
      previousUrgency?: string;
      urgency?: string;
      reason?: string;
      recipientGroup?: string;
      deliveries?: NotificationDeliveryOutcome[];
    };
  }>;
}

export type DispatchQueue =
  | "NEW_REQUEST"
  | "READY_TO_ASSIGN"
  | "ASSIGNED"
  | "ESCALATED";

export interface AssignedTechnician {
  id: string;
  fullName: string;
  role: string;
}

export interface DispatchBoardSummary {
  jobId: string;
  reference: string;
  queue: DispatchQueue;
  serviceCategory: string;
  urgency: UrgencyLevel;
  status: string;
  technicianStatus:
    | "ASSIGNED"
    | "ACCEPTED"
    | "EN_ROUTE"
    | "IN_PROGRESS"
    | "COMPLETED"
    | null;
  serviceWindowStart: string | null;
  serviceWindowEnd: string | null;
  timezone: string;
  assignedTechnician: AssignedTechnician | null;
  createdAt: string;
  updatedAt: string;
}

export interface DispatchCandidate {
  userId: string;
  fullName: string;
  role: string;
  available: boolean;
  onCall: boolean;
  proficiency: "JUNIOR" | "STANDARD" | "EXPERT" | null;
  activeAssignments: number;
  eligible: boolean;
  reasonCodes: string[];
  reasons: string[];
}

export interface DispatchBoardDetail extends DispatchBoardSummary {
  recommendation: {
    version: "dispatch-v2";
    technicianId: string;
    technicianName: string;
    reasonCodes: string[];
    reasons: string[];
  } | null;
  routing: RoutingEvaluation;
  candidates: DispatchCandidate[];
  assignmentHistory: Array<{
    id: string;
    action:
      | "job.assigned"
      | "job.reassigned"
      | "job.assignment_cancelled"
      | "job.technician_accepted"
      | "job.technician_declined"
      | "job.technician_en_route"
      | "job.technician_started"
      | "job.technician_completed"
      | "job.technician_unavailable";
    actorId: string;
    technicianId: string | null;
    previousTechnicianId: string | null;
    override: boolean;
    reason: string | null;
    note: string | null;
    createdAt: string;
  }>;
}

export type RoutingTimeScope = "ANY" | "BUSINESS_HOURS" | "AFTER_HOURS";

export interface RoutingEvaluation {
  version: "routing-v1";
  jobId: string;
  timeScope: "BUSINESS_HOURS" | "AFTER_HOURS";
  postalCode: string | null;
  covered: boolean;
  matchedRule: { id: string; name: string; priority: number } | null;
  requirements: { requireAvailable: boolean; requireOnCall: boolean };
  reasonCodes: string[];
  reasons: string[];
  escalationPath: Array<{
    userId: string;
    fullName: string;
    role: string;
    reason: "OWNER" | "ON_CALL";
  }>;
}

export interface RoutingSnapshot {
  rules: Array<{
    id: string;
    name: string;
    status: "ACTIVE" | "INACTIVE";
    priority: number;
    serviceCategoryId: string | null;
    serviceAreaId: string | null;
    urgency: UrgencyLevel | null;
    timeScope: RoutingTimeScope;
    requireAvailable: boolean;
    requireOnCall: boolean;
    escalateToOwner: boolean;
    escalateToOnCall: boolean;
    serviceCategory: { id: string; name: string } | null;
    serviceArea: { id: string; name: string } | null;
  }>;
  serviceAreas: Array<{
    id: string;
    name: string;
    type: "ZIP";
    status: "ACTIVE" | "INACTIVE";
    definition: { postalCodes?: string[] };
  }>;
  technicians: Array<{
    id: string;
    fullName: string;
    isAvailable: boolean;
    isOnCall: boolean;
    serviceCapabilities: Array<{
      serviceCategoryId: string;
      proficiency: "JUNIOR" | "STANDARD" | "EXPERT";
      isEnabled: boolean;
    }>;
    availabilityBlocks: Array<{
      id: string;
      type: "UNAVAILABLE" | "AVAILABLE_OVERRIDE";
      startAt: string;
      endAt: string;
      reason: string | null;
    }>;
  }>;
  serviceCategories: Array<{ id: string; name: string }>;
}

export type TechnicianJobAction =
  | "accept"
  | "decline"
  | "on_my_way"
  | "in_progress"
  | "complete"
  | "cannot_take";

export interface TechnicianJobSummary {
  jobId: string;
  reference: string;
  serviceCategory: string;
  serviceAddress: string;
  serviceWindowStart: string | null;
  serviceWindowEnd: string | null;
  urgency: UrgencyLevel;
  technicianStatus:
    | "ASSIGNED"
    | "ACCEPTED"
    | "EN_ROUTE"
    | "IN_PROGRESS"
    | "COMPLETED";
  availableActions: TechnicianJobAction[];
  updatedAt: string;
}

export interface TechnicianJobDetail extends TechnicianJobSummary {
  customer: {
    fullName: string;
    phone: string;
    email: string | null;
  };
  accessNotes: string | null;
  issueSummary: string | null;
  preferredTimeText: string | null;
  jobStatus: string;
}

export interface TechnicianJobList {
  technician: { id: string; fullName: string };
  timezone: string;
  linkExpiresAt: string;
  groups: {
    today: TechnicianJobSummary[];
    upcoming: TechnicianJobSummary[];
    completed: TechnicianJobSummary[];
  };
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

function buildAuthHeaders(
  auth?: RequestAuth,
  fallbackTenantId?: string,
): Record<string, string> {
  const headers: Record<string, string> = {};
  const bearerToken = auth?.bearerToken?.trim();
  if (bearerToken) {
    headers.Authorization = `Bearer ${bearerToken}`;
  }
  const adminToken = auth?.adminToken?.trim();
  if (adminToken) {
    headers["x-admin-token"] = adminToken;
  }

  const secret = auth?.devAuth?.secret?.trim();
  if (secret) {
    headers["x-dev-auth"] = secret;
    const role = auth?.devAuth?.role?.trim();
    if (role) {
      headers["x-dev-role"] = role;
    }
    const userId = auth?.devAuth?.userId?.trim();
    if (userId) {
      headers["x-dev-user-id"] = userId;
    }
    const tenantId =
      auth?.devAuth?.tenantId?.trim() ?? fallbackTenantId?.trim();
    if (tenantId) {
      headers["x-dev-tenant-id"] = tenantId;
    }
  }

  return headers;
}

async function postJson<T>(
  path: string,
  body: object,
  headers: Record<string, string> = {},
): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    cache: "no-store",
    body: JSON.stringify(body),
  });

  const isJson = response.headers
    .get("content-type")
    ?.includes("application/json");

  const payload = isJson ? await response.json() : await response.text();

  if (!response.ok) {
    const message =
      typeof payload === "string"
        ? payload
        : ((payload?.message as string) ?? "Request failed");
    throw new ApiError(message, response.status);
  }

  return payload as T;
}

async function getJson<T>(
  path: string,
  headers: Record<string, string> = {},
): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    method: "GET",
    headers,
    cache: "no-store",
  });
  const isJson = response.headers
    .get("content-type")
    ?.includes("application/json");
  const payload = isJson ? await response.json() : await response.text();
  if (!response.ok) {
    const message =
      typeof payload === "string"
        ? payload
        : ((payload?.message as string) ?? "Request failed");
    throw new ApiError(message, response.status);
  }
  return payload as T;
}

export async function createTenant(
  input: TenantRequest,
  auth?: RequestAuth,
): Promise<TenantResponse> {
  return postJson<TenantResponse>("/tenants", input, buildAuthHeaders(auth));
}

export async function sendTriage(
  input: TriageRequest,
  auth?: RequestAuth,
  tenantId?: string,
): Promise<TriageResponse> {
  return postJson<TriageResponse>(
    "/ai/triage",
    input,
    buildAuthHeaders(auth, tenantId),
  );
}

export async function listIntakeReviews(
  auth: RequestAuth,
  tenantId?: string,
): Promise<IntakeReviewSummary[]> {
  return getJson<IntakeReviewSummary[]>(
    "/jobs/intake-review",
    buildAuthHeaders(auth, tenantId),
  );
}

export async function getIntakeReview(
  jobId: string,
  auth: RequestAuth,
  tenantId?: string,
): Promise<IntakeReviewDetail> {
  return getJson<IntakeReviewDetail>(
    `/jobs/intake-review/${encodeURIComponent(jobId)}`,
    buildAuthHeaders(auth, tenantId),
  );
}

export async function reviewIntakeReadiness(
  jobId: string,
  auth: RequestAuth,
  tenantId?: string,
): Promise<{
  jobId: string;
  readiness: IntakeReadiness;
  review: { id: string; createdAt: string };
}> {
  return postJson(
    `/jobs/${encodeURIComponent(jobId)}/readiness/review`,
    {},
    buildAuthHeaders(auth, tenantId),
  );
}

export async function listUrgencyReviews(
  auth: RequestAuth,
  tenantId?: string,
): Promise<UrgencyReviewSummary[]> {
  return getJson<UrgencyReviewSummary[]>(
    "/jobs/urgency-review",
    buildAuthHeaders(auth, tenantId),
  );
}

export async function getUrgencyReview(
  jobId: string,
  auth: RequestAuth,
  tenantId?: string,
): Promise<UrgencyReviewDetail> {
  return getJson<UrgencyReviewDetail>(
    `/jobs/urgency-review/${encodeURIComponent(jobId)}`,
    buildAuthHeaders(auth, tenantId),
  );
}

export async function overrideJobUrgency(
  jobId: string,
  input: { urgency: UrgencyLevel; reason: string },
  auth: RequestAuth,
  tenantId?: string,
): Promise<{ changed: boolean; urgency: UrgencyLevel }> {
  return postJson(
    `/jobs/${encodeURIComponent(jobId)}/urgency/override`,
    input,
    buildAuthHeaders(auth, tenantId),
  );
}

export async function escalateJobUrgency(
  jobId: string,
  auth: RequestAuth,
  tenantId?: string,
): Promise<{
  jobId: string;
  urgency: UrgencyLevel;
  changed: boolean;
  escalation: { deliveries: NotificationDeliveryOutcome[] };
}> {
  return postJson(
    `/jobs/${encodeURIComponent(jobId)}/escalations`,
    {},
    buildAuthHeaders(auth, tenantId),
  );
}

export async function listDispatchBoard(
  auth: RequestAuth,
  tenantId?: string,
): Promise<DispatchBoardSummary[]> {
  return getJson<DispatchBoardSummary[]>(
    "/jobs/dispatch-board",
    buildAuthHeaders(auth, tenantId),
  );
}

export async function getDispatchJob(
  jobId: string,
  auth: RequestAuth,
  tenantId?: string,
): Promise<DispatchBoardDetail> {
  return getJson<DispatchBoardDetail>(
    `/jobs/dispatch-board/${encodeURIComponent(jobId)}`,
    buildAuthHeaders(auth, tenantId),
  );
}

export async function assignDispatchJob(
  jobId: string,
  input: {
    technicianId: string;
    expectedUpdatedAt: string;
    reason?: string;
  },
  auth: RequestAuth,
  tenantId?: string,
): Promise<{
  changed: boolean;
  jobId: string;
  assignedTechnician: AssignedTechnician | null;
  updatedAt: string;
}> {
  return postJson(
    `/jobs/${encodeURIComponent(jobId)}/assignments`,
    input,
    buildAuthHeaders(auth, tenantId),
  );
}

export async function cancelDispatchAssignment(
  jobId: string,
  input: { expectedUpdatedAt: string; reason: string },
  auth: RequestAuth,
  tenantId?: string,
): Promise<{
  changed: boolean;
  jobId: string;
  assignedTechnician: null;
  updatedAt: string;
}> {
  return postJson(
    `/jobs/${encodeURIComponent(jobId)}/assignments/cancel`,
    input,
    buildAuthHeaders(auth, tenantId),
  );
}

export async function createTechnicianLink(
  technicianId: string,
  expiresInHours: number | undefined,
  auth: RequestAuth,
  tenantId?: string,
): Promise<{
  technician: { id: string; fullName: string };
  expiresAt: string;
  url: string;
}> {
  return postJson(
    `/jobs/technician-links/${encodeURIComponent(technicianId)}`,
    expiresInHours ? { expiresInHours } : {},
    buildAuthHeaders(auth, tenantId),
  );
}

export async function getRoutingSnapshot(
  auth: RequestAuth,
  tenantId?: string,
): Promise<RoutingSnapshot> {
  return getJson("/jobs/routing", buildAuthHeaders(auth, tenantId));
}

export async function saveServiceArea(
  serviceAreaId: string | null,
  input: { name: string; status: "ACTIVE" | "INACTIVE"; postalCodes: string[] },
  auth: RequestAuth,
  tenantId?: string,
) {
  const path = serviceAreaId
    ? `/jobs/routing/service-areas/${encodeURIComponent(serviceAreaId)}`
    : "/jobs/routing/service-areas";
  return postJson(path, input, buildAuthHeaders(auth, tenantId));
}

export async function saveRoutingRule(
  ruleId: string | null,
  input: {
    name: string;
    status: "ACTIVE" | "INACTIVE";
    priority: number;
    serviceCategoryId?: string;
    serviceAreaId?: string;
    urgency?: UrgencyLevel;
    timeScope: RoutingTimeScope;
    requireAvailable: boolean;
    requireOnCall: boolean;
    escalateToOwner: boolean;
    escalateToOnCall: boolean;
  },
  auth: RequestAuth,
  tenantId?: string,
) {
  const path = ruleId
    ? `/jobs/routing/rules/${encodeURIComponent(ruleId)}`
    : "/jobs/routing/rules";
  return postJson(path, input, buildAuthHeaders(auth, tenantId));
}

export async function configureTechnicianRouting(
  technicianId: string,
  input: {
    isAvailable: boolean;
    isOnCall: boolean;
    capabilities: Array<{
      serviceCategoryId: string;
      proficiency: "JUNIOR" | "STANDARD" | "EXPERT";
      isEnabled: boolean;
    }>;
  },
  auth: RequestAuth,
  tenantId?: string,
) {
  return postJson(
    `/jobs/routing/technicians/${encodeURIComponent(technicianId)}`,
    input,
    buildAuthHeaders(auth, tenantId),
  );
}

export async function evaluateJobRouting(
  jobId: string,
  auth: RequestAuth,
  tenantId?: string,
): Promise<RoutingEvaluation> {
  return postJson(
    `/jobs/${encodeURIComponent(jobId)}/routing/evaluate`,
    {},
    buildAuthHeaders(auth, tenantId),
  );
}

function technicianHeaders(token: string): Record<string, string> {
  return { "x-technician-link": token };
}

export async function listTechnicianJobs(
  token: string,
): Promise<TechnicianJobList> {
  return getJson<TechnicianJobList>(
    "/technician/jobs",
    technicianHeaders(token),
  );
}

export async function getTechnicianJob(
  token: string,
  jobId: string,
): Promise<TechnicianJobDetail> {
  return getJson<TechnicianJobDetail>(
    `/technician/jobs/${encodeURIComponent(jobId)}`,
    technicianHeaders(token),
  );
}

export async function updateTechnicianJob(
  token: string,
  jobId: string,
  input: {
    action: TechnicianJobAction;
    expectedUpdatedAt: string;
    note?: string;
  },
): Promise<
  | (TechnicianJobDetail & { changed: boolean })
  | {
      jobId: string;
      action: "decline" | "cannot_take";
      changed: true;
      assignmentReleased: true;
      updatedAt: string;
    }
> {
  return postJson(
    `/technician/jobs/${encodeURIComponent(jobId)}/status`,
    input,
    technicianHeaders(token),
  );
}

export function getApiBaseUrl(): string {
  return apiBase;
}
