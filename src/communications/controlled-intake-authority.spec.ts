import { Prisma } from "@prisma/client";
import {
  ControlledIntakeAuthority,
  parseControlledIntakeActivation,
} from "./controlled-intake-authority";

const tenantId = "11111111-1111-4111-8111-111111111111";
const category = "22222222-2222-4222-8222-222222222222";
const approval = "2026-09-13T12:00:00.000Z";
const config = () => ({
  version: 1,
  enabled: true,
  tenantId,
  integrationId: "controlled-intake",
  origin: "https://staging.example.invalid",
  policyVersion: "v1",
  organizationApprovedAt: approval,
  organizationDigest: "a".repeat(64),
  paymentApprovedAt: approval,
  paymentDigest: "b".repeat(64),
  allowedServiceCategoryIds: [category],
  priorityPolicy: "AUTO_INTAKE_STANDARD_V1",
  validFrom: approval,
  validUntil: "2026-09-13T13:00:00.000Z",
  packetId: "33333333-3333-4333-8333-333333333333",
});
const scope = {
  tenantId,
  integrationId: "controlled-intake",
  origin: "https://staging.example.invalid",
  serviceCategoryId: category,
};
const state = () => ({
  tenantId,
  tenantActive: true,
  serviceCategoryId: category,
  categoryActive: true,
  organizationApprovedAt: approval,
  organizationDigest: "a".repeat(64),
  paymentApprovedAt: approval,
  paymentDigest: "b".repeat(64),
  nowMs: Date.parse(approval),
});
const tx = {} as Prisma.TransactionClient;

describe("controlled intake authority", () => {
  it("sanitizes a failed trusted-state read", async () => {
    const authority = new ControlledIntakeAuthority(config, () =>
      Promise.reject(new Error("private database detail")),
    );
    await expect(authority.check(authority.issue(), tx, scope)).rejects.toThrow(
      "Controlled intake authority unavailable.",
    );
  });
  it("defaults off and requires a trusted state reader", () => {
    expect(() => new ControlledIntakeAuthority().issue()).toThrow(
      "unavailable",
    );
    expect(() => new ControlledIntakeAuthority(config).issue()).toThrow(
      "unavailable",
    );
    expect(() =>
      new ControlledIntakeAuthority(
        () => ({ ...config(), enabled: false }),
        () => Promise.resolve(state()),
      ).issue(),
    ).toThrow("unavailable");
  });
  it.each([
    { extra: true },
    { version: 2 },
    { enabled: "true" },
    { tenantId: "staff" },
    { packetId: "packet" },
    { integrationId: "" },
    { policyVersion: "" },
    { organizationApprovedAt: "yesterday" },
    { paymentApprovedAt: null },
    { organizationDigest: "abc" },
    { paymentDigest: "ABC" },
    { validFrom: "2026-09-13" },
    { validUntil: approval },
    { priorityPolicy: "EMERGENCY" },
    { allowedServiceCategoryIds: [] },
    { allowedServiceCategoryIds: [category, category] },
    { allowedServiceCategoryIds: ["bad"] },
    { origin: "http://staging.example.invalid" },
    { origin: "https://staging.example.invalid/" },
    { origin: "https://staging.example.invalid?x=1" },
    { origin: "https://user@staging.example.invalid" },
  ])("rejects malformed configuration %j", (patch) => {
    expect(() =>
      parseControlledIntakeActivation({ ...config(), ...patch }),
    ).toThrow("unavailable");
  });
  it("rejects missing fields and non-record configuration", () => {
    for (const key of Object.keys(config())) {
      const input: Record<string, unknown> = config();
      delete input[key];
      expect(() => parseControlledIntakeActivation(input)).toThrow(
        "unavailable",
      );
    }
    for (const input of [null, [], "config", new Date()])
      expect(() => parseControlledIntakeActivation(input)).toThrow(
        "unavailable",
      );
  });
  it("copies and freezes configuration categories", () => {
    const input = config();
    const parsed = parseControlledIntakeActivation(input);
    input.allowedServiceCategoryIds.length = 0;
    expect(parsed.allowedServiceCategoryIds).toEqual([category]);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.allowedServiceCategoryIds)).toBe(true);
  });
  it("returns only deterministic actor metadata after fresh transaction checks", async () => {
    const read = jest.fn().mockResolvedValue(state());
    const authority = new ControlledIntakeAuthority(config, read);
    const capability = authority.issue();
    const result = await authority.check(capability, tx, scope);
    expect(result).toEqual({
      actorId: "signmons-intake-admission-v1",
      actorType: "SYSTEM_AI",
      decisionSource: "DETERMINISTIC_POLICY",
      policyVersion: "v1",
      priorityPolicy: "AUTO_INTAKE_STANDARD_V1",
      packetId: config().packetId,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(read).toHaveBeenCalledWith(tx, scope);
    await authority.check(capability, tx, scope);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("refuses forged, serialized and different-instance capabilities before reads", async () => {
    const read = jest.fn().mockResolvedValue(state());
    const authority = new ControlledIntakeAuthority(config, read);
    const other = new ControlledIntakeAuthority(config, read);
    for (const capability of [
      null,
      "SYSTEM_AI",
      {},
      { ...authority.issue() },
      other.issue(),
    ]) {
      await expect(authority.check(capability, tx, scope)).rejects.toThrow(
        "unavailable",
      );
    }
    expect(read).not.toHaveBeenCalled();
  });
  it.each([
    { tenantId: category },
    { integrationId: "other" },
    { origin: "https://other.invalid" },
    { serviceCategoryId: tenantId },
  ])("refuses scope mismatch %j", async (patch) => {
    const read = jest.fn().mockResolvedValue(state());
    const authority = new ControlledIntakeAuthority(config, read);
    await expect(
      authority.check(authority.issue(), tx, { ...scope, ...patch }),
    ).rejects.toThrow("unavailable");
    expect(read).not.toHaveBeenCalled();
  });
  it.each([
    { tenantId: category },
    { tenantActive: false },
    { serviceCategoryId: tenantId },
    { categoryActive: false },
    { organizationApprovedAt: "2026-09-13T11:00:00.000Z" },
    { organizationDigest: "c".repeat(64) },
    { paymentApprovedAt: "2026-09-13T11:00:00.000Z" },
    { paymentDigest: "c".repeat(64) },
    { nowMs: NaN },
    { nowMs: Infinity },
    { nowMs: Date.parse(approval) - 1 },
    { nowMs: Date.parse(config().validUntil) },
  ])("refuses stale or ineligible transaction state %j", async (patch) => {
    const authority = new ControlledIntakeAuthority(config, () =>
      Promise.resolve({
        ...state(),
        ...patch,
      }),
    );
    await expect(authority.check(authority.issue(), tx, scope)).rejects.toThrow(
      "unavailable",
    );
  });
  it("refuses absent current state", async () => {
    const authority = new ControlledIntakeAuthority(config, () =>
      Promise.resolve(null),
    );
    await expect(authority.check(authority.issue(), tx, scope)).rejects.toThrow(
      "unavailable",
    );
  });
  it("revocation or policy change invalidates an issued capability", async () => {
    for (const patch of [{ enabled: false }, { policyVersion: "v2" }]) {
      let activation = config();
      const authority = new ControlledIntakeAuthority(
        () => activation,
        () => Promise.resolve(state()),
      );
      const capability = authority.issue();
      activation = { ...activation, ...patch };
      await expect(authority.check(capability, tx, scope)).rejects.toThrow(
        "unavailable",
      );
    }
  });
  it("revocation during the asynchronous state read wins", async () => {
    const activation = config();
    const authority = new ControlledIntakeAuthority(
      () => activation,
      async () => {
        await Promise.resolve();
        activation.enabled = false;
        return state();
      },
    );
    await expect(authority.check(authority.issue(), tx, scope)).rejects.toThrow(
      "unavailable",
    );
  });
  it("does not let matching future approval dates authorize the present", async () => {
    const future = "2026-09-13T12:30:00.000Z";
    const authority = new ControlledIntakeAuthority(
      () => ({ ...config(), organizationApprovedAt: future }),
      () => Promise.resolve({ ...state(), organizationApprovedAt: future }),
    );
    await expect(authority.check(authority.issue(), tx, scope)).rejects.toThrow(
      "unavailable",
    );
  });
});
