/* eslint-disable @typescript-eslint/require-await -- Synthetic transaction/provider ports, no network. */
import { randomUUID } from "node:crypto";
import { GoogleCorrectionSequence } from "./google-correction-sequence";
import { Prisma } from "@prisma/client";
import {
  ControlledIntakeVerificationService,
  ControlledIntakeSubmission,
} from "./controlled-intake-verification.service";
import { ControlledIntakeAuthority } from "./controlled-intake-authority";
import { CustomerConsentCredentials } from "./customer-consent-credentials";
import { AddressOperationLedger } from "./address-operation-ledger";
import { PrismaService } from "../prisma/prisma.service";

describe("request-local controlled verification connection", () => {
  const tenantId = randomUUID(),
    sessionId = randomUUID(),
    conversationId = randomUUID(),
    category = randomUUID();
  const now = Date.now(),
    approval = new Date(now - 1000).toISOString();
  const input = { sessionToken: "private-token", requestId: randomUUID() };
  let submission: ControlledIntakeSubmission,
    clock: number,
    inTx: boolean,
    enabled: boolean;
  let readPhone: jest.Mock,
    validate: jest.Mock,
    complete: jest.Mock,
    checkObservation: jest.Mock;
  let service: ControlledIntakeVerificationService,
    tx: Prisma.TransactionClient;
  let consumer: jest.Mock;
  let claim: Record<string, unknown>;
  const response = () => ({
    status: "RESPONSE",
    body: {
      responseId: "11111111-1111-4111-8111-111111111111",
      result: {
        verdict: { addressComplete: true, validationGranularity: "PREMISE" },
        geocode: { location: { latitude: 41.1, longitude: -81.1 } },
        address: {
          postalAddress: {
            regionCode: "US",
            administrativeArea: "OH",
            locality: "Example",
            postalCode: "44101",
            addressLines: ["123 Fictional Street"],
          },
          addressComponents: Object.entries({
            street_number: "123",
            route: "Fictional Street",
            locality: "Example",
            administrative_area_level_1: "Ohio",
            postal_code: "44101",
            country: "United States",
          }).map(([componentType, text]) => ({
            componentType,
            componentName: { text },
            confirmationLevel: "CONFIRMED",
          })),
        },
        uspsData: {
          dpvConfirmation: "Y",
          dpvCmra: "N",
          addressRecordType: "H",
          fipsCountyCode: "035",
          county: "Cuyahoga",
        },
        metadata: { poBox: false },
      },
    },
  });
  beforeEach(() => {
    clock = now;
    inTx = false;
    enabled = true;
    jest.spyOn(Date, "now").mockImplementation(() => clock);
    submission = {
      intentId: randomUUID(),
      revision: 1,
      submissionDigest: "d".repeat(64),
      policyVersion: "v1",
      organizationApprovedAt: approval,
      phone: "+12025550123",
      address: {
        street: "123 Fictional Street",
        unit: "",
        city: "Example",
        postalCode: "44101",
      },
      authorityScope: {
        tenantId,
        integrationId: "intake",
        origin: "https://example.invalid",
        serviceCategoryId: category,
      },
    };
    const authority = new ControlledIntakeAuthority(
      () => ({
        version: 1,
        enabled,
        tenantId,
        integrationId: "intake",
        origin: "https://example.invalid",
        policyVersion: "v1",
        organizationApprovedAt: approval,
        paymentApprovedAt: approval,
        organizationDigest: "a".repeat(64),
        paymentDigest: "b".repeat(64),
        allowedServiceCategoryIds: [category],
        priorityPolicy: "AUTO_INTAKE_STANDARD_V1",
        validFrom: approval,
        validUntil: new Date(now + 60000).toISOString(),
        packetId: category,
      }),
      async () => ({
        tenantId,
        tenantActive: true,
        serviceCategoryId: category,
        categoryActive: true,
        organizationApprovedAt: approval,
        paymentApprovedAt: approval,
        organizationDigest: "a".repeat(64),
        paymentDigest: "b".repeat(64),
        nowMs: clock,
      }),
    );
    tx = {
      $queryRaw: async (q: { strings: string[] }) => {
        if (q.strings.join("").includes("SELECT c.status"))
          return [{ sessionId, marker: 1, status: "ONGOING" }];
        if (q.strings.join("").includes("AS ms"))
          return [{ ms: BigInt(clock) }];
        return [{ id: tenantId }];
      },
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
    claim = {
      priorSessionOperations: 0,
      claimed: true,
      attemptId: randomUUID(),
      operationId: randomUUID(),
      executionDeadline: now + 8000,
      intentId: submission.intentId,
      revision: 1,
      policyHash: "c".repeat(64),
      fixtureOnly: false,
    };
    complete = jest.fn(async () => ({ completed: true, state: "OBSERVED" }));
    checkObservation = jest.fn(async () => {});
    readPhone = jest.fn(async () => ({
      checkedAt: now,
      expiresAt: now + 60000,
    }));
    validate = jest.fn(async () => {
      expect(inTx).toBe(false);
      return response();
    });
    const credentials = {
      verifySession: (token: string) => {
        if (token !== input.sessionToken) throw Error("token");
        return { tenantId, sessionId, conversationId, expiresAt: now + 60000 };
      },
    } as CustomerConsentCredentials;
    const ledger = {
      executeControlled: async () => ({ ...claim }),
      completeControlled: complete,
      checkControlledObservation: checkObservation,
    } as unknown as AddressOperationLedger;
    service = new ControlledIntakeVerificationService({
      corrections: new GoogleCorrectionSequence(),
      prisma,
      credentials,
      authority,
      capability: authority.issue(),
      phone: { readControlledCurrent: readPhone },
      ledger,
      transport: { validate },
      readSubmission: async () => submission,
    });
    consumer = jest.fn(
      async (check: (tx: Prisma.TransactionClient) => Promise<void>) => {
        await prisma.$transaction(check);
        return { internalTest: "checked", jobCreated: false };
      },
    );
  });
  afterEach(() => jest.restoreAllMocks());
  it("defaults disabled and rejects expanded client input", async () => {
    await expect(
      new ControlledIntakeVerificationService().run(input, consumer),
    ).rejects.toThrow();
    await expect(
      service.run({ ...input, proof: true } as typeof input, consumer),
    ).rejects.toThrow();
    expect(validate).not.toHaveBeenCalled();
    submission.address.street = "";
    await expect(service.run(input, consumer)).rejects.toThrow();
    expect(validate).not.toHaveBeenCalled();
  });
  it("rechecks current phone and transaction observation, with no provider payload escape", async () => {
    const result = await service.run(input, consumer);
    expect(result).toEqual({
      status: "CONSUMED",
      value: { internalTest: "checked", jobCreated: false },
    });
    expect(readPhone).toHaveBeenCalledTimes(2);
    expect(checkObservation).toHaveBeenCalledTimes(1);
    expect(validate).toHaveBeenCalledTimes(1);
    const serialized = JSON.stringify([
      result,
      complete.mock.calls,
      checkObservation.mock.calls,
    ]);
    for (const forbidden of [
      response().body.responseId,
      "Cuyahoga",
      "fipsCountyCode",
      "latitude",
      "Fictional Street",
    ])
      expect(serialized).not.toContain(forbidden);
  });
  it("missing phone proof refuses before any address dispatch", async () => {
    readPhone.mockResolvedValue(null);
    await expect(service.run(input, consumer)).rejects.toThrow();
    expect(validate).not.toHaveBeenCalled();
  });
  it.each(["revision", "policyVersion", "submissionDigest", "phone"] as const)(
    "changed %s during I/O refuses final consumption",
    async (key) => {
      validate.mockImplementation(async () => {
        submission = {
          ...submission,
          [key]: key === "revision" ? 2 : "changed",
        };
        return response();
      });
      await expect(service.run(input, consumer)).rejects.toThrow();
      expect(validate).toHaveBeenCalledTimes(1);
    },
  );
  it("revocation during I/O refuses", async () => {
    validate.mockImplementation(async () => {
      enabled = false;
      return response();
    });
    await expect(service.run(input, consumer)).rejects.toThrow();
  });
  it("returns only an allowlisted temporary correction, never a job", async () => {
    validate.mockImplementation(async () => {
      const r = response();
      r.body.result.address.postalAddress.addressLines = [
        "125 Fictional Street",
      ];
      return r;
    });
    const result = await service.run(input, consumer);
    expect(result).toMatchObject({
      status: "CORRECTION_REQUIRED",
      jobCreated: false,
    });
    expect(JSON.stringify(result)).not.toContain(response().body.responseId);
    expect(consumer).not.toHaveBeenCalled();
    claim.priorSessionOperations = 1;
    submission.intentId = randomUUID();
    claim.intentId = submission.intentId;
    validate.mockImplementation(async () => response());
    await service.run({ ...input, requestId: randomUUID() }, consumer);
    expect((validate.mock.calls as unknown[][])[1][0]).toMatchObject({
      previousResponseId: "11111111-1111-4111-8111-111111111111",
    });
    expect((validate.mock.calls as unknown[][])[0][0]).not.toHaveProperty(
      "previousResponseId",
    );
    const calls = validate.mock.calls.length;
    expect(
      await service.run({ ...input, requestId: randomUUID() }, consumer),
    ).toMatchObject({ status: "REFUSED" });
    expect(validate).toHaveBeenCalledTimes(calls);
  });
  it("refuses a follow-up after cache loss without a provider call", async () => {
    claim.priorSessionOperations = 1;
    expect(await service.run(input, consumer)).toMatchObject({
      status: "REFUSED",
      jobCreated: false,
    });
    expect(validate).not.toHaveBeenCalled();
  });
  it("refuses malformed correction response IDs without leaking candidate data", async () => {
    validate.mockImplementation(async () => {
      const r = response();
      r.body.responseId = "invalid-provider-value";
      r.body.result.address.postalAddress.addressLines = [
        "125 Fictional Street",
      ];
      return r;
    });
    expect(await service.run(input, consumer)).toEqual({
      status: "REFUSED",
      jobCreated: false,
    });
    expect(consumer).not.toHaveBeenCalled();
  });
  it.each(["093", "999"])(
    "outside or unknown county %s refuses without exposing county",
    async (code) => {
      validate.mockImplementation(async () => {
        const r = response();
        r.body.result.uspsData.fipsCountyCode = code;
        r.body.result.uspsData.county = code === "093" ? "Lorain" : "unknown";
        return r;
      });
      expect(await service.run(input, consumer)).toEqual({
        status: "REFUSED",
        jobCreated: false,
      });
      expect(consumer).not.toHaveBeenCalled();
    },
  );
  it("timeout/late outcome stays uncertain and does not retry", async () => {
    validate.mockImplementation(async () => {
      clock = now + 8000;
      return response();
    });
    expect(await service.run(input, consumer)).toEqual({
      status: "UNCERTAIN",
      jobCreated: false,
    });
    expect(validate).toHaveBeenCalledTimes(1);
    expect(consumer).not.toHaveBeenCalled();
  });
  it("fixture claim and replayed claim do not dispatch", async () => {
    claim.fixtureOnly = true;
    expect(await service.run(input, consumer)).toMatchObject({
      status: "UNCERTAIN",
    });
    claim.claimed = false;
    expect(await service.run(input, consumer)).toMatchObject({
      status: "UNCERTAIN",
    });
    expect(validate).not.toHaveBeenCalled();
  });
  it("cannot use a captured check after return or consume it twice", async () => {
    let retained!: (tx: Prisma.TransactionClient) => Promise<void>;
    await service.run(input, async (check) => {
      retained = check;
      await check(tx);
      await expect(check(tx)).rejects.toThrow();
      return "done";
    });
    await expect(retained(tx)).rejects.toThrow();
  });
  it("post-write guard requires the checked transaction and remains request-local", async () => {
    let retained!: (tx: Prisma.TransactionClient) => Promise<void>;
    await service.run(input, async (check, finish) => {
      await expect(finish(tx)).rejects.toThrow();
      await check(tx);
      await expect(finish({} as Prisma.TransactionClient)).rejects.toThrow();
      await finish(tx);
      retained = finish;
    });
    await expect(retained(tx)).rejects.toThrow();
  });
  it.each(["deadline", "revocation"])(
    "post-write %s refuses before commit",
    async (kind) => {
      await expect(
        service.run(input, async (check, finish) => {
          await check(tx);
          if (kind === "deadline") clock = now + 8000;
          else enabled = false;
          await finish(tx);
        }),
      ).rejects.toThrow();
    },
  );
  it("a skipped or swallowed failed check cannot produce CONSUMED", async () => {
    await expect(service.run(input, async () => "unchecked")).rejects.toThrow();
    checkObservation.mockRejectedValue(Error("stale"));
    await expect(
      service.run(input, async (check) => {
        try {
          await check(tx);
        } catch {
          /* test hostile caller */
        }
        return "ignored";
      }),
    ).rejects.toThrow();
  });
});
