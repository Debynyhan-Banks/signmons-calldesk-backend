import { Transform, TransformFnParams, Type } from "class-transformer";
import {
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from "class-validator";
import { IsSafeMessage } from "../../common/validators/is-safe-message.decorator";
import { LeadAttributionDto } from "./lead-attribution.dto";

const trimToString = ({ value }: TransformFnParams): string =>
  typeof value === "string" ? value.trim() : "";

export class TriageDto {
  @Transform(trimToString)
  @IsString()
  @MinLength(4)
  @MaxLength(64)
  sessionId!: string;

  @Transform(trimToString)
  @IsString()
  @IsSafeMessage()
  message!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => LeadAttributionDto)
  attribution?: LeadAttributionDto;
}
