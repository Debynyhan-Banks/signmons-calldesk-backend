import { IsBoolean, IsString, MaxLength, MinLength } from "class-validator";

export class ReplaySmsDto {
  @IsBoolean()
  acknowledgeDuplicateRisk!: boolean;

  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason!: string;
}
