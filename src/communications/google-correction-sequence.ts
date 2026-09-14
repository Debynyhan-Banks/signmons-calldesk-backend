/** Volatile, composition-owned correction IDs only; never serialize this object. */
export class GoogleCorrectionSequence {
  #entries = new Map<
    string,
    { id: string; expires: number; timer: NodeJS.Timeout }
  >();

  take(key: string): string | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    this.#entries.delete(key);
    clearTimeout(entry.timer);
    return Date.now() < entry.expires ? entry.id : undefined;
  }

  remember(key: string, id: unknown, sessionExpiry: number): boolean {
    this.take(key);
    if (
      typeof id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        id,
      )
    )
      return false;
    const now = Date.now();
    const expires = Math.min(sessionExpiry, now + 300_000);
    if (
      !Number.isFinite(expires) ||
      expires <= now ||
      this.#entries.size >= 1000
    )
      return false;
    const timer = setTimeout(() => this.#entries.delete(key), expires - now);
    timer.unref();
    this.#entries.set(key, { id, expires, timer });
    return true;
  }
}
