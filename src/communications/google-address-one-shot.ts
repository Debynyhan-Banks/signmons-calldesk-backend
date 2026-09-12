import { closeSync, fsyncSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GoogleAddressRequest } from "./google-address.adapter";
import { GoogleAddressOAuthTransport } from "./google-address-oauth.transport";

export type InspectionApproval = {
  approved: true;
  project: "signmons";
  packetId: string;
  rateVersion: string;
  startsAt: number;
  expiresAt: number;
  liabilityMicros: number;
  requestLimit: 1;
};

/** Internal one-shot runner, deliberately not registered or exposed as a CLI.
 * Uses a dedicated durable LOCAL claim, never promotes the fixture DB ledger.
 * The operator must supply a private durable directory and trusted approval.
 * One machine/process family only: not a distributed admission/budget system.
 */
export class GoogleAddressOneShot {
  constructor(
    private readonly options?: {
      approval: InspectionApproval;
      claimDirectory: string;
      transport: Pick<GoogleAddressOAuthTransport, "validate">;
      now?: () => number;
    },
  ) {}

  async run(request: GoogleAddressRequest) {
    const result = (
      status: "DISABLED" | "REFUSED" | "OBSERVED" | "UNCERTAIN",
    ) => ({
      status,
      admissionAuthorized: false as const,
      bookingAuthorized: false as const,
      deliveryAuthorized: false as const,
    });
    if (!this.options) return result("DISABLED");
    let fd: number | undefined;
    let claimed = false;
    try {
      const a = structuredClone(this.options.approval);
      const input = structuredClone(request);
      const now = this.options.now ?? Date.now;
      const start = now();
      if (
        a.approved !== true ||
        a.project !== "signmons" ||
        !/^[a-z0-9-]{1,64}$/.test(a.packetId) ||
        typeof a.rateVersion !== "string" ||
        !/^[a-zA-Z0-9._-]{1,80}$/.test(a.rateVersion) ||
        a.requestLimit !== 1 ||
        ![start, a.startsAt, a.expiresAt, a.liabilityMicros].every(
          Number.isSafeInteger,
        ) ||
        a.startsAt < 0 ||
        start < a.startsAt ||
        start >= a.expiresAt ||
        a.expiresAt - a.startsAt > 15 * 60000 ||
        a.liabilityMicros <= 0 ||
        a.liabilityMicros > 100000
      )
        return result("REFUSED");
      // Exclusive create prevents concurrent/restarted execution of THIS packet.
      // Never remove or refund this marker, even if no dispatch can be proven.
      fd = openSync(
        join(this.options.claimDirectory, a.packetId + ".held"),
        "wx",
        0o600,
      );
      writeFileSync(
        fd,
        JSON.stringify({
          packetId: a.packetId,
          project: a.project,
          rateVersion: a.rateVersion,
          liabilityMicros: a.liabilityMicros,
          requests: 1,
          claimedAt: start,
        }),
      );
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      // Persist the new directory entry before allowing network dispatch.
      const directory = openSync(this.options.claimDirectory, "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
      claimed = true;
      const current = now();
      if (
        !Number.isSafeInteger(current) ||
        current < start ||
        current >= a.expiresAt
      )
        return result("UNCERTAIN");
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const outcome = await Promise.race([
          this.options.transport.validate(input, controller.signal),
          new Promise<null>((resolve) => {
            timer = setTimeout(
              () => {
                controller.abort();
                resolve(null);
              },
              Math.min(8000, a.expiresAt - current),
            );
          }),
        ]);
        const end = now();
        // No raw response or derived county data returned, persisted or logged.
        return result(
          outcome?.status === "RESPONSE" &&
            !controller.signal.aborted &&
            Number.isSafeInteger(end) &&
            end >= current &&
            end < a.expiresAt
            ? "OBSERVED"
            : "UNCERTAIN",
        );
      } finally {
        if (timer) clearTimeout(timer);
        controller.abort();
      }
    } catch {
      return result(claimed ? "UNCERTAIN" : "REFUSED");
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
}
