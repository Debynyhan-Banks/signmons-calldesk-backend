import { HttpException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  requestContextMiddleware,
  setAuthContext,
} from "../common/context/request-context";
import { CustomerConsentCredentials } from "./customer-consent-credentials";
import {
  CUSTOMER_BROWSER_HEADERS,
  CustomerConsentBrowserTransport,
  CustomerBrowserRequest,
  readCustomerBrowserBody,
} from "./customer-consent-browser-transport";

describe("inactive same-origin browser transport", () => {
  const tenantId = randomUUID(),
    origin = "https://customer.example.invalid";
  const credentials = new CustomerConsentCredentials({
    activeKeyId: "fixture",
    keys: { fixture: Buffer.alloc(32, 8) },
  });
  const sessionToken = credentials.issueSession({
    tenantId,
    conversationId: randomUUID(),
    sessionId: randomUUID(),
  });
  const start = jest.fn(),
    capture = jest.fn(),
    prompt = jest.fn(),
    respond = jest.fn(),
    acquire = jest.fn(),
    release = jest.fn(),
    diagnostic = jest.fn();
  const continuation = jest.fn();
  const ports = {
    responses: { start, prompt, respond },
    capture: { capture },
    credentials,
    budget: { acquire },
    diagnostic,
    continuation: { continue: continuation },
  };
  const model = () =>
    new CustomerConsentBrowserTransport({ origin, tenantId }, ports);
  const req = (op = "start", body: unknown = {}): CustomerBrowserRequest => ({
    method: "POST",
    url: "/customer-session/" + op,
    peerAddress: "127.0.0.1",
    encrypted: true,
    body: Buffer.from(JSON.stringify(body)),
    rawHeaders: [
      "Host",
      "customer.example.invalid",
      "Origin",
      origin,
      "Sec-Fetch-Site",
      "same-origin",
      "Sec-Fetch-Mode",
      "cors",
      "Sec-Fetch-Dest",
      "empty",
      "X-CallDesk-Request",
      "customer-intake-v1",
      "Content-Type",
      "application/json",
    ],
  });
  const asActor = <T>(
    fn: () => Promise<T>,
    role = "webchat_integration",
    tenant = tenantId,
    impersonated?: string,
  ): Promise<T> =>
    new Promise((resolve, reject) => {
      requestContextMiddleware(
        { headers: {} } as Parameters<typeof requestContextMiddleware>[0],
        {} as Parameters<typeof requestContextMiddleware>[1],
        () => {
          setAuthContext(
            { tenantId: tenant, userId: "integration:fixture", role },
            impersonated,
          );
          fn().then(resolve, reject);
        },
      );
    });
  const call = (request = req()) => asActor(() => model().handle(request));
  it("keeps verification unavailable outside the explicit loopback fixture", async () => {
    const handle = jest.fn();
    const transport = new CustomerConsentBrowserTransport(
      { origin, tenantId },
      { ...ports, verification: { handle } },
    );
    const input = {
      sessionToken,
      action: "NOTICE",
      operationId: "",
      phone: "",
      code: "",
      startOperationId: "",
      requested: false,
      noticeVersion: "",
    };
    expect(
      (await asActor(() => transport.handle(req("verify", input)))).status,
    ).toBe(503);
    expect(handle).not.toHaveBeenCalled();
  });
  function header(name: string, value?: string) {
    const request = req(),
      index = request.rawHeaders.findIndex((v) => v.toLowerCase() === name);
    if (index >= 0) request.rawHeaders.splice(index, 2);
    if (value !== undefined) request.rawHeaders.push(name, value);
    return request;
  }
  beforeEach(() => {
    jest.resetAllMocks();
    acquire.mockReturnValue(release);
    start.mockResolvedValue({
      sessionToken,
      expiresAt: "ignored",
      deliveryAuthorized: false,
      private: "DO_NOT_LEAK",
    });
    capture.mockResolvedValue({
      status: "captured",
      deliveryAuthorized: false,
      private: "DO_NOT_LEAK",
    });
    respond.mockResolvedValue({
      id: randomUUID(),
      scopeId: randomUUID(),
      revision: 1,
      deliveryAuthorized: false,
      private: "DO_NOT_LEAK",
    });
  });
  const draftDetails = {
    customerName: "Fictional",
    phone: "+12025550123",
    address: "123 Fictional Lane",
    description: "Cooling issue",
    issueCategory: "COOLING",
    propertyType: "RESIDENTIAL",
    serviceIntent: "REPAIR",
  };
  const draftInput = () => ({
    sessionToken,
    expectedRevision: 1,
    draft: draftDetails,
  });
  it("submits an explicit review request and projects only its pending receipt", async () => {
    const input = { ...draftInput(), requestId: randomUUID(), confirmed: true };
    const receipt = {
      requestId: input.requestId,
      state: "PENDING_REVIEW",
      expiresAt: new Date(
        credentials.verifySession(sessionToken).expiresAt,
      ).toISOString(),
      jobCreated: false,
      bookingAuthorized: false,
      deliveryAuthorized: false,
    };
    const submitReview = jest
      .fn()
      .mockResolvedValue({ ...receipt, secret: "DO_NOT_LEAK" });
    const transport = new CustomerConsentBrowserTransport(
      { origin, tenantId },
      { ...ports, review: { submitReview } },
    );
    const result = await asActor(() => transport.handle(req("submit", input)));
    expect(result.status).toBe(200);
    expect(result.body).toEqual(receipt);
    expect(submitReview).toHaveBeenCalledWith(input);
    expect(acquire).toHaveBeenCalledWith("127.0.0.1", "submit");
    expect((await call(req("submit", input))).status).toBe(503);
    for (const changed of [
      { confirmed: false },
      { expectedRevision: 0 },
      { requestId: "invalid" },
      { tenantId },
      { draft: { ...draftDetails, authority: true } },
    ]) {
      submitReview.mockClear();
      expect(
        (
          await asActor(() =>
            transport.handle(req("submit", { ...input, ...changed })),
          )
        ).status,
      ).toBe(400);
      expect(submitReview).not.toHaveBeenCalled();
    }
    for (const changed of [
      { jobCreated: true },
      { bookingAuthorized: true },
      { deliveryAuthorized: true },
      { expiresAt: "invalid" },
      { requestId: randomUUID() },
      { state: "ADMITTED" },
    ]) {
      submitReview.mockResolvedValue({ ...receipt, ...changed });
      expect(
        (await asActor(() => transport.handle(req("submit", input)))).status,
      ).toBe(503);
    }
  });
  const draftReceipt = () => ({
    draft: draftDetails,
    transcriptRevision: 1,
    emailChoice: "NOT_RECORDED",
    urgencyAssessment: "NOT_PERFORMED" as const,
    requiresHumanReview: true as const,
    jobCreated: false as const,
    bookingAuthorized: false as const,
    deliveryAuthorized: false as const,
  });
  it("projects only a read-only validated draft without internal fields", async () => {
    const previewDraft = jest
      .fn()
      .mockResolvedValue({ ...draftReceipt(), secret: "DO_NOT_LEAK" });
    const transport = new CustomerConsentBrowserTransport(
      { origin, tenantId },
      { ...ports, draft: { previewDraft } },
    );
    const result = await asActor(() =>
      transport.handle(req("draft", draftInput())),
    );
    expect(result.status).toBe(200);
    expect(result.body).toEqual(draftReceipt());
    expect(result.headers).toEqual(CUSTOMER_BROWSER_HEADERS);
    expect(acquire).toHaveBeenCalledWith("127.0.0.1", "draft");
  });
  it.each([
    { jobCreated: true },
    { bookingAuthorized: true },
    { deliveryAuthorized: true },
    { requiresHumanReview: false },
    { transcriptRevision: 2 },
    { draft: { ...draftDetails, customerName: "Changed" } },
  ])("refuses unsafe or changed draft receipt %#", async (override) => {
    const previewDraft = jest
      .fn()
      .mockResolvedValue({ ...draftReceipt(), ...override });
    const transport = new CustomerConsentBrowserTransport(
      { origin, tenantId },
      { ...ports, draft: { previewDraft } },
    );
    expect(
      (await asActor(() => transport.handle(req("draft", draftInput()))))
        .status,
    ).toBe(503);
  });
  it("refuses missing draft adapter", async () => {
    expect((await call(req("draft", draftInput()))).status).toBe(503);
  });
  it("refuses caller draft admission override before adapter", async () => {
    const previewDraft = jest.fn();
    const transport = new CustomerConsentBrowserTransport(
      { origin, tenantId },
      { ...ports, draft: { previewDraft } },
    );
    expect(
      (
        await asActor(() =>
          transport.handle(
            req("draft", { ...draftInput(), bookingAuthorized: true }),
          ),
        )
      ).status,
    ).toBe(400);
    expect(previewDraft).not.toHaveBeenCalled();
  });
  it("projects fresh bootstrap without internal fields and applies private headers", async () => {
    const result = await call();
    expect(result.status).toBe(200);
    expect(result.body.sessionToken).toBe(sessionToken);
    expect(result.headers).toEqual(CUSTOMER_BROWSER_HEADERS);
    expect(result.headers).not.toHaveProperty("Access-Control-Allow-Origin");
    expect(result.headers).not.toHaveProperty("Set-Cookie");
    expect(JSON.stringify(result)).not.toContain("DO_NOT_LEAK");
    expect(diagnostic).toHaveBeenCalledWith({
      operation: "start",
      status: 200,
    });
    expect(release).toHaveBeenCalledTimes(1);
  });
  it("projects protected continuation and charges the existing budget", async () => {
    const body = {
      sessionToken,
      interactionId: randomUUID(),
      message: "Fictional issue",
    };
    continuation.mockResolvedValue({
      reply: "Scripted reply",
      revision: 1,
      deliveryAuthorized: false,
      private: "DO_NOT_LEAK",
    });
    const result = await call(req("continue", body));
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      reply: "Scripted reply",
      revision: 1,
      deliveryAuthorized: false,
    });
    expect(continuation).toHaveBeenCalledWith(body);
    expect(acquire).toHaveBeenCalledWith("127.0.0.1", "continue");
    expect(result.headers).toEqual(CUSTOMER_BROWSER_HEADERS);
  });
  it.each([
    { message: "" },
    { message: "x".repeat(2001) },
    { interactionId: "raw-id" },
    { history: [] },
    { sessionToken: "forged" },
  ])(
    "refuses invalid continuation authority/input %# before collaborator",
    async (override) => {
      const result = await call(
        req("continue", {
          sessionToken,
          interactionId: randomUUID(),
          message: "Fictional",
          ...override,
        }),
      );
      expect(result.status).not.toBe(200);
      expect(continuation).not.toHaveBeenCalled();
    },
  );
  it.each([0, 21, 1.5])(
    "refuses invalid continuation receipt revision %s",
    async (revision) => {
      continuation.mockResolvedValue({
        reply: "Scripted",
        revision,
        deliveryAuthorized: false,
      });
      expect(
        (
          await call(
            req("continue", {
              sessionToken,
              interactionId: randomUUID(),
              message: "Fictional",
            }),
          )
        ).status,
      ).toBe(503);
    },
  );
  it.each([401, 409, 429, 503])(
    "continuation errors are fixed and never automatically retried: %s",
    async (status) => {
      continuation.mockRejectedValue(new HttpException("PRIVATE", status));
      const result = await call(
        req("continue", {
          sessionToken,
          interactionId: randomUUID(),
          message: "Fictional",
        }),
      );
      expect(result.status).toBe(status);
      expect(result.body).toEqual({ error: "Customer request refused." });
      expect(continuation).toHaveBeenCalledTimes(1);
    },
  );
  it("missing continuation adapter refuses without side effects", async () => {
    const transport = new CustomerConsentBrowserTransport(
      { origin, tenantId },
      { ...ports, continuation: undefined },
    );
    expect(
      (
        await asActor(() =>
          transport.handle(
            req("continue", {
              sessionToken,
              interactionId: randomUUID(),
              message: "Fictional",
            }),
          ),
        )
      ).status,
    ).toBe(503);
    expect(continuation).not.toHaveBeenCalled();
  });
  it.each([
    ["origin", undefined],
    ["origin", "null"],
    ["origin", "https://customer.example.invalid.evil.invalid"],
    ["origin", "https://customer.example.invalid/"],
    ["origin", "http://customer.example.invalid"],
    ["host", "evil.invalid"],
    ["sec-fetch-site", "same-site"],
    ["sec-fetch-site", "cross-site"],
    ["sec-fetch-site", undefined],
    ["sec-fetch-mode", "navigate"],
    ["sec-fetch-dest", "iframe"],
    ["x-calldesk-request", undefined],
    ["cookie", "secret"],
    ["authorization", "Bearer integration-secret"],
    ["content-encoding", "gzip"],
  ])(
    "refuses browser boundary mismatch %s=%s before work",
    async (name, value) => {
      const result = await call(header(name, value));
      expect(result.status).toBe(403);
      expect(start).not.toHaveBeenCalled();
      expect(acquire).not.toHaveBeenCalled();
      expect(result.body).toEqual({ error: "Customer request refused." });
      expect(result.headers).toEqual(CUSTOMER_BROWSER_HEADERS);
    },
  );
  it.each([
    "text/plain",
    "application/x-www-form-urlencoded",
    "application/json; charset=utf-8",
  ])("refuses unsupported content type %s", async (value) => {
    expect((await call(header("content-type", value))).status).toBe(415);
  });
  it.each(["GET", "OPTIONS", "PUT"])(
    "refuses %s without CORS authorization",
    async (method) => {
      expect((await call({ ...req(), method })).status).toBe(403);
      expect(start).not.toHaveBeenCalled();
    },
  );
  it.each([
    "/customer-session/start?token=PRIVATE",
    "/customer-session/start/",
    "/customer-session/%73tart",
  ])("refuses noncanonical path %s and never logs it", async (url) => {
    expect((await call({ ...req(), url })).status).toBe(403);
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain(url);
  });
  it("rejects duplicate security headers and unbounded headers", async () => {
    expect(
      (
        await call({
          ...req(),
          rawHeaders: [...req().rawHeaders, "ORIGIN", origin],
        })
      ).status,
    ).toBe(400);
    expect(
      (await call({ ...req(), rawHeaders: ["header", "x".repeat(8193)] }))
        .status,
    ).toBe(400);
  });
  it.each(["", "[]", '{"sessionId":"adopt"}', '{"x":1,"x":2}', "{ }"])(
    "refuses malformed or unexpected compact JSON %s",
    async (raw) => {
      expect((await call({ ...req(), body: Buffer.from(raw) })).status).toBe(
        400,
      );
      expect(start).not.toHaveBeenCalled();
    },
  );
  it("rejects oversized, invalid UTF-8 and inconsistent length without echoing payload", async () => {
    expect((await call({ ...req(), body: Buffer.alloc(16385) })).status).toBe(
      413,
    );
    expect((await call({ ...req(), body: Buffer.from([0xff]) })).status).toBe(
      400,
    );
    expect(
      (
        await call({
          ...req(),
          rawHeaders: [...req().rawHeaders, "Content-Length", "5"],
        })
      ).status,
    ).toBe(400);
    expect(start).not.toHaveBeenCalled();
  });
  it("requires server integration scope and TLS, never forwarded authority", async () => {
    expect((await model().handle(req())).status).toBe(403);
    expect((await asActor(() => model().handle(req()), "owner")).status).toBe(
      403,
    );
    expect(
      (
        await asActor(
          () => model().handle(req()),
          "webchat_integration",
          randomUUID(),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await asActor(
          () => model().handle(req()),
          "webchat_integration",
          tenantId,
          tenantId,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call({
          ...req(),
          encrypted: false,
          rawHeaders: [...req().rawHeaders, "X-Forwarded-Proto", "https"],
        })
      ).status,
    ).toBe(403);
    expect(start).not.toHaveBeenCalled();
  });
  it("fails closed without origin/ports/budget and when budget fails", async () => {
    expect(
      (await new CustomerConsentBrowserTransport().handle(req())).status,
    ).toBe(503);
    acquire.mockImplementationOnce(() => {
      throw Error("PRIVATE_LIMITER");
    });
    expect((await call()).status).toBe(503);
    acquire.mockReturnValueOnce(null);
    expect((await call()).status).toBe(429);
    acquire.mockReturnValueOnce("invalid adapter lease");
    expect((await call()).status).toBe(503);
    expect(start).not.toHaveBeenCalled();
  });
  it.each([
    "http://public.example.invalid",
    "https://customer.example.invalid/",
    "https://user:secret@customer.example.invalid",
    "https://customer.example.invalid/path",
  ])("refuses invalid configured origin %s", (bad) => {
    expect(
      () =>
        new CustomerConsentBrowserTransport({ origin: bad, tenantId }, ports),
    ).toThrow("refused");
  });
  it("allows only explicit loopback HTTP fixture configuration", () => {
    expect(
      () =>
        new CustomerConsentBrowserTransport(
          { origin: "http://127.0.0.1:1234", tenantId },
          ports,
        ),
    ).toThrow();
    expect(
      () =>
        new CustomerConsentBrowserTransport(
          { origin: "http://127.0.0.1:1234", tenantId, fixtureLoopback: true },
          ports,
        ),
    ).not.toThrow();
    expect(
      () =>
        new CustomerConsentBrowserTransport(
          { origin: "http://public.invalid", tenantId, fixtureLoopback: true },
          ports,
        ),
    ).toThrow();
  });
  it("checks session tenant before forwarding capture, and projects capture/receipt", async () => {
    const foreign = credentials.issueSession({
      tenantId: randomUUID(),
      conversationId: randomUUID(),
      sessionId: randomUUID(),
    });
    expect(
      (
        await call(
          req("capture", { sessionToken: foreign, email: "a@example.invalid" }),
        )
      ).status,
    ).toBe(403);
    expect(capture).not.toHaveBeenCalled();
    const result = await call(
      req("capture", { sessionToken, email: "a@example.invalid" }),
    );
    expect(result.body).toEqual({
      status: "captured",
      deliveryAuthorized: false,
    });
    const receipt = await call(
      req("respond", {
        sessionToken,
        promptToken: "fixture",
        response: "DECLINED",
        mailboxConfirmed: false,
      }),
    );
    expect(receipt.body).toEqual({
      state: "recorded",
      deliveryAuthorized: false,
    });
  });
  it("returns only fixed errors/diagnostics on application failures and does not retry", async () => {
    for (const error of [
      new Error("PRIVATE_EMAIL_TOKEN"),
      new HttpException("PRIVATE_EMAIL_TOKEN", 409),
    ]) {
      start.mockRejectedValueOnce(error);
      const result = await call();
      expect([409, 503]).toContain(result.status);
      expect(JSON.stringify(result)).not.toContain("PRIVATE");
      expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("PRIVATE");
    }
    expect(start).toHaveBeenCalledTimes(2);
  });
  it("does not change a successful outcome for a diagnostic failure", async () => {
    diagnostic.mockImplementation(() => {
      throw Error("PRIVATE");
    });
    expect((await call()).status).toBe(200);
    expect(start).toHaveBeenCalledTimes(1);
  });
  it("bounds body accumulation before JSON parsing", async () => {
    async function* small() {
      await Promise.resolve();
      yield Buffer.from("{");
      yield Buffer.from("}");
    }
    async function* large() {
      await Promise.resolve();
      yield Buffer.alloc(16384);
      yield Buffer.alloc(1);
      throw Error("should not read further");
    }
    expect((await readCustomerBrowserBody(small())).toString()).toBe("{}");
    await expect(readCustomerBrowserBody(large())).rejects.toMatchObject({
      status: 413,
    });
  });
  it("remains absent from production modules and controllers", () => {
    for (const file of [
      "communications.module.ts",
      "../integrations/webchat/webchat.module.ts",
      "../integrations/webchat/webchat.controller.ts",
    ])
      expect(readFileSync(join(__dirname, file), "utf8")).not.toContain(
        "CustomerConsentBrowser",
      );
  });
});
