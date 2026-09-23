import { ConflictException, HttpException } from "@nestjs/common";

export const CONTROLLED_INTAKE_REFUSAL_STAGES = [
  "INTAKE_STATE_CHANGED",
  "LIFE_SAFETY_REFUSAL",
  "CURRENT_VERIFICATION_UNAVAILABLE",
] as const;

export type ControlledIntakeRefusalStage =
  (typeof CONTROLLED_INTAKE_REFUSAL_STAGES)[number];

const stages = new WeakMap<object, ControlledIntakeRefusalStage>();
const allowed = new Set<string>(CONTROLLED_INTAKE_REFUSAL_STAGES);

export function markControlledIntakeRefusal<T>(
  error: T,
  fallback: ControlledIntakeRefusalStage,
): T {
  if (
    error instanceof HttpException &&
    error.getStatus() === 409 &&
    !stages.has(error)
  )
    stages.set(error, fallback);
  return error;
}

export function controlledIntakeConflict(
  stage: ControlledIntakeRefusalStage,
  response: string | object,
) {
  return markControlledIntakeRefusal(new ConflictException(response), stage);
}

export function controlledIntakeRefusalStage(
  error: unknown,
): ControlledIntakeRefusalStage | undefined {
  return error && (typeof error === "object" || typeof error === "function")
    ? stages.get(error)
    : undefined;
}

export function recordControlledIntakeRefusal(
  logging: { warn(message: unknown, context?: string): void },
  entry: {
    operation: string;
    status: number;
    refusalStage?: ControlledIntakeRefusalStage;
  },
) {
  if (
    entry.operation !== "submit" ||
    entry.status !== 409 ||
    !entry.refusalStage ||
    !allowed.has(entry.refusalStage)
  )
    return;
  logging.warn(
    `CONTROLLED_INTAKE_REFUSAL operation=submit status=409 stage=${entry.refusalStage}`,
    "ControlledIntakeRuntime",
  );
}
