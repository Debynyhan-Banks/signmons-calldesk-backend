import { IsEnum, IsString, IsUUID, Length } from "class-validator";
import { TransactionalMessageTemplateKey } from "../transactional-message-template.service";

export class QueueTransactionalMessageDto {
  @IsUUID()
  jobId!: string;

  @IsEnum(TransactionalMessageTemplateKey)
  templateKey!: TransactionalMessageTemplateKey;

  @IsString()
  @Length(8, 200)
  idempotencyKey!: string;
}
