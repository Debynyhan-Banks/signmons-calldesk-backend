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
  @IsIn(["view", "availability", "reschedule", "cancel"])
  action!: "view" | "availability" | "reschedule" | "cancel";

  @IsOptional()
  @IsString()
  @MinLength(20)
  @MaxLength(2048)
  slotToken?: string;
}
