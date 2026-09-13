import { ArgumentsHost, Catch } from "@nestjs/common";
import type { Response } from "express";
import { SanitizedExceptionFilter } from "../common/filters/sanitized-exception.filter";
import { LoggingService } from "../logging/logging.service";

@Catch()
export class CustomerMessagingSettingsFilter extends SanitizedExceptionFilter {
  constructor(logging: LoggingService) {
    super(logging);
  }
  catch(exception: unknown, host: ArgumentsHost) {
    host
      .switchToHttp()
      .getResponse<Response>()
      .setHeader("Cache-Control", "private, no-store");
    super.catch(exception, host);
  }
}
