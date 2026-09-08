import { ExpressAdapter } from "@nestjs/platform-express";
import type { RawBodyRequest } from "@nestjs/common";
import type { Express, Request } from "express";
import { createServer, Server } from "node:http";
import { createRequire } from "node:module";
import qs from "qs";
import request from "supertest";

// Small, bounded fixtures for GHSA-4mjr-xmp4-gh2g and GHSA-x5fp-wj9c-mxmx.
// This proves installed dependency behavior, not exploitability of a real route.
describe("qs dependency security regression", () => {
  it.each(["express", "body-parser", "twilio", "superagent"])(
    "%s resolves the patched qs release",
    (consumer) => {
      const load = createRequire(require.resolve(consumer));
      const version = (load("qs/package.json") as { version: string }).version;
      const [major, minor] = version.split(".").map(Number);
      expect(major > 6 || (major === 6 && minor >= 16)).toBe(true);
    },
  );

  it.each([{ plainObjects: true }, { allowPrototypes: true }])(
    "round-trips hostile constructor fields without invoking them (%j)",
    (options) => {
      const parsed = qs.parse("x[constructor][isBuffer]=y", options);
      expect(() => qs.stringify(parsed)).not.toThrow();
      expect(qs.parse(qs.stringify(parsed), options)).toEqual(parsed);
    },
  );

  it.each(["a[]=1,2,3,4", "a=1,2,3,4"])(
    "enforces the configured comma-array limit for %s",
    (input) => {
      expect(() =>
        qs.parse(input, {
          comma: true,
          arrayLimit: 3,
          throwOnLimitExceeded: true,
        }),
      ).toThrow(RangeError);
    },
  );

  it("preserves ordinary form values, literal plus signs and Unicode", () => {
    const values = {
      From: "+12025550123",
      Body: "Fixture + café & heat",
      MessageSid: "SM_synthetic",
    };
    expect(qs.parse(qs.stringify(values))).toEqual(values);
  });
});

describe("Nest raw-body parser compatibility after qs upgrade", () => {
  let server: Server;
  beforeAll(async () => {
    const adapter = new ExpressAdapter();
    // Matches main.ts rawBody:true and Nest's extended URL-encoded parser.
    adapter.registerParserMiddleware("", true);
    const app = adapter.getInstance<Express>();
    app.post("/fixture", (req: RawBodyRequest<Request>, res) => {
      res.json({
        body: req.body as unknown,
        raw: req.rawBody?.toString("utf8"),
      });
    });
    server = createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("retains exact URL-encoded bytes and decoded synthetic callback fields", async () => {
    const raw =
      "From=%2B12025550123&Body=Fixture+%2B+caf%C3%A9&MessageSid=SM_synthetic";
    const response = await request(server)
      .post("/fixture")
      .set("Content-Type", "application/x-www-form-urlencoded")
      .send(raw)
      .expect(200);
    expect(response.body).toEqual({
      raw,
      body: {
        From: "+12025550123",
        Body: "Fixture + café",
        MessageSid: "SM_synthetic",
      },
    });
  });

  it("retains exact JSON bytes used by signed callback verification", async () => {
    const raw = '{ "id": "evt_synthetic", "data": { "value": 1 } }';
    const response = await request(server)
      .post("/fixture")
      .set("Content-Type", "application/json")
      .send(raw)
      .expect(200);
    expect(response.body).toEqual({ raw, body: JSON.parse(raw) as unknown });
  });

  it("keeps ordinary nested form parsing compatible", async () => {
    const response = await request(server)
      .post("/fixture")
      .set("Content-Type", "application/x-www-form-urlencoded")
      .send("fixture[name]=Synthetic&fixture[items][]=one&fixture[items][]=two")
      .expect(200);
    expect((response.body as { body: unknown }).body).toEqual({
      fixture: { name: "Synthetic", items: ["one", "two"] },
    });
  });
});
