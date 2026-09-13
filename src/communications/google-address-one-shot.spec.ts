import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GoogleAddressOneShot,
  InspectionApproval,
} from "./google-address-one-shot";
import { GoogleAddressRequest } from "./google-address.adapter";

describe("one-shot inspection runner", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "signmons-one-shot-test-"));
  });
  afterEach(() => {
    jest.useRealTimers();
    rmSync(dir, { recursive: true });
  });
  const approval = (): InspectionApproval => ({
    approved: true,
    project: "signmons",
    packetId: "fixture-one",
    rateVersion: "fixture-rate",
    startsAt: 100,
    expiresAt: 1000,
    liabilityMicros: 100000,
    requestLimit: 1,
  });
  const input: GoogleAddressRequest = {
    address: {
      regionCode: "US",
      administrativeArea: "OH",
      locality: "Fictional",
      postalCode: "44101",
      addressLines: ["123 Fictional Street"],
    },
    enableUspsCass: true,
  };
  const transport = () => ({
    validate: jest.fn().mockResolvedValue({
      status: "RESPONSE",
      body: { secret: "MUST-NOT-ESCAPE" },
    }),
  });
  it("is disabled without configuration", async () => {
    expect((await new GoogleAddressOneShot().run(input)).status).toBe(
      "DISABLED",
    );
  });
  it("claims once before dispatch, strips body and retains liability", async () => {
    const t = transport();
    t.validate.mockImplementation(() => {
      expect(readdirSync(dir)).toEqual(["fixture-one.held"]);
      return Promise.resolve({
        status: "RESPONSE",
        body: { secret: "MUST-NOT-ESCAPE" },
      });
    });
    const runner = () =>
      new GoogleAddressOneShot({
        approval: approval(),
        claimDirectory: dir,
        transport: t,
        now: () => 200,
      });
    const results = await Promise.all([
      runner().run(input),
      runner().run(input),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      "OBSERVED",
      "REFUSED",
    ]);
    expect(t.validate).toHaveBeenCalledTimes(1);
    expect((await runner().run(input)).status).toBe("REFUSED");
    expect(JSON.stringify(results)).not.toContain("MUST-NOT-ESCAPE");
    const held = readFileSync(join(dir, "fixture-one.held"), "utf8");
    expect(held).not.toContain("Fictional");
    expect(JSON.parse(held)).toMatchObject({
      liabilityMicros: 100000,
      requests: 1,
    });
    expect(results[0]).toMatchObject({
      admissionAuthorized: false,
      bookingAuthorized: false,
      deliveryAuthorized: false,
    });
  });
  it.each([
    { approved: false },
    { project: "other" },
    { packetId: "../escape" },
    { rateVersion: "" },
    { requestLimit: 2 },
    { liabilityMicros: 0 },
    { liabilityMicros: 100001 },
    { startsAt: 201 },
    { expiresAt: 200 },
    { expiresAt: 9999999 },
    { startsAt: NaN },
  ])("refuses invalid approval %j", async (patch) => {
    const t = transport();
    const r = new GoogleAddressOneShot({
      approval: { ...approval(), ...patch } as InspectionApproval,
      claimDirectory: dir,
      transport: t,
      now: () => 200,
    });
    expect((await r.run(input)).status).toBe("REFUSED");
    expect(t.validate).not.toHaveBeenCalled();
    expect(readdirSync(dir)).toEqual([]);
  });
  it("retains uncertain failure and never retries", async () => {
    const t = transport();
    t.validate.mockRejectedValue(Error("private provider error"));
    const r = new GoogleAddressOneShot({
      approval: approval(),
      claimDirectory: dir,
      transport: t,
      now: () => 200,
    });
    expect((await r.run(input)).status).toBe("UNCERTAIN");
    expect((await r.run(input)).status).toBe("REFUSED");
    expect(t.validate).toHaveBeenCalledTimes(1);
  });
  it("aborts timeout, keeps hold and suppresses late results", async () => {
    jest.useFakeTimers();
    const t = transport();
    t.validate.mockReturnValue(new Promise(() => undefined));
    const r = new GoogleAddressOneShot({
      approval: approval(),
      claimDirectory: dir,
      transport: t,
      now: () => 200,
    });
    const pending = r.run(input);
    await jest.advanceTimersByTimeAsync(800);
    expect((await pending).status).toBe("UNCERTAIN");
    const calls = t.validate.mock.calls as [
      GoogleAddressRequest,
      AbortSignal,
    ][];
    expect(calls[0][1].aborted).toBe(true);
    expect(readdirSync(dir)).toHaveLength(1);
  });
  it("refuses unavailable durable storage before dispatch", async () => {
    const t = transport();
    const r = new GoogleAddressOneShot({
      approval: approval(),
      claimDirectory: join(dir, "absent"),
      transport: t,
      now: () => 200,
    });
    expect((await r.run(input)).status).toBe("REFUSED");
    expect(t.validate).not.toHaveBeenCalled();
  });
  it("retains hold if clock moves backwards after reservation", async () => {
    const t = transport();
    const now = jest.fn().mockReturnValueOnce(200).mockReturnValue(199);
    const r = new GoogleAddressOneShot({
      approval: approval(),
      claimDirectory: dir,
      transport: t,
      now,
    });
    expect((await r.run(input)).status).toBe("UNCERTAIN");
    expect(t.validate).not.toHaveBeenCalled();
    expect(readdirSync(dir)).toHaveLength(1);
  });
});
