import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from "class-validator";

export class ManageAppointmentDto {
  @IsString()
  @MinLength(20)
  @MaxLength(2048)
  managementToken!: string;

  @IsString()
  @IsIn([
    "view",
    "confirm",
    "request_reschedule",
    "availability",
    "reschedule",
    "cancel",
  ])
  action!:
    | "view"
    | "confirm"
    | "request_reschedule"
    | "availability"
    | "reschedule"
    | "cancel";

  @IsOptional()
  @IsString()
  @MinLength(20)
  @MaxLength(2048)
  slotToken?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
