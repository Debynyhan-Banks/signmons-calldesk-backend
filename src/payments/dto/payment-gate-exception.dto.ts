import { Transform, TransformFnParams } from "class-transformer";
import {
  IsDateString,
  IsEnum,
  IsString,
  MaxLength,
  MinLength,
} from "class-validator";

const normalizeReason = ({ value }: TransformFnParams): string =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";

export class PaymentGateExceptionDto {
  @IsEnum(["APPROVE", "REVOKE"])
  action!: "APPROVE" | "REVOKE";

  @Transform(normalizeReason)
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason!: string;

  @IsDateString()
  expectedJobUpdatedAt!: string;
}
