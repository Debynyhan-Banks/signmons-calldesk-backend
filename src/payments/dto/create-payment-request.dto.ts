import { IsDateString } from "class-validator";

export class CreatePaymentRequestDto {
  @IsDateString()
  expectedJobUpdatedAt!: string;
}
