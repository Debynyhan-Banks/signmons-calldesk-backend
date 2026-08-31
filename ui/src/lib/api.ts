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

export function getApiBaseUrl(): string {
  return apiBase;
}
