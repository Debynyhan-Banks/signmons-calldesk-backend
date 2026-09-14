import express from "express";
import { createServer, Server } from "node:http";
import { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { customerIntakePage } from "./customer-intake-page";

describe("same-origin intake asset boundary", () => {
  let server: Server;
  afterEach(async () => {
    server?.closeAllConnections();
    if (server?.listening)
      await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const setup = async (enabled = true) => {
    const app = express();
    app.use(
      customerIntakePage(
        enabled
          ? {
              html: readFileSync(
                "scripts/fixtures/customer-intake-journey.html",
                "utf8",
              ),
              script: readFileSync(
                "scripts/fixtures/customer-intake-journey.js",
                "utf8",
              ),
            }
          : undefined,
      ),
    );
    app.use((_req, res) => res.status(404).end());
    server = createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };
  it("serves only reviewed no-store assets with hash-authorized styles and no session", async () => {
    const origin = await setup();
    const response = await fetch(origin + "/customer-intake");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("content-security-policy")).toContain(
      "style-src 'sha256-",
    );
    expect(response.headers.get("content-security-policy")).not.toContain(
      "unsafe-inline",
    );
    const body = await response.text();
    expect(body).toContain('src="/customer-intake.js"');
    expect(body).toContain('data-controlled-intake="true"');
    const script = await fetch(origin + "/customer-intake.js");
    expect(script.headers.get("content-type")).toContain(
      "application/javascript",
    );
    expect(await script.text()).toBe(
      readFileSync("scripts/fixtures/customer-intake-journey.js", "utf8"),
    );
  });
  it("defaults closed and rejects non-GET or arbitrary file routing", async () => {
    let origin = await setup(false);
    expect((await fetch(origin + "/customer-intake")).status).toBe(503);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    origin = await setup();
    expect(
      (await fetch(origin + "/customer-intake", { method: "POST" })).status,
    ).toBe(405);
    for (const path of [
      "/customer-intake?token=x",
      "/journey.js",
      "/customer-intake/other",
      "/package.json",
    ])
      expect((await fetch(origin + path)).status).toBe(404);
  });
  it("Docker packages only the two reviewed assets", () => {
    const docker = readFileSync("Dockerfile", "utf8");
    expect(docker).toContain(
      "/app/scripts/fixtures/customer-intake-journey.html ./customer-intake/customer-intake-journey.html",
    );
    expect(docker).toContain(
      "/app/scripts/fixtures/customer-intake-journey.js ./customer-intake/customer-intake-journey.js",
    );
    expect(docker).not.toContain("/app/scripts ./scripts");
  });
});
