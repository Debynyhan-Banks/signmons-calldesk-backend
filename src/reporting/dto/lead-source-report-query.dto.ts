import { Transform, TransformFnParams } from "class-transformer";
import { IsISO8601, IsString, Matches } from "class-validator";

const trimToString = ({ value }: TransformFnParams): string =>
  typeof value === "string" ? value.trim() : "";

const EXPLICIT_TIME_ZONE = /(?:Z|[+-]\d{2}:\d{2})$/;

export class LeadSourceReportQueryDto {
  @Transform(trimToString)
  @IsString()
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(EXPLICIT_TIME_ZONE)
  from!: string;

  @Transform(trimToString)
  @IsString()
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(EXPLICIT_TIME_ZONE)
  to!: string;
}
