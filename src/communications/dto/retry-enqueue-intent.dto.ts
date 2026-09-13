import { Equals, IsEnum, IsISO8601, Matches } from "class-validator";

import { EnqueueRetryReason } from "../sms-enqueue-intent-policy";

export class RetryEnqueueIntentDto {
  @Equals(true)
  acknowledgeRetry!: boolean;

  @IsEnum(EnqueueRetryReason)
  reasonCode!: EnqueueRetryReason;

  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  expectedUpdatedAt!: string;
}
