import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from "class-validator";
import { AvailabilityBlockType, ProficiencyLevel } from "@prisma/client";

class TechnicianCapabilityDto {
  @IsUUID()
  serviceCategoryId!: string;

  @IsEnum(ProficiencyLevel)
  proficiency!: ProficiencyLevel;

  @IsBoolean()
  isEnabled!: boolean;
}

class AvailabilityBlockDto {
  @IsEnum(AvailabilityBlockType)
  type!: AvailabilityBlockType;

  @IsDateString()
  startAt!: string;

  @IsDateString()
  endAt!: string;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  reason?: string;
}

export class ConfigureTechnicianRoutingDto {
  @IsBoolean()
  isAvailable!: boolean;

  @IsBoolean()
  isOnCall!: boolean;

  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => TechnicianCapabilityDto)
  capabilities!: TechnicianCapabilityDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => AvailabilityBlockDto)
  availabilityBlock?: AvailabilityBlockDto;
}
