import { Injectable } from "@nestjs/common";

export interface LifeSafetyEscalation {
  status: "safety_escalation";
  reply: string;
  requiresHumanHandoff: true;
  emergencyServicesRecommended: true;
}

const LIFE_SAFETY_PATTERNS = [
  /\b(smell|odor|odour)\s+(of\s+)?(natural\s+)?gas\b/i,
  /\bgas\s+(leak|odor|odour|smell)\b/i,
  /\bcarbon\s+monoxide\b/i,
  /\bco\s+(alarm|detector)\b/i,
  /\b(fire|flames)\b/i,
  /\b(burning\s+smell|electrical\s+burning)\b/i,
  /\b(sparks|sparking|arcing)\b/i,
  /\b(smoke|smoking)\b/i,
];

const SAFETY_REPLY =
  "Leave the affected area immediately if you can do so safely. From a safe location, call 911, the fire department, or your gas or electric utility emergency line. Do not operate the equipment, switches, breakers, panels, or gas valves, and do not rely on this chat for emergency response.";

@Injectable()
export class LifeSafetyService {
  assess(message: string): LifeSafetyEscalation | null {
    if (!LIFE_SAFETY_PATTERNS.some((pattern) => pattern.test(message))) {
      return null;
    }

    return {
      status: "safety_escalation",
      reply: SAFETY_REPLY,
      requiresHumanHandoff: true,
      emergencyServicesRecommended: true,
    };
  }
}
