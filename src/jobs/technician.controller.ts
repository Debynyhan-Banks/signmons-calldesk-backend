import { randomUUID } from "crypto";
import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { UpdateTechnicianJobDto } from "./dto/update-technician-job.dto";
import { TechnicianWorkflowService } from "./technician-workflow.service";

@Controller("technician")
export class TechnicianController {
  constructor(private readonly workflow: TechnicianWorkflowService) {}

  @Get("jobs")
  @Header("Cache-Control", "private, no-store")
  @Throttle({ default: { limit: 60, ttl: 60 } })
  list(@Headers("x-technician-link") link: string | undefined) {
    return this.workflow.list(link);
  }

  @Get("jobs/:jobId")
  @Header("Cache-Control", "private, no-store")
  @Throttle({ default: { limit: 60, ttl: 60 } })
  get(
    @Headers("x-technician-link") link: string | undefined,
    @Param("jobId", new ParseUUIDPipe()) jobId: string,
  ) {
    return this.workflow.get(link, jobId);
  }

  @Post("jobs/:jobId/status")
  @HttpCode(200)
  @Header("Cache-Control", "private, no-store")
  @Throttle({ default: { limit: 30, ttl: 60 } })
  update(
    @Headers("x-technician-link") link: string | undefined,
    @Param("jobId", new ParseUUIDPipe()) jobId: string,
    @Body() body: UpdateTechnicianJobDto,
  ) {
    return this.workflow.update({
      rawToken: link,
      jobId,
      action: body.action,
      expectedUpdatedAt: body.expectedUpdatedAt,
      note: body.note,
      traceId: randomUUID(),
    });
  }
}
