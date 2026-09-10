import { isIP } from "node:net";
import { performance } from "node:perf_hooks";

export type CustomerBrowserOperation =
  | "start"
  | "capture"
  | "prompt"
  | "continue"
  | "draft"
  | "submit"
  | "phone"
  | "verify"
  | "respond";
export interface CustomerBrowserBudget {
  /** Atomic admission; peer comes from the server socket, never forwarded headers.
   * Release is idempotent and must not throw. A shared implementation is required
   * before multi-process deployment. Missing/unavailable budget must refuse.
   */
  acquire(
    peer: string,
    operation: CustomerBrowserOperation,
  ): (() => void) | null;
}

/** Local single-binding model only. No registration or persistent/distributed adapter.
 * Fixed 60s windows: 60 total / 10 starts, 20 per peer / 5 starts per peer,
 * 4 in-flight requests and 256 peer entries maximum. Restart resets this model.
 */
export class LocalCustomerBrowserBudget implements CustomerBrowserBudget {
  private windowStart = 0;
  private previous = -1;
  private total = 0;
  private starts = 0;
  private inFlight = 0;
  private peers = new Map<string, { total: number; starts: number }>();
  constructor(private readonly clock: () => number = () => performance.now()) {}

  acquire(peer: string, operation: CustomerBrowserOperation) {
    const now = this.clock();
    if (!isIP(peer) || !Number.isFinite(now) || now < this.previous || now < 0)
      return null;
    if (
      ![
        "start",
        "capture",
        "prompt",
        "respond",
        "continue",
        "draft",
        "submit",
        "phone",
        "verify",
      ].includes(operation)
    )
      return null;
    if (this.previous === -1 || now - this.windowStart >= 60000) {
      this.windowStart = now;
      this.total = 0;
      this.starts = 0;
      this.peers.clear();
    }
    this.previous = now;
    const prior = this.peers.get(peer);
    if (!prior && this.peers.size >= 256) return null;
    const count = prior ?? { total: 0, starts: 0 };
    if (
      this.inFlight >= 4 ||
      this.total >= 60 ||
      count.total >= 20 ||
      (operation === "start" && (this.starts >= 10 || count.starts >= 5))
    )
      return null;
    this.total++;
    count.total++;
    if (operation === "start") {
      this.starts++;
      count.starts++;
    }
    this.peers.set(peer, count);
    this.inFlight++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.inFlight--;
      }
    };
  }
}
