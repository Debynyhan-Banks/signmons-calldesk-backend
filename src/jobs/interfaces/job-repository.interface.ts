export interface CreateJobPayload {
  customerName: string;
  phone: string;
  address?: string;
  issueCategory: string;
  urgency: string;
  description?: string;
  preferredTime?: string;
  propertyType: "RESIDENTIAL" | "COMMERCIAL" | "MANAGED";
  serviceIntent:
    | "DIAGNOSTIC"
    | "REPAIR"
    | "INSTALLATION"
    | "MAINTENANCE"
    | "OTHER";
}

export interface CreateJobRequest {
  tenantId: string;
  payload: CreateJobPayload;
}

export interface CreateJobFromToolCallRequest {
  tenantId: string;
  sessionId: string;
  rawArgs?: string;
  deferInitialNotification?: boolean;
}

export type JobStatus =
  | "CREATED"
  | "OFFERED"
  | "ACCEPTED"
  | "DECLINED"
  | "EXPIRED"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "CANCELLED";

export interface JobRecord {
  id: string;
  tenantId: string;
  customerName: string;
  phone: string;
  address?: string;
  issueCategory: string;
  urgency: string;
  description?: string;
  preferredTime?: string;
  preferredTimeText?: string;
  propertyType: CreateJobPayload["propertyType"];
  serviceIntent: CreateJobPayload["serviceIntent"];
  serviceWindowStart?: Date;
  serviceWindowEnd?: Date;
  calendarEventId?: string;
  status: JobStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface IJobRepository {
  createJobFromToolCall(
    request: CreateJobFromToolCallRequest,
  ): Promise<JobRecord>;

  listJobs(tenantId: string): Promise<JobRecord[]>;
}
