import { Transform, TransformFnParams } from "class-transformer";
import { IsOptional, IsString, Matches, MaxLength } from "class-validator";

const trimToString = ({ value }: TransformFnParams): string =>
  typeof value === "string" ? value.trim() : "";

export class LeadAttributionDto {
  @Transform(trimToString)
  @IsString()
  @Matches(/^website_chat$/)
  channel!: "website_chat";

  @Transform(trimToString)
  @IsOptional()
  @IsString()
  @Matches(/^\/[A-Za-z0-9/_-]*$/)
  @MaxLength(200)
  landingPage?: string;

  @Transform(trimToString)
  @IsOptional()
  @IsString()
  @Matches(/^\/[A-Za-z0-9/_-]*$/)
  @MaxLength(200)
  sourcePage?: string;

  @Transform(trimToString)
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9.-]+$/)
  @MaxLength(253)
  referrerHost?: string;

  @Transform(trimToString)
  @IsOptional()
  @IsString()
  @MaxLength(100)
  utmSource?: string;

  @Transform(trimToString)
  @IsOptional()
  @IsString()
  @MaxLength(100)
  utmMedium?: string;

  @Transform(trimToString)
  @IsOptional()
  @IsString()
  @MaxLength(160)
  utmCampaign?: string;
}
