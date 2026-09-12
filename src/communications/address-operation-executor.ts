import { AddressOperationLedger } from "./address-operation-ledger";

/** Only executes an explicitly injected local mock; no production bootstrap.
 * Durable claim precedes work. Abort cannot prove absence; no automatic replay.
 */
export class AddressOperationExecutor {
  constructor(
    private readonly ledger: Pick<
      AddressOperationLedger,
      "execute" | "complete"
    >,
    private readonly now: () => number = Date.now,
  ) {}
  async run<T>(
    input: { sessionToken: string; requestId: string },
    mock: {
      mode: "FIXTURE_ONLY";
      run: (
        signal: AbortSignal,
        binding: { intentId: string; revision: number },
      ) => Promise<T>;
    },
  ) {
    const uncertain = () => ({ status: "UNCERTAIN" as const });
    if (!mock || mock.mode !== "FIXTURE_ONLY") return uncertain();
    input = { ...input };
    const work = mock.run;
    let claim: Awaited<ReturnType<AddressOperationLedger["execute"]>>;
    try {
      await this.ledger.execute({ ...input, action: "reserve" });
      claim = await this.ledger.execute({ ...input, action: "claim" });
    } catch {
      return uncertain();
    }
    if (!claim.claimed || !claim.attemptId || !claim.executionDeadline)
      return uncertain();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (state: "OBSERVED" | "UNCERTAIN") =>
      this.ledger.complete({ ...input, attemptId: claim.attemptId!, state });
    try {
      const startedAt = this.now();
      const current = () => {
        const now = this.now();
        return (
          Number.isFinite(now) &&
          now >= startedAt &&
          now < claim.executionDeadline!
        );
      };
      const remaining = claim.executionDeadline - startedAt;
      if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 8000)
        throw Error("expired");
      const value = await Promise.race([
        Promise.resolve().then(() => {
          if (!current()) throw Error("expired");
          return work(controller.signal, {
            intentId: claim.intentId,
            revision: claim.revision,
          });
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(Error("timeout"));
          }, remaining);
        }),
      ]);
      if (controller.signal.aborted || !current()) throw Error("late");
      const result = await finish("OBSERVED");
      if (!result.completed || result.state !== "OBSERVED" || !current())
        return uncertain();
      return { status: "OBSERVED" as const, value };
    } catch {
      controller.abort();
      try {
        await finish("UNCERTAIN");
      } catch {
        /* Durable claim and held cost remain. */
      }
      return uncertain();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
