/* eslint-disable @typescript-eslint/require-await -- In-memory transaction and SDK test ports. */
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { ConversationMemoryCipher } from "../logging/conversation-memory-cipher.service";
import { CustomerConsentCredentials } from "./customer-consent-credentials";
import { DurableVerificationService } from "./durable-verification.service";
import { TwilioVerifyAdapter } from "./twilio-verify.adapter";
import {
  ControlledPhonePolicy,
  createControlledPhoneProof,
  controlledPhoneProofCurrent,
} from "./controlled-phone-proof";
import {
  VERIFICATION_PROOF_MS,
  validFreshnessPolicy,
  VerificationFreshnessPolicy,
} from "./verification-freshness";

describe("controlled phone ledger provenance", () => {
  const tenantId = randomUUID(),
    sessionId = randomUUID(),
    conversationId = randomUUID();
  const phone = "+12025550123";
  const now = Date.now();
  const scope = {
    tenantId,
    sessionId,
    conversationId,
    expiresAt: now + 600000,
  };
  let stored: string | null, clock: number, active: boolean, inTx: boolean;
  let policy: ControlledPhonePolicy;
  let tx: Prisma.TransactionClient;
  let service: DurableVerificationService;
  let calls: number;
  const cipher = {
    encrypt: (s: string) => Buffer.from(s).toString("base64"),
    decrypt: (s: string) => Buffer.from(s, "base64").toString(),
  } as ConversationMemoryCipher;
  const credentials = {
    verifySession: (token: string) => {
      if (token !== "private-token") throw Error("invalid");
      return scope;
    },
  } as CustomerConsentCredentials;
  const input = (kind: "START" | "CHECK", startOperationId = "") => ({
    sessionToken: "private-token",
    operationId: randomUUID(),
    kind,
    phone,
    code: kind === "CHECK" ? "123456" : "",
    startOperationId,
  });
  const read = () =>
    service.readControlledCurrent(tx, {
      sessionToken: "private-token",
      phone,
      businessPolicyVersion: "organization-v1",
    });
  beforeEach(() => {
    stored = null;
    clock = now;
    active = true;
    inTx = false;
    calls = 0;
    policy = {
      mode: "CONTROLLED_VERIFY_V1",
      version: "v1",
      accountSid: "AC" + "a".repeat(32),
      serviceSid: "VA" + "b".repeat(32),
      noticeVersion: "notice-v1",
      businessPolicyVersion: "organization-v1",
      lifetimeMs: VERIFICATION_PROOF_MS,
    };
    tx = {
      $queryRaw: async (q: { strings: string[] }) => {
        const sql = q.strings.join("");
        if (sql.includes("AS value")) return [{ value: stored }];
        if (sql.includes("SELECT c.status"))
          return [
            { sessionId, marker: 1, status: active ? "ONGOING" : "CLOSED" },
          ];
        if (sql.includes("AS ms")) return [{ ms: BigInt(clock) }];
        return [{ id: tenantId }];
      },
      $executeRaw: async (q: { values: unknown[] }) => {
        stored = JSON.parse(q.values[0] as string) as string;
        return 1;
      },
      auditLog: { create: async () => ({}) },
    } as unknown as Prisma.TransactionClient;
    const prisma = {
      $transaction: async (
        fn: (tx: Prisma.TransactionClient) => Promise<unknown>,
      ) => {
        inTx = true;
        try {
          return await fn(tx);
        } finally {
          inTx = false;
        }
      },
    } as PrismaService;
    const adapter = new TwilioVerifyAdapter(
      {
        tenantId,
        accountSid: policy.accountSid,
        serviceSid: policy.serviceSid,
      },
      () => ({
        verify: {
          v2: {
            services: () => ({
              verifications: {
                create: async () => {
                  expect(inTx).toBe(false);
                  calls++;
                  return raw("pending");
                },
              },
              verificationChecks: {
                create: async () => {
                  expect(inTx).toBe(false);
                  calls++;
                  return raw("approved");
                },
              },
            }),
          },
        },
      }),
    );
    const raw = (status: string) => ({
      sid: "VE" + "c".repeat(32),
      accountSid: policy.accountSid,
      serviceSid: policy.serviceSid,
      to: phone,
      channel: "sms",
      status,
    });
    service = new DurableVerificationService(
      prisma,
      cipher,
      credentials,
      Buffer.alloc(32, 7),
      adapter,
      { lock: async () => {}, reserve: async () => {}, check: async () => {} },
      undefined,
      async () => policy,
    );
  });
  const verify = async () => {
    const start = input("START");
    await service.execute(start);
    const check = input("CHECK", start.operationId);
    await service.execute(check);
    return check;
  };
  it("creates current controlled proof only after durable matching CHECK; never in receipt", async () => {
    expect(await read()).toBeNull();
    const check = await verify();
    expect(await read()).toEqual({
      checkedAt: now,
      expiresAt: scope.expiresAt,
    });
    const before = stored;
    expect(await service.execute(check)).not.toHaveProperty("controlledProof");
    expect(stored).toBe(before);
    expect(calls).toBe(2);
  });
  it("old observed receipts cannot acquire proof on replay", async () => {
    const check = await verify();
    const ledger = JSON.parse(cipher.decrypt(stored!)!) as {
      entries: { controlledProof?: unknown }[];
    };
    for (const entry of ledger.entries) delete entry.controlledProof;
    stored = cipher.encrypt(JSON.stringify(ledger));
    await service.execute(check);
    expect(await read()).toBeNull();
    expect(calls).toBe(2);
  });
  it("explicit edit invalidation is sticky even after reverting phone", async () => {
    await verify();
    await service.freshness({
      sessionToken: "private-token",
      phone,
      revoke: true,
    });
    expect(await read()).toBeNull();
    expect(calls).toBe(2);
  });
  it.each([
    "version",
    "noticeVersion",
    "businessPolicyVersion",
    "accountSid",
    "serviceSid",
  ] as const)("policy/source change %s refuses", async (key) => {
    await verify();
    policy = { ...policy, [key]: policy[key] + "x" };
    expect(await read()).toBeNull();
  });
  it("expiry, wrong phone, closed session and foreign business policy refuse", async () => {
    await verify();
    expect(
      await service.readControlledCurrent(tx, {
        sessionToken: "private-token",
        phone: "+12025550124",
        businessPolicyVersion: "organization-v1",
      }),
    ).toBeNull();
    expect(
      await service.readControlledCurrent(tx, {
        sessionToken: "private-token",
        phone,
        businessPolicyVersion: "foreign",
      }),
    ).toBeNull();
    clock = scope.expiresAt;
    expect(await read()).toBeNull();
    active = false;
    await expect(read()).rejects.toThrow();
  });
  it("fixture validator does not accept controlled provenance", () => {
    expect(
      validFreshnessPolicy(policy as unknown as VerificationFreshnessPolicy),
    ).toBe(false);
    const s = {
      tenantId,
      sessionId,
      revision: "phone",
      expiresAt: now + VERIFICATION_PROOF_MS * 2,
    };
    const proof = createControlledPhoneProof(s, policy, now)!;
    expect(proof.expiresAt).toBe(now + VERIFICATION_PROOF_MS);
    expect(controlledPhoneProofCurrent(proof, s, policy, proof.expiresAt)).toBe(
      false,
    );
    expect(
      controlledPhoneProofCurrent(
        { ...proof, expiresAt: proof.expiresAt + 1 },
        s,
        policy,
        now,
      ),
    ).toBe(false);
  });
});
