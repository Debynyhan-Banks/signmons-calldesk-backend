import { Transform, TransformFnParams } from "class-transformer";
import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from "class-validator";

export const TECHNICIAN_JOB_ACTIONS = [
  "accept",
  "decline",
  "on_my_way",
  "in_progress",
  "complete",
  "cannot_take",
] as const;

export type TechnicianJobAction = (typeof TECHNICIAN_JOB_ACTIONS)[number];

const normalizeNote = ({ value }: TransformFnParams): string | undefined =>
  typeof value === "string"
    ? value.replace(/\s+/g, " ").trim() || undefined
    : undefined;

export class UpdateTechnicianJobDto {
  @IsIn(TECHNICIAN_JOB_ACTIONS)
  action!: TechnicianJobAction;

  @IsDateString()
  expectedUpdatedAt!: string;

  @Transform(normalizeNote)
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
