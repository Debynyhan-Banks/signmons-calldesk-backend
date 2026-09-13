import type { ReviewReader } from "./client.ts";
import { validReference } from "./contract.ts";

export type ReviewFetch = (url: string, init: RequestInit) => Promise<Response>;
export type ReviewSessionSnapshot = {
  sessionKey: string;
  role: string | null;
  read: ReviewReader;
};
const MAX_BYTES = 256 * 1024;
let generation = 0;
const unavailable = () => new Error("Calendar review read is unavailable.");

function origin(value: string) {
  try {
    const url = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      throw unavailable();
    return url.origin;
  } catch {
    throw unavailable();
  }
}

/** Inactive integration seam. Explicit trusted origin/fetch; no default URL,
 * registration, storage or token decoding. Subscribe to every snapshot change
 * and pass the new descriptor to the unlinked panel; never use a token as a key.
 */
export class CalendarReviewHttpSession {
  #origin: string;
  #fetch: ReviewFetch;
  #token = "";
  #generation = 0;
  #snapshot: ReviewSessionSnapshot;
  #listeners = new Set<() => void>();
  #active = new Map<AbortController, () => void>();
  #disposed = false;

  constructor(apiOrigin: string, fetchImpl: ReviewFetch) {
    this.#origin = origin(apiOrigin);
    this.#fetch = fetchImpl;
    this.#snapshot = this.#rotate(null);
  }
  getSnapshot = () => this.#snapshot;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  #rotate(role: string | null, except?: AbortController) {
    for (const [controller, cancel] of this.#active)
      if (controller !== except) cancel();
    this.#generation = ++generation;
    const current = this.#generation;
    this.#snapshot = {
      sessionKey: "calendar-review-" + current,
      role,
      read: (input) => this.#read(current, input),
    };
    this.#listeners.forEach((listener) => listener());
    return this.#snapshot;
  }
  bind(input: { bearerToken: string; role: string | null }) {
    if (this.#disposed) return this.#snapshot;
    // Same credentials still receive a fresh, non-secret generation marker.
    this.#token = "";
    const token =
      typeof input?.bearerToken === "string" ? input.bearerToken.trim() : "";
    const role =
      typeof input?.role === "string" ? input.role.trim().toLowerCase() : null;
    const valid =
      token.length <= 16_384 && /^[A-Za-z0-9._~+/-]+=*$/.test(token);
    this.#token = valid && (role === "owner" || role === "admin") ? token : "";
    return this.#rotate(this.#token ? role : null);
  }
  clear() {
    this.#token = "";
    return this.#rotate(null);
  }
  dispose() {
    this.#disposed = true;
    this.clear();
    this.#listeners.clear();
  }

  async #read(
    current: number,
    input: Parameters<ReviewReader>[0],
  ): ReturnType<ReviewReader> {
    if (this.#disposed || current !== this.#generation || !this.#token)
      return { status: 401, body: null };
    if (!validReference(input.reference)) return { status: 400, body: null };
    const reference = input.reference.toLowerCase();
    const paths = {
      job: `/scheduling/calendar-review/jobs/${reference}/operations`,
      operation: `/scheduling/calendar-review/operations/${reference}`,
      requests: `/scheduling/calendar-review/operations/${reference}/recovery-requests`,
    };
    if (!Object.hasOwn(paths, input.resource))
      return { status: 400, body: null };
    const url = this.#origin + paths[input.resource];
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const responseBody: { current: ReadableStream<Uint8Array> | null } = {
      current: null,
    };
    let cancel!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      cancel = () => {
        controller.abort();
        void reader?.cancel().catch(() => {});
        reject(unavailable());
      };
    });
    const check = () => {
      if (
        controller.signal.aborted ||
        current !== this.#generation ||
        !this.#token
      ) {
        // A fetch double/nonconforming transport may resolve after cancellation.
        // Its late body must be released even after the outer finally completed.
        void reader?.cancel().catch(() => {});
        if (!reader) void responseBody.current?.cancel().catch(() => {});
        throw unavailable();
      }
    };
    this.#active.set(controller, cancel);
    input.signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(cancel, 15_000);
    if (input.signal.aborted) cancel();
    try {
      return await Promise.race([
        (async () => {
          check();
          const response = await this.#fetch(url, {
            method: "GET",
            headers: {
              Accept: "application/json",
              Authorization: "Bearer " + this.#token,
            },
            credentials: "omit",
            cache: "no-store",
            redirect: "error",
            referrerPolicy: "no-referrer",
            signal: controller.signal,
          });
          responseBody.current = response.body;
          check();
          if (response.redirected || (response.url && response.url !== url))
            throw unavailable();
          if (response.status === 401 || response.status === 403) {
            this.#token = "";
            this.#rotate(null, controller);
            void response.body?.cancel().catch(() => {});
            return { status: response.status, body: null };
          }
          if (response.status !== 200) {
            void response.body?.cancel().catch(() => {});
            return { status: response.status, body: null };
          }
          if (
            !/^application\/json(?:\s*;|$)/i.test(
              response.headers.get("content-type") ?? "",
            ) ||
            !response.headers
              .get("cache-control")
              ?.split(",")
              .some((part) => part.trim().toLowerCase() === "no-store") ||
            !response.body
          )
            throw unavailable();
          const length = response.headers.get("content-length");
          if (
            length !== null &&
            (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)
          )
            throw unavailable();
          reader = response.body.getReader();
          const decoder = new TextDecoder("utf-8", { fatal: true });
          let bytes = 0,
            text = "";
          while (true) {
            const chunk = await reader.read();
            check();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > MAX_BYTES) throw unavailable();
            text += decoder.decode(chunk.value, { stream: true });
          }
          text += decoder.decode();
          check();
          return { status: 200, body: JSON.parse(text) as unknown };
        })(),
        cancelled,
      ]);
    } catch {
      throw unavailable();
    } finally {
      clearTimeout(timer);
      input.signal.removeEventListener("abort", cancel);
      this.#active.delete(controller);
      controller.abort();
      void reader?.cancel().catch(() => {});
      if (!reader) void responseBody.current?.cancel().catch(() => {});
    }
  }
}
