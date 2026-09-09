import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  requestContextMiddleware,
  setAuthContext,
} from "../common/context/request-context";
import { CustomerConsentResponseService } from "./customer-consent-response.service";
import { CustomerConsentCredentials } from "./customer-consent-credentials";
describe("inactive customer consent response boundary", () => {
  const credentials = new CustomerConsentCredentials({
    activeKeyId: "fixture",
    keys: { fixture: Buffer.alloc(32, 5) },
  });
  const scope = {
    tenantId: randomUUID(),
    conversationId: randomUUID(),
    sessionId: randomUUID(),
  };
  const token = () => credentials.issueSession(scope);
  const transaction = jest.fn(),
    record = jest.fn();
  const prisma = {
    $transaction: transaction,
  } as unknown as ConstructorParameters<
    typeof CustomerConsentResponseService
  >[0];
  const service = () =>
    new CustomerConsentResponseService(
      prisma,
      { decrypt: () => null },
      credentials,
      { record },
    );
  const asActor = (
    role: string,
    fn: () => Promise<unknown>,
    impersonation?: string,
  ) =>
    new Promise((resolve, reject) => {
      requestContextMiddleware(
        { headers: {} } as Parameters<typeof requestContextMiddleware>[0],
        {} as Parameters<typeof requestContextMiddleware>[1],
        () => {
          setAuthContext(
            { tenantId: scope.tenantId, userId: "integration:fixture", role },
            impersonation,
          );
          fn().then(resolve, reject);
        },
      );
    });
  beforeEach(() => {
    transaction.mockReset();
    record.mockReset();
  });
  it("requires integration context for bootstrap", async () => {
    await expect(service().start()).rejects.toThrow("verified webchat");
    expect(transaction).not.toHaveBeenCalled();
  });
  it.each(["owner", "admin", "customer", "technician"])(
    "refuses %s bootstrap",
    async (role) => {
      await expect(asActor(role, () => service().start())).rejects.toThrow(
        "verified webchat",
      );
      expect(transaction).not.toHaveBeenCalled();
    },
  );
  it("refuses impersonation and unconfigured keys before any bootstrap write", async () => {
    await expect(
      asActor("webchat_integration", () => service().start(), scope.tenantId),
    ).rejects.toThrow();
    const disabled = new CustomerConsentResponseService(
      prisma,
      { decrypt: () => null },
      new CustomerConsentCredentials(),
      { record },
    );
    await expect(
      asActor("webchat_integration", () => disabled.start()),
    ).rejects.toThrow("unavailable");
    expect(transaction).not.toHaveBeenCalled();
  });
  it.each([
    {},
    { sessionId: "arbitrary" },
    { sessionToken: "integration-key" },
    { sessionToken: "bad", tenantId: "override" },
  ])("refuses invalid prompt input %#", async (input) => {
    await expect(
      service().prompt(input as { sessionToken: string }),
    ).rejects.toThrow();
    expect(transaction).not.toHaveBeenCalled();
  });
  it.each(["yes", "REVOKED", "", "true"])(
    "refuses unbound response %s",
    async (response) => {
      await expect(
        service().respond({
          sessionToken: token(),
          promptToken: "invalid",
          mailboxConfirmed: false,
          response,
        }),
      ).rejects.toThrow();
      expect(transaction).not.toHaveBeenCalled();
    },
  );
  it("requires separate mailbox confirmation before accepting a grant", async () => {
    const sessionToken = token(),
      promptToken = credentials.issuePrompt(sessionToken, "a".repeat(64), 0);
    await expect(
      service().respond({
        sessionToken,
        promptToken,
        response: "GRANTED",
        mailboxConfirmed: false,
      }),
    ).rejects.toThrow("explicit");
    expect(transaction).not.toHaveBeenCalled();
  });
  it("rejects a prompt belonging to another session before database access", async () => {
    const a = token(),
      b = token(),
      prompt = credentials.issuePrompt(a, "a".repeat(64), 0);
    await expect(
      service().respond({
        sessionToken: b,
        promptToken: prompt,
        response: "GRANTED",
        mailboxConfirmed: true,
      }),
    ).rejects.toThrow("invalid");
    expect(transaction).not.toHaveBeenCalled();
  });
  it("sanitizes bootstrap, prompt and response persistence failures", async () => {
    transaction.mockRejectedValue(
      new Error("PRIVATE_TOKEN PRIVATE_MAILBOX database detail"),
    );
    await expect(
      asActor("webchat_integration", () => service().start()),
    ).rejects.toThrow("outcome is unconfirmed");
    const sessionToken = token(),
      promptToken = credentials.issuePrompt(sessionToken, "a".repeat(64), 0);
    await expect(service().prompt({ sessionToken })).rejects.toThrow(
      "outcome is unconfirmed",
    );
    await expect(
      service().respond({
        sessionToken,
        promptToken,
        response: "GRANTED",
        mailboxConfirmed: true,
      }),
    ).rejects.toThrow("outcome is unconfirmed");
  });
  it("stays unregistered in both communications and webchat", () => {
    for (const file of [
      "communications.module.ts",
      "../integrations/webchat/webchat.module.ts",
    ]) {
      expect(readFileSync(join(__dirname, file), "utf8")).not.toContain(
        "CustomerConsent",
      );
    }
  });
  it("enforces bounded transaction settings on prompt reads", async () => {
    transaction.mockImplementation(
      async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
        await fn({
          $queryRaw: () => Promise.resolve([]),
        } as unknown as Prisma.TransactionClient);
      },
    );
    await expect(service().prompt({ sessionToken: token() })).rejects.toThrow(
      "unavailable",
    );
    expect((transaction.mock.calls as unknown[][])[0][1]).toEqual({
      maxWait: 2000,
      timeout: 5000,
    });
  });
});
