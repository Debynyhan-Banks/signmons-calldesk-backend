import { GoogleAddressAdapter } from "./google-address.adapter";
import {
  LocalAddressCorrection,
  type CorrectionScope,
} from "./local-address-correction";

describe("exact local address correction confirmation", () => {
  const input = {
    street: "123 Fictional St",
    city: "Example",
    postalCode: "44101",
    unit: "",
  };
  const response = {
    result: {
      verdict: {
        addressComplete: true,
        validationGranularity: "PREMISE",
        hasReplacedComponents: true,
      },
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
      uspsData: { dpvConfirmation: "Y" },
      geocode: { location: { latitude: 1, longitude: 2 } },
    },
    responseId: "private-provider-reference",
  };
  let scope: CorrectionScope | null;
  let now: number;
  let flow: LocalAddressCorrection;
  beforeEach(() => {
    now = 1000;
    scope = {
      tenantId: "tenant-a",
      sessionId: "session-a",
      revision: 1,
      expiresAt: 10000,
    };
    flow = new LocalAddressCorrection(
      new GoogleAddressAdapter(() => Promise.resolve(response)),
      () => scope,
      () => now,
    );
  });
  const accept = (preview: { candidateId?: string; revision?: number }) => ({
    candidateId: preview.candidateId,
    revision: preview.revision,
    confirmed: true,
  });
  it("presents exact corrected fields then records only explicit confirmation", async () => {
    const preview = await flow.propose(input);
    expect(preview.status).toBe("CONFIRMATION_REQUIRED");
    const receipt = flow.confirm(accept(preview));
    expect(receipt).toMatchObject({
      status: "CUSTOMER_CONFIRMED",
      customerAddress: { addressLines: ["123 Fictional Street"] },
      addressVerified: false,
      admissionAuthorized: false,
      county: "UNKNOWN",
    });
    expect(JSON.stringify(preview)).not.toMatch(
      /latitude|longitude|private-provider/,
    );
    expect(flow.confirm(accept(preview))).toEqual(receipt);
  });
  it.each(["tenantId", "sessionId", "revision", "expiresAt"])(
    "refuses changed %s",
    async (key) => {
      const preview = await flow.propose(input);
      scope = {
        ...scope!,
        [key]: key === "revision" ? 2 : key === "expiresAt" ? 12000 : "other",
      };
      expect(flow.confirm(accept(preview)).status).toBe("REFUSED");
    },
  );
  it("refuses at exact expiry and after session closure", async () => {
    const preview = await flow.propose(input);
    now = 10000;
    expect(flow.confirm(accept(preview)).status).toBe("REFUSED");
    scope = null;
    expect((await flow.propose(input)).status).toBe("REFUSED");
  });
  it("requires explicit boolean true and refuses payload replacement", async () => {
    const preview = await flow.propose(input);
    for (const confirmed of [false, "true", 1, null])
      expect(flow.confirm({ ...accept(preview), confirmed }).status).toBe(
        "REFUSED",
      );
    expect(
      flow.confirm({ ...accept(preview), address: "replacement" }).status,
    ).toBe("REFUSED");
    expect(
      flow.confirm({ ...accept(preview), candidateId: "other" }).status,
    ).toBe("REFUSED");
  });
  it("invalidates prior candidates on replacement or clear", async () => {
    const old = await flow.propose(input);
    await flow.propose(input);
    expect(flow.confirm(accept(old)).status).toBe("REFUSED");
    flow.clear();
    expect(flow.confirm(accept(old)).status).toBe("REFUSED");
  });
  it("copies presented and confirmed values so mutation cannot change stored intent", async () => {
    const preview = await flow.propose(input);
    if ("candidate" in preview) preview.candidate.addressLines[0] = "forged";
    const receipt = flow.confirm(accept(preview));
    if ("customerAddress" in receipt)
      receipt.customerAddress.addressLines[0] = "forged";
    expect(flow.confirm(accept(preview))).toMatchObject({
      customerAddress: { addressLines: ["123 Fictional Street"] },
    });
  });
  it("does not issue a candidate from a disabled or malformed provider", async () => {
    const disabled = new LocalAddressCorrection(
      new GoogleAddressAdapter(),
      () => scope,
      () => now,
    );
    expect((await disabled.propose(input)).status).toBe("REFUSED");
    expect((await flow.propose({})).status).toBe("REFUSED");
  });
  it("refuses scope edits during validation", async () => {
    const adapter = new GoogleAddressAdapter(() => {
      scope = { ...scope!, revision: 2 };
      return Promise.resolve(response);
    });
    expect(
      (
        await new LocalAddressCorrection(
          adapter,
          () => scope,
          () => now,
        ).propose(input)
      ).status,
    ).toBe("REFUSED");
  });
  it("does not resurrect an in-flight proposal after clear", async () => {
    let resolve!: (v: unknown) => void;
    const adapter = new GoogleAddressAdapter(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const local = new LocalAddressCorrection(
      adapter,
      () => scope,
      () => now,
    );
    const pending = local.propose(input);
    local.clear();
    resolve(response);
    expect((await pending).status).toBe("REFUSED");
  });
  it("refuses a lost-process candidate and caps review at 24 hours", async () => {
    scope!.expiresAt = now + 48 * 60 * 60 * 1000;
    const preview = await flow.propose(input);
    expect(preview).toMatchObject({ expiresAt: now + 24 * 60 * 60 * 1000 });
    const restarted = new LocalAddressCorrection(
      new GoogleAddressAdapter(),
      () => scope,
      () => now,
    );
    expect(restarted.confirm(accept(preview)).status).toBe("REFUSED");
  });
  it("clears the pending candidate on its timer without another customer action", async () => {
    jest.useFakeTimers();
    try {
      const preview = await flow.propose(input);
      jest.advanceTimersByTime(9000);
      expect(flow.confirm(accept(preview)).status).toBe("REFUSED");
    } finally {
      flow.clear();
      jest.useRealTimers();
    }
  });
});
