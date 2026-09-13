import { parseReview, reviewError, validReference } from "./contract.ts";
import type { ReviewData, ReviewResource } from "./contract.ts";

// Injection only: no default fetch, URL, token decoding, storage or mutation seam.
export type ReviewReader = (input: {
  resource: ReviewResource;
  reference: string;
  signal: AbortSignal;
}) => Promise<{ status: number; body: unknown }>;
export type ReviewScope = {
  sessionKey: string;
  role: string | null;
  jobId: string;
  operationId: string;
};
export type ReviewView = {
  state: "idle" | "loading" | "ready" | "error";
  data?: ReviewData;
  message?: string;
};
export type ReviewState = {
  allowed: boolean;
  views: Record<ReviewResource, ReviewView>;
};
const resources: ReviewResource[] = ["job", "operation", "requests"];
const emptyViews = (): ReviewState["views"] => ({
  job: { state: "idle" },
  operation: { state: "idle" },
  requests: { state: "idle" },
});

export class CalendarReviewClient {
  private scope: ReviewScope = {
    sessionKey: "",
    role: null,
    jobId: "",
    operationId: "",
  };
  private state: ReviewState = { allowed: false, views: emptyViews() };
  private listeners = new Set<() => void>();
  private pending = new Map<
    ReviewResource,
    { controller: AbortController; cancel: () => void }
  >();
  private disposed = false;
  private deniedSessionKey: string | null = null;
  private readonly read: ReviewReader;
  private readonly timeoutMs: number;
  constructor(read: ReviewReader, timeoutMs = 15_000) {
    this.read = read;
    this.timeoutMs = timeoutMs;
  }
  getState = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(state: ReviewState) {
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }
  private cancelAll() {
    this.pending.forEach((request) => request.cancel());
    this.pending.clear();
  }
  setScope(scope: ReviewScope) {
    if (
      this.disposed ||
      (Object.keys(scope) as (keyof ReviewScope)[]).every(
        (key) => scope[key] === this.scope[key],
      )
    )
      return;
    this.cancelAll();
    this.scope = { ...scope };
    this.publish({
      allowed:
        scope.sessionKey !== this.deniedSessionKey &&
        Boolean(scope.sessionKey.trim()) &&
        ["owner", "admin"].includes(scope.role?.trim().toLowerCase() ?? ""),
      views: emptyViews(),
    });
  }
  clear() {
    this.cancelAll();
    this.scope = { sessionKey: "", role: null, jobId: "", operationId: "" };
    this.publish({ allowed: false, views: emptyViews() });
  }
  dispose() {
    this.clear();
    this.disposed = true;
    this.listeners.clear();
  }
  async load(resource: ReviewResource) {
    if (this.disposed || !this.state.allowed || this.pending.has(resource))
      return;
    const reference =
      resource === "job" ? this.scope.jobId : this.scope.operationId;
    const update = (view: ReviewView) =>
      this.publish({
        ...this.state,
        views: { ...this.state.views, [resource]: view },
      });
    if (!validReference(reference)) {
      update({ state: "error", message: reviewError(400) });
      return;
    }
    const controller = new AbortController();
    let cancel!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      cancel = () => {
        controller.abort();
        reject(new Error("Cancelled"));
      };
    });
    const pending = { controller, cancel };
    this.pending.set(resource, pending);
    update({ state: "loading" });
    const timer = setTimeout(cancel, this.timeoutMs);
    try {
      const response = await Promise.race([
        Promise.resolve().then(() => {
          if (controller.signal.aborted) throw new Error("Cancelled");
          return this.read({
            resource,
            reference: reference.toLowerCase(),
            signal: controller.signal,
          });
        }),
        cancelled,
      ]);
      if (this.pending.get(resource) !== pending) return;
      if (response.status === 401 || response.status === 403) {
        this.deniedSessionKey = this.scope.sessionKey;
        this.cancelAll();
        this.publish({
          allowed: false,
          views: Object.fromEntries(
            resources.map((key) => [
              key,
              { state: "error", message: reviewError(response.status) },
            ]),
          ) as ReviewState["views"],
        });
        return;
      }
      if (response.status !== 200) {
        update({ state: "error", message: reviewError(response.status) });
        return;
      }
      update({
        state: "ready",
        data: parseReview(resource, response.body, reference),
      });
    } catch {
      if (this.pending.get(resource) === pending)
        update({ state: "error", message: reviewError() });
    } finally {
      clearTimeout(timer);
      if (this.pending.get(resource) === pending) this.pending.delete(resource);
    }
  }
}
