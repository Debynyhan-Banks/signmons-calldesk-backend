export const CONTROLLED_INTAKE_STARTUP_STAGES = [
  "CONFIGURATION",
  "INJECTED_MATERIAL",
  "PACKAGED_ASSETS",
  "RESOURCE_CONSTRUCTION",
  "RUNTIME_LOADING",
  "RUNTIME_CONFIGURATION",
  "RUNTIME_RESOURCES",
  "RUNTIME_APPROVAL",
  "RUNTIME_KEY_MATERIAL",
  "RUNTIME_SERVICES",
  "RUNTIME_AUTHORITY",
  "RUNTIME_BINDING",
  "REGISTRATION",
] as const;

export type ControlledIntakeStartupStage =
  (typeof CONTROLLED_INTAKE_STARTUP_STAGES)[number];

const allowed = new Set<string>(CONTROLLED_INTAKE_STARTUP_STAGES);
const stages = new WeakMap<object, ControlledIntakeStartupStage>();

/** Internal startup metadata only; never attach an error cause or public field. */
export function markControlledIntakeStartupFailure<T>(
  error: T,
  stage: ControlledIntakeStartupStage,
): T {
  if (
    error &&
    (typeof error === "object" || typeof error === "function") &&
    allowed.has(stage) &&
    !stages.has(error)
  )
    stages.set(error, stage);
  return error;
}

export function controlledIntakeStartupFailureStage(
  error: unknown,
): ControlledIntakeStartupStage | undefined {
  return error && (typeof error === "object" || typeof error === "function")
    ? stages.get(error)
    : undefined;
}

export function recordControlledIntakeStartupFailure(
  logging: { warn(message: unknown): void },
  error: unknown,
) {
  const stage = controlledIntakeStartupFailureStage(error);
  if (!stage || !allowed.has(stage)) return;
  try {
    // Called only by main's bufferLogs:true startup catch. Emit this fixed
    // record immediately without flushing unrelated buffered initialization logs.
    Logger.detachBuffer();
    try {
      logging.warn(`CONTROLLED_INTAKE_STARTUP_FAILURE stage=${stage}`);
    } finally {
      Logger.attachBuffer();
    }
  } catch {
    // Diagnostic failure cannot replace refusal or prevent application close.
  }
}
import { Logger } from "@nestjs/common";
