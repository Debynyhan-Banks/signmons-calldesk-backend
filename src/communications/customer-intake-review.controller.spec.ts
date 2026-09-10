import { readFileSync } from "node:fs";
import { CustomerIntakeReviewController } from "./customer-intake-review.controller";
import { CustomerIntakeContinuationService } from "./customer-intake-continuation.service";
import { RequestAuthGuard } from "../auth/request-auth.guard";
import { TenantGuard } from "../common/guards/tenant.guard";
import { CustomerMessagingSettingsFilter } from "./customer-messaging-settings.filter";

describe("local-only operator review transport", () => {
  it("requires both identity and tenant guards with sanitized errors", () => {
    expect(
      Reflect.getMetadata("__guards__", CustomerIntakeReviewController),
    ).toEqual([RequestAuthGuard, TenantGuard]);
    expect(
      Reflect.getMetadata(
        "__exceptionFilters__",
        CustomerIntakeReviewController,
      ),
    ).toEqual([CustomerMessagingSettingsFilter]);
  });
  it("delegates exact inputs without inventing authority and keeps responses private", async () => {
    const service = {
      readReview: jest.fn().mockResolvedValue({ state: "PENDING_REVIEW" }),
      admitReview: jest.fn().mockResolvedValue({ state: "ADMITTED" }),
    };
    const controller = new CustomerIntakeReviewController(
      service as unknown as CustomerIntakeContinuationService,
    );
    const read = { requestId: "fixture" };
    const approve = {
      ...read,
      expectedOrganizationApprovedAt: "fixture",
      review: {},
    };
    await controller.read(read);
    await controller.approve(approve);
    expect(service.readReview).toHaveBeenCalledWith(read);
    expect(service.admitReview).toHaveBeenCalledWith(approve);
    for (const method of [controller.read, controller.approve])
      expect(Reflect.getMetadata("__headers__", method)).toContainEqual({
        name: "Cache-Control",
        value: "private, no-store",
      });
  });
  it("is absent from production composition", () => {
    for (const file of [
      "src/app.module.ts",
      "src/communications/communications.module.ts",
    ])
      expect(readFileSync(file, "utf8")).not.toContain(
        "CustomerIntakeReviewController",
      );
  });
});
