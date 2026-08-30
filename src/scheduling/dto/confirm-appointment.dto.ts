import { IsString, IsUUID, MaxLength, MinLength } from "class-validator";

export class ConfirmAppointmentDto {
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  sessionId!: string;

  @IsUUID()
  jobId!: string;

  @IsString()
  @MinLength(20)
  @MaxLength(2048)
  slotToken!: string;
}
