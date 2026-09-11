import { HttpException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { TextDecoder } from "node:util";
import { getRequestContext } from "../common/context/request-context";
import { extractIntakeEmail } from "../conversations/conversation-email.service";
import {
  CONSENT_PROMPT,
  CustomerConsentCredentials,
} from "./customer-consent-credentials";
import {
  CustomerBrowserBudget,
  CustomerBrowserOperation,
} from "./customer-consent-browser-budget";
import { CustomerConsentCaptureService } from "./customer-consent-capture.service";
import { CustomerConsentResponseService } from "./customer-consent-response.service";
import { CustomerIntakeContinuationService } from "./customer-intake-continuation.service";
import { validateCustomerIntakeDraft } from "./customer-intake-draft";

export const CUSTOMER_BROWSER_MAX_BYTES = 16384;
export const CUSTOMER_BROWSER_HEADERS = Object.freeze({
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  Expires: "0",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  Vary: "Origin, Sec-Fetch-Site",
});
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function fail(status: number): never {
  throw new HttpException("Customer request refused.", status);
}
const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return fail(400);
  return v as Record<string, unknown>;
};

/** Read before JSON parsing; upstream socket/header/time limits remain mandatory. */
export async function readCustomerBrowserBody(
  source: AsyncIterable<Uint8Array>,
) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of source) {
    bytes += chunk.byteLength;
    if (bytes > CUSTOMER_BROWSER_MAX_BYTES) fail(413);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, bytes);
}

export type CustomerBrowserRequest = {
  method: string;
  url: string;
  rawHeaders: string[];
  body: Buffer;
  peerAddress: string;
  encrypted: boolean;
};
type Binding = { origin: string; tenantId: string; fixtureLoopback?: boolean };
type Ports = {
  correction?: {
    handle(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  };
  address?: {
    handle(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  };
  verification?: {
    handle(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  };
  localPhone?: {
    handle(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  };
  responses: Pick<
    CustomerConsentResponseService,
    "start" | "prompt" | "respond"
  >;
  capture: Pick<CustomerConsentCaptureService, "capture">;
  credentials: CustomerConsentCredentials;
  budget: CustomerBrowserBudget;
  continuation?: Pick<CustomerIntakeContinuationService, "continue">;
  draft?: Pick<CustomerIntakeContinuationService, "previewDraft">;
  review?: Pick<CustomerIntakeContinuationService, "submitReview">;
  diagnostic?: (entry: {
    operation: CustomerBrowserOperation | "unknown";
    status: number;
  }) => void;
};

/** Inactive browser/BFF boundary. No controller, server, environment/key loader or DI.
 * Trusted integration context, TLS and socket peer must be supplied by the server.
 * Origin/Fetch Metadata/custom header are CSRF defenses, NOT customer authentication.
 */
export class CustomerConsentBrowserTransport {
  private readonly origin?: URL;
  private readonly binding?: Readonly<Binding>;
  constructor(
    binding?: Binding,
    private readonly ports?: Ports,
  ) {
    if (!binding) return;
    this.binding = Object.freeze({ ...binding });
    try {
      const origin = new URL(binding.origin);
      if (
        !UUID.test(binding.tenantId) ||
        origin.origin !== binding.origin ||
        (origin.protocol !== "https:" &&
          !(
            binding.fixtureLoopback === true &&
            origin.protocol === "http:" &&
            origin.hostname === "127.0.0.1" &&
            origin.port
          ))
      )
        fail(503);
      this.origin = origin;
    } catch {
      fail(503);
    }
  }

  async handle(request: CustomerBrowserRequest) {
    let operation: CustomerBrowserOperation | "unknown" = "unknown";
    let release: (() => void) | undefined;
    let status = 503,
      result: Record<string, unknown> = { error: "Customer request refused." };
    try {
      const { origin, binding, ports } = this;
      if (!origin || !binding || !ports?.budget) fail(503);
      const ctx = getRequestContext();
      if (
        ctx?.tenantId !== binding.tenantId ||
        ctx.role !== "webchat_integration" ||
        !ctx.userId?.startsWith("integration:") ||
        ctx.impersonatedTenantId
      )
        fail(403);
      const match =
        /^\/customer-session\/(start|capture|prompt|respond|continue|draft|submit|phone|verify|address|correction)$/.exec(
          request.url,
        );
      if (!match || request.method !== "POST") fail(403);
      operation = match[1] as CustomerBrowserOperation;
      if (
        !isIP(request.peerAddress) ||
        (origin.protocol === "https:"
          ? request.encrypted !== true
          : request.peerAddress !== "127.0.0.1")
      )
        fail(403);
      const headers = this.headers(request.rawHeaders);
      if (
        headers.get("origin") !== binding.origin ||
        headers.get("host") !== origin.host ||
        headers.get("sec-fetch-site") !== "same-origin" ||
        !["cors", "same-origin"].includes(
          headers.get("sec-fetch-mode") ?? "",
        ) ||
        headers.get("sec-fetch-dest") !== "empty" ||
        headers.get("x-calldesk-request") !== "customer-intake-v1" ||
        headers.has("cookie") ||
        headers.has("authorization") ||
        headers.has("proxy-authorization") ||
        headers.has("content-encoding")
      )
        fail(403);
      if (headers.get("content-type") !== "application/json") fail(415);
      // Validate before parsing; unknown outcomes are not retried by this transport.
      release =
        ports.budget.acquire(request.peerAddress, operation) ?? undefined;
      if (!release) fail(429);
      if (typeof release !== "function") fail(503);
      if (
        !Buffer.isBuffer(request.body) ||
        request.body.length > CUSTOMER_BROWSER_MAX_BYTES
      )
        fail(413);
      if (
        headers.has("content-length") &&
        headers.get("content-length") !== String(request.body.length)
      )
        fail(400);
      let parsed: unknown;
      try {
        const raw = new TextDecoder("utf-8", { fatal: true }).decode(
          request.body,
        );
        parsed = JSON.parse(raw) as unknown;
        // Compact canonical JSON refuses duplicate keys and parser ambiguity.
        if (JSON.stringify(parsed) !== raw) fail(400);
      } catch {
        fail(400);
      }
      const input = object(parsed);
      const keys = {
        correction: "action,candidateId,confirmed,input,revision,sessionToken",
        address:
          "action,candidateId,confirmed,expectedRevision,operationId,query,sessionToken,unit",
        verify:
          "action,code,noticeVersion,operationId,phone,requested,sessionToken,startOperationId",
        phone: "action,code,expectedRevision,operationId,phone,sessionToken",
        start: "",
        capture: "email,sessionToken",
        prompt: "sessionToken",
        continue: "interactionId,message,sessionToken",
        draft: Object.prototype.hasOwnProperty.call(input, "addressSelection")
          ? "addressSelection,draft,expectedRevision,sessionToken"
          : "draft,expectedRevision,sessionToken",
        submit: Object.prototype.hasOwnProperty.call(input, "addressSelection")
          ? "addressSelection,confirmed,draft,expectedRevision,requestId,sessionToken"
          : "confirmed,draft,expectedRevision,requestId,sessionToken",
        respond: "mailboxConfirmed,promptToken,response,sessionToken",
      };
      if (Object.keys(input).sort().join(",") !== keys[operation]) fail(400);
      if (operation !== "start") {
        if (
          typeof input.sessionToken !== "string" ||
          input.sessionToken.length > 4096
        )
          fail(401);
        if (
          ports.credentials.verifySession(input.sessionToken).tenantId !==
          binding.tenantId
        )
          fail(403);
      }
      result = await this.invoke(operation, input, ports, binding.tenantId);
      status = 200;
    } catch (error) {
      const candidate =
        error instanceof HttpException ? error.getStatus() : 503;
      status = [400, 401, 403, 409, 413, 415, 429].includes(candidate)
        ? candidate
        : 503;
    } finally {
      // A diagnostic/release fault cannot alter a committed application outcome.
      try {
        release?.();
      } catch {
        /* Invalid adapter must be repaired before activation. */
      }
      try {
        this.ports?.diagnostic?.({ operation, status });
      } catch {
        /* No raw error fallback. */
      }
    }
    return { status, headers: { ...CUSTOMER_BROWSER_HEADERS }, body: result };
  }

  private headers(raw: string[]) {
    if (
      !Array.isArray(raw) ||
      raw.length % 2 ||
      raw.length > 200 ||
      raw.some((v) => typeof v !== "string" || v.length > 4096) ||
      raw.reduce((n, v) => n + Buffer.byteLength(v), 0) > 8192
    )
      return fail(400);
    const headers = new Map<string, string>();
    for (let i = 0; i < raw.length; i += 2) {
      const name = raw[i].toLowerCase(),
        value = raw[i + 1];
      if (
        !/^[a-z0-9-]+$/.test(name) ||
        /[\r\n\0]/.test(value) ||
        headers.has(name)
      )
        fail(400);
      headers.set(name, value);
    }
    return headers;
  }

  private async invoke(
    operation: CustomerBrowserOperation,
    input: Record<string, unknown>,
    ports: Ports,
    tenantId: string,
  ) {
    if (operation === "start") {
      const value = await ports.responses.start();
      const claims = ports.credentials.verifySession(value.sessionToken);
      if (claims.tenantId !== tenantId || value.deliveryAuthorized !== false)
        fail(503);
      return {
        sessionToken: value.sessionToken,
        expiresAt: new Date(claims.expiresAt).toISOString(),
        deliveryAuthorized: false,
      };
    }
    const sessionToken = input.sessionToken as string;
    if (operation === "correction") {
      if (this.binding?.fixtureLoopback !== true || !ports.correction)
        fail(503);
      return ports.correction.handle(input);
    }
    if (operation === "address") {
      if (this.binding?.fixtureLoopback !== true || !ports.address) fail(503);
      return ports.address.handle(input);
    }
    if (operation === "verify") {
      if (this.binding?.fixtureLoopback !== true || !ports.verification)
        fail(503);
      return ports.verification.handle(input);
    }
    if (operation === "phone") {
      if (this.binding?.fixtureLoopback !== true || !ports.localPhone)
        fail(503);
      return ports.localPhone.handle(input);
    }
    if (operation === "submit") {
      if (!ports.review) fail(503);
      if (
        input.addressSelection !== undefined &&
        this.binding?.fixtureLoopback !== true
      )
        fail(503);
      if (
        input.confirmed !== true ||
        typeof input.requestId !== "string" ||
        !UUID.test(input.requestId) ||
        !Number.isInteger(input.expectedRevision) ||
        (input.expectedRevision as number) < 1 ||
        (input.expectedRevision as number) > 20
      )
        fail(400);
      const value = await ports.review.submitReview({
        sessionToken,
        requestId: input.requestId,
        expectedRevision: input.expectedRevision as number,
        draft: validateCustomerIntakeDraft(input.draft),
        confirmed: true,
        ...(input.addressSelection !== undefined
          ? { addressSelection: input.addressSelection }
          : {}),
      });
      const claims = ports.credentials.verifySession(sessionToken);
      if (
        value.requestId !== input.requestId ||
        value.state !== "PENDING_REVIEW" ||
        value.expiresAt !== new Date(claims.expiresAt).toISOString() ||
        value.jobCreated !== false ||
        value.bookingAuthorized !== false ||
        value.deliveryAuthorized !== false
      )
        fail(503);
      return {
        requestId: value.requestId,
        state: "PENDING_REVIEW",
        expiresAt: value.expiresAt,
        jobCreated: false,
        bookingAuthorized: false,
        deliveryAuthorized: false,
      };
    }
    if (operation === "draft") {
      if (!ports.draft) fail(503);
      if (
        !Number.isInteger(input.expectedRevision) ||
        (input.expectedRevision as number) < 1 ||
        (input.expectedRevision as number) > 20
      )
        fail(400);
      let draft = validateCustomerIntakeDraft(input.draft);
      const selection = input.addressSelection;
      const checkAddress = async () => {
        if (this.binding?.fixtureLoopback !== true || !ports.address) fail(503);
        const selected = object(selection);
        if (
          Object.keys(selected).sort().join(",") !==
          "candidateId,query,revision,unit"
        )
          fail(400);
        const receipt = await ports.address.handle({
          sessionToken,
          action: "review",
          operationId: randomUUID(),
          expectedRevision: selected.revision,
          query: selected.query,
          unit: selected.unit,
          candidateId: selected.candidateId,
          confirmed: true,
        });
        if (
          receipt.fixtureOnly !== true ||
          receipt.stale !== false ||
          receipt.addressAuthorized !== false ||
          receipt.bookingAuthorized !== false ||
          receipt.deliveryAuthorized !== false ||
          receipt.addressState !== "FIXTURE_VALIDATED" ||
          receipt.revision !== selected.revision ||
          receipt.selectedId !== selected.candidateId ||
          receipt.query !== selected.query ||
          receipt.unit !== selected.unit ||
          !["FIXTURE_IN_AREA", "OUT_OF_AREA", "UNKNOWN"].includes(
            String(receipt.coverage),
          ) ||
          !Array.isArray(receipt.candidates)
        )
          fail(503);
        const candidate = receipt.candidates
          .map(object)
          .find((c) => c.id === selected.candidateId);
        if (
          !candidate ||
          typeof candidate.address !== "string" ||
          typeof receipt.unit !== "string"
        )
          fail(503);
        return {
          fixtureOnly: true,
          revision: receipt.revision,
          candidateId: receipt.selectedId,
          address:
            candidate.address + (receipt.unit ? ", " + receipt.unit : ""),
          coverage: receipt.coverage,
          addressAuthorized: false,
          bookingAuthorized: false,
          deliveryAuthorized: false,
        };
      };
      const localAddress =
        selection === undefined ? undefined : await checkAddress();
      if (localAddress)
        draft = validateCustomerIntakeDraft({
          ...draft,
          address: localAddress.address,
        });
      const value = await ports.draft.previewDraft({
        sessionToken,
        expectedRevision: input.expectedRevision as number,
        draft,
      });
      if (
        value.transcriptRevision !== input.expectedRevision ||
        value.jobCreated !== false ||
        value.bookingAuthorized !== false ||
        value.deliveryAuthorized !== false ||
        value.requiresHumanReview !== true ||
        value.urgencyAssessment !== "NOT_PERFORMED" ||
        !["NOT_RECORDED", "GRANTED", "DECLINED", "REVOKED"].includes(
          value.emailChoice,
        )
      )
        fail(503);
      const projected = validateCustomerIntakeDraft(value.draft);
      if (JSON.stringify(projected) !== JSON.stringify(draft)) fail(503);
      // Recheck after transcript preview; a changed selection/policy refuses the response.
      if (
        localAddress &&
        JSON.stringify(await checkAddress()) !== JSON.stringify(localAddress)
      )
        fail(409);
      return {
        ...(localAddress ? { localAddress } : {}),
        draft: projected,
        transcriptRevision: value.transcriptRevision,
        emailChoice: value.emailChoice,
        urgencyAssessment: "NOT_PERFORMED",
        requiresHumanReview: true,
        jobCreated: false,
        bookingAuthorized: false,
        deliveryAuthorized: false,
      };
    }
    if (operation === "continue") {
      if (!ports.continuation) fail(503);
      if (
        typeof input.interactionId !== "string" ||
        !UUID.test(input.interactionId) ||
        typeof input.message !== "string" ||
        !input.message.trim() ||
        input.message.length > 2000
      )
        fail(400);
      const value = await ports.continuation.continue({
        sessionToken,
        interactionId: input.interactionId,
        message: input.message,
      });
      if (
        value.deliveryAuthorized !== false ||
        typeof value.reply !== "string" ||
        !value.reply.trim() ||
        value.reply.length > 2000 ||
        !Number.isInteger(value.revision) ||
        value.revision < 1 ||
        value.revision > 20
      )
        fail(503);
      return {
        reply: value.reply,
        revision: value.revision,
        deliveryAuthorized: false,
      };
    }
    if (operation === "capture") {
      if (typeof input.email !== "string") fail(400);
      const value = await ports.capture.capture({
        sessionToken,
        email: input.email,
      });
      if (value.status !== "captured" || value.deliveryAuthorized !== false)
        fail(503);
      return { status: "captured", deliveryAuthorized: false };
    }
    if (operation === "prompt") {
      const value = await ports.responses.prompt({ sessionToken });
      if (value.deliveryAuthorized !== false) fail(503);
      if (value.state === "completed")
        return { state: "completed", deliveryAuthorized: false };
      if (
        value.prompt !== CONSENT_PROMPT ||
        extractIntakeEmail(value.mailbox) !== value.mailbox
      )
        fail(503);
      const prompt = ports.credentials.verifyPrompt(
        value.promptToken,
        sessionToken,
      );
      return {
        state: "prompt",
        prompt: CONSENT_PROMPT,
        mailbox: value.mailbox,
        promptToken: value.promptToken,
        expiresAt: new Date(prompt.expiresAt).toISOString(),
        deliveryAuthorized: false,
      };
    }
    if (
      typeof input.promptToken !== "string" ||
      typeof input.response !== "string" ||
      typeof input.mailboxConfirmed !== "boolean"
    )
      fail(400);
    const value = await ports.responses.respond({
      sessionToken,
      promptToken: input.promptToken,
      response: input.response,
      mailboxConfirmed: input.mailboxConfirmed,
    });
    if (value.deliveryAuthorized !== false) fail(503);
    // Do not expose internal scope/audit/evidence identifiers through this browser seam.
    return { state: "recorded", deliveryAuthorized: false };
  }
}
