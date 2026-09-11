import {
  lifecycle,
  sessionCleanupDue,
  resolvedReferenceDue,
  RESOLVED_REFERENCE_RETENTION_MS,
} from "./verification-retention";
describe("1B verification retention policy", () => {
  const state = {
    version: 1 as const,
    expiresAt: 1000,
    closedAt: null,
    purgedAt: null,
  };
  it("closes at exact expiry and immediately on recorded closure", () => {
    expect(sessionCleanupDue(state, 999)).toBe(false);
    expect(sessionCleanupDue(state, 1000)).toBe(true);
    expect(sessionCleanupDue({ ...state, closedAt: 900 }, 900)).toBe(true);
    expect(sessionCleanupDue(state, NaN)).toBe(false);
  });
  it.each([
    null,
    {},
    { ...state, version: 2 },
    { ...state, expiresAt: "1000" },
    { ...state, closedAt: -1 },
    { ...state, extra: true },
  ])("refuses unknown lifecycle %j", (input) => {
    expect(lifecycle(input)).toBeNull();
  });
  it("copies lifecycle state", () => {
    const value = lifecycle(state)!;
    value.closedAt = 9;
    expect(state.closedAt).toBeNull();
  });
  it("waits full ninety days from supported resolution", () => {
    expect(
      resolvedReferenceDue(
        "CANCELLED",
        0n,
        null,
        1000,
        1000 + RESOLVED_REFERENCE_RETENTION_MS - 1,
      ),
    ).toBe(false);
    expect(
      resolvedReferenceDue(
        "CANCELLED",
        0n,
        null,
        1000,
        1000 + RESOLVED_REFERENCE_RETENTION_MS,
      ),
    ).toBe(true);
  });
  it.each(["RESERVED", "DISPATCH_CLAIMED", "OBSERVED", "UNCERTAIN"])(
    "never expires %s references as resolved",
    (state) => {
      expect(
        resolvedReferenceDue(
          state,
          0n,
          null,
          0,
          RESOLVED_REFERENCE_RETENTION_MS,
        ),
      ).toBe(false);
    },
  );
  it("retains any liability, claimed attempt or invalid resolution timestamp", () => {
    expect(
      resolvedReferenceDue(
        "CANCELLED",
        1n,
        null,
        0,
        RESOLVED_REFERENCE_RETENTION_MS,
      ),
    ).toBe(false);
    expect(
      resolvedReferenceDue(
        "CANCELLED",
        0n,
        "attempt",
        0,
        RESOLVED_REFERENCE_RETENTION_MS,
      ),
    ).toBe(false);
    expect(
      resolvedReferenceDue(
        "CANCELLED",
        0n,
        null,
        NaN,
        RESOLVED_REFERENCE_RETENTION_MS,
      ),
    ).toBe(false);
  });
});
