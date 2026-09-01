import { IsInt, IsOptional, Max, Min } from "class-validator";

export class CreateTechnicianLinkDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(168)
  expiresInHours?: number;
}
