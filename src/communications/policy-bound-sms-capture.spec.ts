import { randomUUID } from "node:crypto";
import {
  requestContextMiddleware,
  setAuthContext,
} from "../common/context/request-context";
import { CustomerConsentCredentials } from "./customer-consent-credentials";
import { PolicyBoundSmsCapture } from "./policy-bound-sms-capture";

describe("PolicyBoundSmsCapture boundary", () => {
  const tenantId = randomUUID();
  const credentials = new CustomerConsentCredentials({
    activeKeyId: "fixture",
    keys: { fixture: Buffer.alloc(32, 6) },
  });
  const token = credentials.issueSession({
    tenantId,
    conversationId: randomUUID(),
    sessionId: randomUUID(),
  });
  const input = {
    sessionToken: token,
    action: "PROMPT",
    phone: "+12165550183",
    promptId: "",
    accepted: false,
  };
  const db = { $transaction: jest.fn() };
  const cipher = { encrypt: jest.fn(), decrypt: jest.fn() };
  const registry = { readForCapture: jest.fn() };
  const model = (version = "legacy-v1") =>
    new PolicyBoundSmsCapture(db, cipher, credentials, registry, {
      key: "fixture-key",
      version,
    });
  const actor = (
    fn: () => Promise<unknown>,
    id = tenantId,
    role = "webchat_integration",
  ) =>
    new Promise((resolve, reject) =>
      requestContextMiddleware({ headers: {} } as never, {} as never, () => {
        setAuthContext({ tenantId: id, userId: "fixture", role });
        void fn().then(resolve, reject);
      }),
    );
  beforeEach(() => jest.clearAllMocks());
  it.each([
    { liveCaptureEnabled: true },
    { policyVersion: "forged" },
    { tenantId },
    { action: "PROMPT", accepted: true },
    { action: "CAPTURE", promptId: "unknown" },
    { phone: "2165550183" },
    { sessionToken: "invalid" },
  ])(
    "refuses invalid or caller-authority input before transaction: %p",
    async (change) => {
      await expect(
        actor(() => model().handle({ ...input, ...change })),
      ).rejects.toThrow();
      expect(db.$transaction).not.toHaveBeenCalled();
    },
  );
  it("refuses cross-tenant and non-authorized roles before locking", async () => {
    await expect(
      actor(() => model().handle(input), randomUUID()),
    ).rejects.toThrow("access denied");
    await expect(
      actor(() => model().handle(input), tenantId, "technician"),
    ).rejects.toThrow("access denied");
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it("refuses missing hash version without a default or key rotation", async () => {
    await expect(actor(() => model("").handle(input))).rejects.toThrow(
      "key version",
    );
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it("maps unconfirmed transaction failures without exposing internals", async () => {
    db.$transaction.mockRejectedValue(new Error("database-secret-details"));
    await expect(actor(() => model().handle(input))).rejects.toThrow(
      "outcome unconfirmed",
    );
  });
});
