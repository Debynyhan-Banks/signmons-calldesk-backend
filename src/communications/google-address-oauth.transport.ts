import { GoogleAuth } from "google-auth-library";
import { GoogleAddressRequest } from "./google-address.adapter";

const endpoint = "https://addressvalidation.googleapis.com/v1:validateAddress";
const maxResponseBytes = 64 * 1024;

type Ports = {
  token: () => Promise<string | null | undefined>;
  fetch: typeof fetch;
};

export type GoogleAddressTransportResult =
  | { status: "DISABLED" | "INVALID_INPUT" | "UNAVAILABLE" }
  | { status: "RESPONSE"; body: Record<string, unknown> };

/** Internal transport only. No DI, environment activation, proof or admission.
 * Future composition must reserve budget and authorize the operation first.
 * RESPONSE is transient provider content, never a customer-facing receipt.
 */
export class GoogleAddressOAuthTransport {
  constructor(
    private readonly enabled = false,
    private readonly ports: Ports = {
      token: async () =>
        new GoogleAuth({
          scopes: ["https://www.googleapis.com/auth/cloud-platform"],
        }).getAccessToken(),
      fetch: (...args) => fetch(...args),
    },
  ) {}

  async validate(
    input: GoogleAddressRequest,
  ): Promise<GoogleAddressTransportResult> {
    if (this.enabled !== true) return { status: "DISABLED" };
    const body = requestBody(input);
    if (body === null) return { status: "INVALID_INPUT" };
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<GoogleAddressTransportResult>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ status: "UNAVAILABLE" });
      }, 8_000);
    });
    try {
      return await Promise.race([
        this.execute(body, controller.signal),
        timeout,
      ]);
    } catch {
      // Never expose/log credentials, address content or provider errors.
      return { status: "UNAVAILABLE" };
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
    }
  }

  private async execute(
    body: string,
    signal: AbortSignal,
  ): Promise<GoogleAddressTransportResult> {
    const token = await this.ports.token();
    // A late credential response must never dispatch after the deadline.
    if (signal.aborted || !token || /[\s\p{Cc}]/u.test(token))
      return { status: "UNAVAILABLE" };
    const response = await this.ports.fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Goog-User-Project": "signmons",
      },
      body,
      redirect: "error",
      signal,
    });
    if (
      signal.aborted ||
      !response.ok ||
      !/^application\/json(?:\s*;|$)/i.test(
        response.headers.get("content-type") ?? "",
      ) ||
      Number(response.headers.get("content-length")) > maxResponseBytes
    ) {
      await response.body?.cancel();
      return { status: "UNAVAILABLE" };
    }
    const reader = response.body?.getReader();
    if (!reader) return { status: "UNAVAILABLE" };
    const cancel = () => {
      void reader.cancel().catch(() => undefined);
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const chunk = await reader.read();
        if (signal.aborted) return { status: "UNAVAILABLE" };
        if (chunk.done) break;
        if (!(chunk.value instanceof Uint8Array))
          return { status: "UNAVAILABLE" };
        size += chunk.value.byteLength;
        if (size > maxResponseBytes) return { status: "UNAVAILABLE" };
        chunks.push(chunk.value);
      }
      const parsed: unknown = JSON.parse(
        Buffer.concat(chunks).toString("utf8"),
      );
      if (!object(parsed) || !object(parsed.result))
        return { status: "UNAVAILABLE" };
      return { status: "RESPONSE", body: parsed };
    } finally {
      signal.removeEventListener("abort", cancel);
      await reader.cancel();
    }
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requestBody(input: unknown): string | null {
  if (
    !object(input) ||
    Object.keys(input).sort().join() !== "address,enableUspsCass" ||
    input.enableUspsCass !== true ||
    !object(input.address)
  )
    return null;
  const address = input.address;
  if (
    Object.keys(address).sort().join() !==
      "addressLines,administrativeArea,locality,postalCode,regionCode" ||
    address.regionCode !== "US" ||
    address.administrativeArea !== "OH" ||
    typeof address.postalCode !== "string" ||
    !/^\d{5}(-\d{4})?$/.test(address.postalCode) ||
    !Array.isArray(address.addressLines) ||
    address.addressLines.length < 1 ||
    address.addressLines.length > 2
  )
    return null;
  const lines: unknown[] = address.addressLines;
  const fields = [address.locality, ...lines];
  if (
    !fields.every(
      (value) =>
        typeof value === "string" &&
        value.length > 0 &&
        value.length <= 150 &&
        value.trim() === value &&
        !/[\p{Cc}\p{Cf}]/u.test(value),
    )
  )
    return null;
  if (fields.join("").length + address.postalCode.length + 4 > 280) return null;
  // Copy only the fixed wire schema before awaiting credentials.
  return JSON.stringify({
    address: {
      regionCode: "US",
      administrativeArea: "OH",
      locality: address.locality,
      postalCode: address.postalCode,
      addressLines: [...lines],
    },
    enableUspsCass: true,
  });
}
