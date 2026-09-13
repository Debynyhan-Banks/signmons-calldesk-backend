import assert from "node:assert/strict";
import { it } from "node:test";
import { CalendarReviewHttpSession } from "./http-session.ts";
import { CalendarReviewClient } from "./client.ts";

const id = "11111111-1111-4111-8111-111111111111";
const base = "https://calldesk.invalid";
const input = (resource = "operation") => ({
  resource: resource as "operation",
  reference: id,
  signal: new AbortController().signal,
});
const ok = (body: unknown = {}) =>
  new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, no-store",
    },
  });
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
it("makes no request until explicit binding and reading", async () => {
  let count = 0;
  const session = new CalendarReviewHttpSession(base, async () => {
    count++;
    return ok();
  });
  assert.equal(session.getSnapshot().role, null);
  assert.equal((await session.getSnapshot().read(input())).status, 401);
  session.bind({ bearerToken: "fixture-token", role: "owner" });
  assert.equal(count, 0);
  await session.getSnapshot().read(input());
  assert.equal(count, 1);
  session.dispose();
});
for (const [resource, path] of Object.entries({
  job: `jobs/${id}/operations`,
  operation: `operations/${id}`,
  requests: `operations/${id}/recovery-requests`,
}))
  it(
    "uses fixed authenticated GET-only transport for " + resource,
    async () => {
      let count = 0;
      const session = new CalendarReviewHttpSession(base, async (url, init) => {
        count++;
        assert.equal(url, `${base}/scheduling/calendar-review/${path}`);
        assert.deepEqual(
          { ...init, signal: undefined },
          {
            method: "GET",
            headers: {
              Accept: "application/json",
              Authorization: "Bearer fixture-token",
            },
            credentials: "omit",
            cache: "no-store",
            redirect: "error",
            referrerPolicy: "no-referrer",
            signal: undefined,
          },
        );
        return ok({ snapshotOnly: true });
      });
      const bound = session.bind({
        bearerToken: " fixture-token ",
        role: " AdMiN ",
      });
      assert.equal(bound.role, "admin");
      assert.equal(JSON.stringify(bound).includes("fixture-token"), false);
      assert.equal(JSON.stringify(session).includes("fixture-token"), false);
      assert.deepEqual(await bound.read(input(resource)), {
        status: 200,
        body: { snapshotOnly: true },
      });
      assert.equal(count, 1);
      session.dispose();
    },
  );
for (const value of [
  "http://remote.invalid",
  "https://user:secret@calldesk.invalid",
  base + "/api",
  base + "/?token=secret",
  base + "/#fragment",
  "file:///tmp",
  "not-url",
]) {
  it("rejects unsafe configured origin " + value.split("?")[0], () => {
    assert.throws(
      () => new CalendarReviewHttpSession(value, async () => ok()),
      /^Error: Calendar review read is unavailable\.$/,
    );
  });
}
it("permits explicit local loopback HTTP for isolated acceptance", () => {
  for (const value of [
    "http://localhost:3000",
    "http://127.0.0.1:4000",
    "http://[::1]:3000",
  ])
    new CalendarReviewHttpSession(value, async () => ok()).dispose();
});
it("refuses blank/malformed tokens and denied display roles without a request", async () => {
  let count = 0;
  const session = new CalendarReviewHttpSession(base, async () => {
    count++;
    return ok();
  });
  for (const bearerToken of [
    "",
    " ",
    "a b",
    "a\nb",
    "Bearer token",
    "x".repeat(16_385),
  ]) {
    const bound = session.bind({ bearerToken, role: "owner" });
    assert.equal(bound.role, null);
    assert.equal((await bound.read(input())).status, 401);
  }
  for (const role of [null, "dispatcher", "viewer", "technician"]) {
    assert.equal(session.bind({ bearerToken: "fixture", role }).role, null);
  }
  assert.equal(count, 0);
  session.dispose();
});
it("rejects malformed references and unknown resources before fetch", async () => {
  const session = new CalendarReviewHttpSession(base, async () => {
    throw new Error("must not fetch");
  });
  const bound = session.bind({ bearerToken: "fixture", role: "owner" });
  assert.equal(
    (await bound.read({ ...input(), reference: "../escape?secret=x" })).status,
    400,
  );
  assert.equal((await bound.read(input("__proto__"))).status, 400);
  session.dispose();
});
it("malformed runtime binding revokes former credentials instead of retaining them", async () => {
  let count = 0;
  const session = new CalendarReviewHttpSession(base, async () => {
    count++;
    return ok();
  });
  for (const value of [
    null,
    {},
    { bearerToken: 42, role: "owner" },
    { bearerToken: "fixture", role: {} },
  ]) {
    const old = session.bind({ bearerToken: "old-fixture", role: "owner" });
    const next = session.bind(value as never);
    assert.equal(next.role, null);
    assert.equal((await old.read(input())).status, 401);
    assert.equal((await next.read(input())).status, 401);
  }
  assert.equal(count, 0);
  session.dispose();
});
it("rotates non-secret descriptors on every binding, clear and identity change", async () => {
  const session = new CalendarReviewHttpSession(base, async () => ok());
  let changed = 0;
  const stop = session.subscribe(() => {
    changed++;
  });
  const first = session.bind({ bearerToken: "fixture-a", role: "owner" });
  const same = session.bind({ bearerToken: "fixture-a", role: "owner" });
  const second = session.bind({ bearerToken: "fixture-b", role: "admin" });
  assert.equal(
    new Set([first.sessionKey, same.sessionKey, second.sessionKey]).size,
    3,
  );
  assert.equal((await first.read(input())).status, 401);
  session.clear();
  assert.equal((await second.read(input())).status, 401);
  assert.equal(changed, 4);
  stop();
  session.dispose();
});
for (const action of ["bind", "clear", "dispose", "abort"])
  it("discards pending header responses on " + action, async () => {
    const pending = deferred();
    let signal: AbortSignal | undefined;
    const session = new CalendarReviewHttpSession(base, async (_url, init) => {
      signal = init.signal as AbortSignal;
      return pending.promise;
    });
    const bound = session.bind({ bearerToken: "fixture-a", role: "owner" });
    const controller = new AbortController();
    const result = bound.read({ ...input(), signal: controller.signal });
    const rejection = assert.rejects(
      result,
      /Calendar review read is unavailable/,
    );
    await flush();
    if (action === "bind")
      session.bind({ bearerToken: "fixture-b", role: "admin" });
    if (action === "clear") session.clear();
    if (action === "dispose") session.dispose();
    if (action === "abort") controller.abort();
    pending.resolve(ok());
    await rejection;
    assert.equal(signal?.aborted, true);
    session.dispose();
  });
it("refuses an already aborted read before fetch", async () => {
  let count = 0;
  const session = new CalendarReviewHttpSession(base, async () => {
    count++;
    return ok();
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    session
      .bind({ bearerToken: "fixture", role: "owner" })
      .read({ ...input(), signal: controller.signal }),
  );
  assert.equal(count, 0);
  session.dispose();
});
it("releases a late response body when fetch ignores session cancellation", async () => {
  const pending = deferred();
  let cancelled = false;
  const session = new CalendarReviewHttpSession(base, () => pending.promise);
  const result = session
    .bind({ bearerToken: "fixture", role: "owner" })
    .read(input());
  const rejection = assert.rejects(result);
  session.clear();
  await rejection;
  pending.resolve(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      { headers: ok().headers },
    ),
  );
  await flush();
  assert.equal(cancelled, true);
  session.dispose();
});
for (const status of [401, 403])
  it("revokes credentials and sibling reads on " + status, async () => {
    const pending = deferred();
    let count = 0;
    const session = new CalendarReviewHttpSession(base, async () =>
      ++count === 1
        ? pending.promise
        : new Response("PRIVATE-ERROR", { status }),
    );
    const bound = session.bind({ bearerToken: "fixture", role: "owner" });
    const first = bound.read(input("job"));
    const rejection = assert.rejects(first);
    assert.deepEqual(await bound.read(input()), { status, body: null });
    await rejection;
    pending.resolve(ok());
    assert.equal(session.getSnapshot().role, null);
    assert.equal((await bound.read(input())).status, 401);
    assert.equal(count, 2);
    session.dispose();
  });
it("does not read error bodies or retry status failures", async () => {
  for (const status of [400, 404, 409, 429, 500, 503]) {
    let count = 0;
    const session = new CalendarReviewHttpSession(base, async () => {
      count++;
      return new Response("PRIVATE-ERROR", { status });
    });
    assert.deepEqual(
      await session
        .bind({ bearerToken: "fixture", role: "owner" })
        .read(input()),
      { status, body: null },
    );
    assert.equal(count, 1);
    session.dispose();
  }
});
for (const name of [
  "html",
  "missing-no-store",
  "invalid-json",
  "oversized-length",
  "oversized-stream",
  "invalid-utf8",
  "redirected",
  "wrong-url",
])
  it("bounds unsafe response " + name, async () => {
    const response =
      name === "html"
        ? new Response("PRIVATE", { headers: { "content-type": "text/html" } })
        : name === "missing-no-store"
          ? new Response("{}", {
              headers: { "content-type": "application/json" },
            })
          : name === "invalid-json"
            ? ok()
            : ok();
    let returned = response;
    if (name === "invalid-json")
      returned = new Response("PRIVATE", { headers: response.headers });
    if (name === "oversized-length")
      response.headers.set("content-length", "262145");
    if (name === "oversized-stream")
      returned = new Response("x".repeat(262145), {
        headers: response.headers,
      });
    if (name === "invalid-utf8")
      returned = new Response(new Uint8Array([0xff]), {
        headers: response.headers,
      });
    if (name === "redirected")
      Object.defineProperty(response, "redirected", { value: true });
    if (name === "wrong-url")
      Object.defineProperty(response, "url", {
        value: "https://other.invalid/",
      });
    const session = new CalendarReviewHttpSession(base, async () => returned);
    await assert.rejects(
      session.bind({ bearerToken: "fixture", role: "owner" }).read(input()),
      /^Error: Calendar review read is unavailable\.$/,
    );
    session.dispose();
  });
it("cancels a stalled response body and rejects old completion on rebind", async () => {
  let cancelled = false;
  const session = new CalendarReviewHttpSession(
    base,
    async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { headers: ok().headers },
      ),
  );
  const result = session
    .bind({ bearerToken: "fixture", role: "owner" })
    .read(input());
  const rejection = assert.rejects(result);
  await flush();
  session.bind({ bearerToken: "new-fixture", role: "owner" });
  await rejection;
  assert.equal(cancelled, true);
  session.dispose();
});
it("composes with the real client and strips private fields after HTTP parsing", async () => {
  const date = "2039-01-01T12:00:00.000Z";
  const body = {
    snapshotOnly: true,
    operationId: id,
    jobId: id,
    action: "CREATE",
    status: "PENDING",
    createdAt: date,
    updatedAt: date,
    finishedAt: null,
    pendingHoldReviewCandidate: true,
    recoveryReviewCandidate: null,
    recoveryReadbackNotBefore: null,
    private: "PRIVATE-FIELD",
  };
  const session = new CalendarReviewHttpSession(base, async () => ok(body));
  const bound = session.bind({ bearerToken: "fixture", role: "owner" });
  const client = new CalendarReviewClient(bound.read);
  client.setScope({ ...bound, jobId: id, operationId: id });
  await client.load("operation");
  assert.equal(client.getState().views.operation.state, "ready");
  assert.equal(JSON.stringify(client.getState()).includes("PRIVATE"), false);
  client.dispose();
  session.dispose();
});
it("uses a finite transport deadline even if fetch ignores abort", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const session = new CalendarReviewHttpSession(
    base,
    () => new Promise(() => {}),
  );
  const result = session
    .bind({ bearerToken: "fixture", role: "owner" })
    .read(input());
  const rejection = assert.rejects(result);
  context.mock.timers.tick(15_000);
  await rejection;
  session.dispose();
});
