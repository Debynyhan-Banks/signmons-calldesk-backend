import express from "express";
import { createServer, Server } from "node:http";
import { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { customerSessionHttp } from "./customer-session-http";
import { CustomerConsentBrowserTransport } from "./customer-consent-browser-transport";
import { CustomerConsentCredentials } from "./customer-consent-credentials";

describe("customer HTTP pre-parser mount", () => {
  let server: Server;
  afterEach(async () => {
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    }
  });
  const setup = async (mode: "disabled" | "fixture" | "direct" = "fixture") => {
    const app = express();
    server = createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const origin = mode === "direct" ? "https://customer.example.invalid" : url;
    const tenantId = randomUUID();
    const credentials = new CustomerConsentCredentials({
      activeKeyId: "test",
      keys: { test: Buffer.alloc(32, 7) },
    });
    const sessionToken = credentials.issueSession({
      tenantId,
      conversationId: randomUUID(),
      sessionId: randomUUID(),
    });
    const start = jest
      .fn()
      .mockResolvedValue({ sessionToken, deliveryAuthorized: false });
    const transport = new CustomerConsentBrowserTransport(
      { origin, tenantId, fixtureLoopback: mode !== "direct" },
      {
        credentials,
        responses: { start, prompt: jest.fn(), respond: jest.fn() },
        capture: { capture: jest.fn() },
        budget: { acquire: () => () => undefined },
      },
    );
    app.use(
      customerSessionHttp(
        mode === "disabled"
          ? undefined
          : { tenantId, integrationId: "test", transport },
      ),
    );
    // Deliberately after the customer mount: preserves exact bytes for webhooks.
    app.use(express.raw({ type: "application/json" }));
    app.post("/webhook-test", (req, res) =>
      res.type("application/octet-stream").send(req.body as Buffer),
    );
    const headers = {
      "Content-Type": "application/json",
      Origin: origin,
      Host: new URL(origin).host,
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Dest": "empty",
      "X-CallDesk-Request": "customer-intake-v1",
    };
    return { url, headers, start, sessionToken };
  };
  it("refuses the disabled namespace before default JSON parsing", async () => {
    const s = await setup("disabled");
    const response = await fetch(s.url + "/customer-session/submit", {
      method: "POST",
      headers: s.headers,
      body: "not JSON",
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(s.start).not.toHaveBeenCalled();
  });
  it("serves an explicitly configured loopback transport with server context", async () => {
    const s = await setup();
    const response = await fetch(s.url + "/customer-session/start", {
      method: "POST",
      headers: s.headers,
      body: "{}",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      sessionToken: s.sessionToken,
      expiresAt: expect.any(String),
      deliveryAuthorized: false,
    });
    expect(s.start).toHaveBeenCalledTimes(1);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
  it("does not turn forwarded headers into trusted TLS", async () => {
    const s = await setup("direct");
    const response = await fetch(s.url + "/customer-session/start", {
      method: "POST",
      headers: {
        ...s.headers,
        "X-Forwarded-Proto": "https",
        Forwarded: "proto=https",
      },
      body: "{}",
    });
    expect(response.status).toBe(403);
    expect(s.start).not.toHaveBeenCalled();
  });
  it("preserves unrelated webhook bytes without parsing or reserialization", async () => {
    const s = await setup();
    const raw = '{ "b":2, "a":1, "a":3 }\n';
    const response = await fetch(s.url + "/webhook-test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: raw,
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(raw);
  });
  it("refuses noncanonical JSON and wrong origin", async () => {
    const s = await setup();
    const a = await fetch(s.url + "/customer-session/start", {
      method: "POST",
      headers: s.headers,
      body: "{ }",
    });
    expect(a.status).toBe(400);
    const b = await fetch(s.url + "/customer-session/start", {
      method: "POST",
      headers: { ...s.headers, Origin: "https://foreign.invalid" },
      body: "{}",
    });
    expect(b.status).toBe(403);
    expect(s.start).not.toHaveBeenCalled();
  });
  it("mounts closed before CORS and preserves Nest rawBody", () => {
    const main = readFileSync("src/main.ts", "utf8");
    expect(main).toContain("rawBody: true");
    expect(main.indexOf("app.use(customerSessionHttp())")).toBeLessThan(
      main.indexOf("app.enableCors("),
    );
  });
});
