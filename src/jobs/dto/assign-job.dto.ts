import { Transform, TransformFnParams } from "class-transformer";
import {
  IsDateString,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from "class-validator";

const normalizeReason = ({ value }: TransformFnParams): string | undefined =>
  typeof value === "string"
    ? value.replace(/\s+/g, " ").trim() || undefined
    : undefined;

export class AssignJobDto {
  @IsUUID()
  technicianId!: string;

  @IsDateString()
  expectedUpdatedAt!: string;

  @Transform(normalizeReason)
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
