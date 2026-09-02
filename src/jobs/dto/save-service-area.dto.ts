import { Transform } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsPostalCode,
  IsString,
  MaxLength,
} from "class-validator";
import { ServiceAreaStatus } from "@prisma/client";

const clean = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim() : value;

export class SaveServiceAreaDto {
  @Transform(clean)
  @IsString()
  @MaxLength(120)
  name!: string;

  @IsEnum(ServiceAreaStatus)
  status!: ServiceAreaStatus;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(250)
  @IsPostalCode("US", { each: true })
  postalCodes!: string[];
}
