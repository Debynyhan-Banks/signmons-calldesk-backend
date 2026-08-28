import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { HealthService } from "./health.service";

@Controller("health")
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get("liveness")
  liveness() {
    return {
      status: "ok",
      timestamp: new Date().toISOString(),
    };
  }

  @Get("readiness")
  async readiness() {
    if (!(await this.healthService.isDatabaseReady())) {
      throw new ServiceUnavailableException("Database is unavailable.");
    }
    return {
      status: "ok",
      timestamp: new Date().toISOString(),
    };
  }
}
