import { AddressOperationLedger } from "./address-operation-ledger";
export type AddressOperationClaim = Awaited<
  ReturnType<AddressOperationLedger["execute"]>
>;

/** Fixture run and separate capability-gated controlled run; no production bootstrap.
 * Durable claim precedes work. Abort cannot prove absence; no automatic replay.
 */
export class AddressOperationExecutor {
  constructor(
    private readonly ledger: Pick<
      AddressOperationLedger,
      "execute" | "complete"
    > &
      Partial<
        Pick<AddressOperationLedger, "executeControlled" | "completeControlled">
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
    if (!mock || mock.mode !== "FIXTURE_ONLY") return uncertain();
    return this.perform(
      input,
      (signal, claim) =>
        mock.run(signal, {
          intentId: claim.intentId,
          revision: claim.revision,
        }),
      false,
    );
  }
  runControlled<T>(
    input: { sessionToken: string; requestId: string },
    work: (signal: AbortSignal, claim: AddressOperationClaim) => Promise<T>,
  ) {
    return this.perform(input, work, true);
  }
  private async perform<T>(
    input: { sessionToken: string; requestId: string },
    work: (signal: AbortSignal, claim: AddressOperationClaim) => Promise<T>,
    controlled: boolean,
  ) {
    if (
      controlled &&
      (!this.ledger.executeControlled || !this.ledger.completeControlled)
    )
      return uncertain();
    const execute = controlled
      ? this.ledger.executeControlled!.bind(this.ledger)
      : this.ledger.execute.bind(this.ledger);
    const complete = controlled
      ? this.ledger.completeControlled!.bind(this.ledger)
      : this.ledger.complete.bind(this.ledger);
    input = { ...input };
    let claim: Awaited<ReturnType<AddressOperationLedger["execute"]>>;
    try {
      await execute({ ...input, action: "reserve" });
      claim = await execute({ ...input, action: "claim" });
    } catch {
      return uncertain();
    }
    if (!claim.claimed || !claim.attemptId || !claim.executionDeadline)
      return uncertain();
    if (controlled && claim.fixtureOnly !== false) return uncertain();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (state: "OBSERVED" | "UNCERTAIN") =>
      complete({ ...input, attemptId: claim.attemptId!, state });
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
          return work(controller.signal, claim);
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
const uncertain = () => ({ status: "UNCERTAIN" as const });
