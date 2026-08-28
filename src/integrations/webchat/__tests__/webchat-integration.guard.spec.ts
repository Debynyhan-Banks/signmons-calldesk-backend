import { createHash } from "node:crypto";
import type { ExecutionContext } from "@nestjs/common";
import { UnauthorizedException } from "@nestjs/common";
import { WebchatIntegrationGuard } from "../webchat-integration.guard";

describe("WebchatIntegrationGuard", () => {
  const secret = "test-integration-secret-at-least-24-characters";
  const keyHash = createHash("sha256").update(secret).digest("hex");
  const config = {
    webchatIntegrations: [
      {
        name: "eternity",
        tenantId: "8cf1e75e-14e7-4d4f-afd1-b4416a832ba1",
        keyHash,
      },
    ],
  } as never;

  const context = (authorization?: string) =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({
          header: (name: string) =>
            name.toLowerCase() === "authorization" ? authorization : undefined,
        }),
      }),
    }) as unknown as ExecutionContext;

  it("accepts the configured server-held credential", () => {
    const guard = new WebchatIntegrationGuard(config);
    expect(guard.canActivate(context(`Bearer ${secret}`))).toBe(true);
  });

  it("rejects missing and invalid credentials", () => {
    const guard = new WebchatIntegrationGuard(config);
    expect(() => guard.canActivate(context())).toThrow(UnauthorizedException);
    expect(() =>
      guard.canActivate(
        context("Bearer wrong-secret-that-is-long-enough-for-validation"),
      ),
    ).toThrow(UnauthorizedException);
  });
});
