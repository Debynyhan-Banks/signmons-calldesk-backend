import { Module } from "@nestjs/common";
import { TENANTS_SERVICE } from "./tenants.constants";
import { PrismaTenantsService } from "./tenants.service";
import { TenantsController } from "./tenants.controller";
import { SanitizationModule } from "../sanitization/sanitization.module";
import { AdminApiGuard } from "../common/guards/admin-api.guard";
import { AuthModule } from "../auth/auth.module";
import { OrganizationProfileController } from "./organization-profile.controller";
import { OrganizationProfileService } from "./organization-profile.service";

@Module({
  imports: [SanitizationModule, AuthModule],
  controllers: [TenantsController, OrganizationProfileController],
  providers: [
    OrganizationProfileService,
    PrismaTenantsService,
    AdminApiGuard,
    {
      provide: TENANTS_SERVICE,
      useExisting: PrismaTenantsService,
    },
  ],
  exports: [TENANTS_SERVICE],
})
export class TenantsModule {}
