import { Transform, Type } from "class-transformer";
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import {
  JobUrgency,
  RoutingRuleStatus,
  RoutingTimeScope,
} from "@prisma/client";

const clean = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim() : value;

export class SaveRoutingRuleDto {
  @Transform(clean)
  @IsString()
  @MaxLength(120)
  name!: string;

  @IsEnum(RoutingRuleStatus)
  status!: RoutingRuleStatus;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  priority!: number;

  @IsOptional()
  @IsUUID()
  serviceCategoryId?: string;

  @IsOptional()
  @IsUUID()
  serviceAreaId?: string;

  @IsOptional()
  @IsEnum(JobUrgency)
  urgency?: JobUrgency;

  @IsEnum(RoutingTimeScope)
  timeScope!: RoutingTimeScope;

  @IsBoolean()
  requireAvailable!: boolean;

  @IsBoolean()
  requireOnCall!: boolean;

  @IsBoolean()
  escalateToOwner!: boolean;

  @IsBoolean()
  escalateToOnCall!: boolean;
}
