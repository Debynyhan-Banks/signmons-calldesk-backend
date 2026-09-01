import { Transform, TransformFnParams } from "class-transformer";
import { IsEnum, IsString, MaxLength, MinLength } from "class-validator";

const normalizeReason = ({ value }: TransformFnParams): string =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";

export class OverrideJobUrgencyDto {
  @IsEnum(["EMERGENCY", "HIGH", "STANDARD"])
  urgency!: "EMERGENCY" | "HIGH" | "STANDARD";

  @Transform(normalizeReason)
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason!: string;
}
