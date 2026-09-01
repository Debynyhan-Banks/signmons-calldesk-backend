import { Transform, TransformFnParams } from "class-transformer";
import { IsDateString, IsString, MaxLength, MinLength } from "class-validator";

const normalizeReason = ({ value }: TransformFnParams): string =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";

export class CancelJobAssignmentDto {
  @IsDateString()
  expectedUpdatedAt!: string;

  @Transform(normalizeReason)
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason!: string;
}
