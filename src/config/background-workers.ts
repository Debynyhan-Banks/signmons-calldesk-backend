/** Revision-local switch. Omission preserves existing worker behavior. */
export function backgroundWorkersEnabled(): boolean {
  const value = process.env.BACKGROUND_WORKERS_ENABLED;
  return value === undefined || value === "true";
}
