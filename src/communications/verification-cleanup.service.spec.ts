import { VerificationCleanupService } from "./verification-cleanup.service";
import { CustomerConsentCredentials } from "./customer-consent-credentials";
import { PrismaService } from "../prisma/prisma.service";
const tenantId = "11111111-1111-4111-8111-111111111111";
describe("controlled session cleanup scope", () => {
  it("copies the bound tenant and refuses foreign scope before database access", async () => {
    const query = jest.fn();
    const tx = { $queryRaw: query };
    const prisma = {
      $transaction: (fn: (v: unknown) => unknown) => Promise.resolve(fn(tx)),
    } as unknown as Pick<PrismaService, "$transaction">;
    const credentials = {
      verifySession: () => ({
        tenantId: "22222222-2222-4222-8222-222222222222",
        sessionId: tenantId,
        conversationId: tenantId,
      }),
    } as unknown as CustomerConsentCredentials;
    const mode = { mode: "CONTROLLED_SESSION_V1" as const, tenantId };
    const service = new VerificationCleanupService(prisma, credentials, mode);
    mode.tenantId = "22222222-2222-4222-8222-222222222222";
    await expect(service.end("synthetic")).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
  it("does not authorize a sweep or reference purge through controlled close mode", async () => {
    const transaction = jest.fn();
    const service = new VerificationCleanupService(
      { $transaction: transaction },
      {} as CustomerConsentCredentials,
      { mode: "CONTROLLED_SESSION_V1", tenantId },
    );
    await expect(service.sweep(tenantId)).rejects.toThrow();
    await expect(service.purgeResolvedReferences(tenantId)).rejects.toThrow();
    expect(transaction).not.toHaveBeenCalled();
  });
});
