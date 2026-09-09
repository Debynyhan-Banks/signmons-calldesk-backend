import assert from "node:assert/strict";
import { it } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CalendarReviewClient } from "./client.ts";
import type { ReviewReader, ReviewScope } from "./client.ts";
import { parseReview, operationLabel, reviewError } from "./contract.ts";

const id = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const time = "2039-01-01T12:00:00.000Z";
const snapshot = {
  snapshotOnly: true,
  operationId: id,
  jobId: id,
  action: "CREATE",
  status: "APPLIED",
  createdAt: time,
  updatedAt: time,
  finishedAt: null,
  pendingHoldReviewCandidate: false,
  recoveryReviewCandidate: "applied_create",
  recoveryReadbackNotBefore: null,
};
const scope: ReviewScope = {
  sessionKey: "synthetic-session-a",
  role: "owner",
  jobId: id,
  operationId: id,
};
const history = { snapshotOnly: true, hasMore: false, items: [snapshot] };
const requests = {
  snapshotOnly: true,
  requestOnly: true,
  hasMore: false,
  items: [{ requestId: other, kind: "applied_create", requestedAt: time }],
};
const reader: ReviewReader = async ({ resource }) => ({
  status: 200,
  body:
    resource === "job"
      ? history
      : resource === "operation"
        ? snapshot
        : requests,
});
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred() {
  let resolve!: (value: { status: number; body: unknown }) => void;
  const promise = new Promise<{ status: number; body: unknown }>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("projects only safe fields for each resource", () => {
  const privateRow = {
    ...snapshot,
    tenantId: "private-tenant",
    calendarId: "private-calendar",
    job: { token: "private-token" },
  };
  assert.deepEqual(parseReview("operation", privateRow, id).items, [snapshot]);
  assert.deepEqual(
    parseReview("job", { ...history, items: [privateRow] }, id).items,
    [snapshot],
  );
  const result = parseReview(
    "requests",
    {
      ...requests,
      items: [
        {
          ...requests.items[0],
          actorId: "private-actor",
          metadata: "private-data",
        },
      ],
    },
    id,
  );
  assert.deepEqual(result.items, requests.items);
  assert.equal(JSON.stringify(result).includes("private"), false);
});
it("requires exact UUID scope and permits canonicalized uppercase references", () => {
  assert.throws(() => parseReview("operation", snapshot, other));
  assert.throws(() => parseReview("job", history, other));
  assert.throws(() => parseReview("job", history, "invalid"));
  assert.deepEqual(parseReview("operation", snapshot, id.toUpperCase()).items, [
    snapshot,
  ]);
});
for (const [name, patch] of Object.entries({
  flag: { snapshotOnly: false },
  unknownStatus: { status: "private-status" },
  unknownAction: { action: "private-action" },
  objectAction: { action: { toString: () => "CREATE" } },
  malformedId: { operationId: "bad" },
  missingVersion: { updatedAt: undefined },
  noncanonicalDate: { updatedAt: "2039-01-01" },
  impossibleDate: { createdAt: "2039-02-30T12:00:00.000Z" },
  invalidFinished: { finishedAt: "not-date" },
  wrongHold: { pendingHoldReviewCandidate: true },
  wrongRecovery: { status: "PENDING" },
  wrongBoundary: { recoveryReadbackNotBefore: time },
  unknownHint: { recoveryReviewCandidate: "private" },
}))
  it("fails closed on malformed operation: " + name, () =>
    assert.throws(() =>
      parseReview("operation", { ...snapshot, ...patch }, id),
    ),
  );
it("preserves server UNCERTAIN hint without advancing it with the client clock", () => {
  const item = {
    ...snapshot,
    status: "UNCERTAIN",
    recoveryReviewCandidate: null,
    recoveryReadbackNotBefore: time,
  };
  assert.deepEqual(parseReview("operation", item, id).items, [item]);
});
it("requires request-only flags and fixed request kinds", () => {
  for (const value of [
    { ...requests, requestOnly: false },
    { ...requests, requestOnly: undefined },
    { ...requests, items: [{ ...requests.items[0], kind: "private-kind" }] },
    { ...requests, items: [{ ...requests.items[0], requestedAt: "bad" }] },
  ])
    assert.throws(() => parseReview("requests", value, id));
});
it("rejects oversized, duplicate and contradictory truncated histories", () => {
  for (const resource of ["job", "requests"] as const) {
    const value = resource === "job" ? history : requests;
    assert.throws(() =>
      parseReview(
        resource,
        { ...value, items: Array(101).fill(value.items[0]) },
        id,
      ),
    );
    assert.throws(() =>
      parseReview(
        resource,
        { ...value, items: [value.items[0], value.items[0]] },
        id,
      ),
    );
    assert.throws(() => parseReview(resource, { ...value, hasMore: true }, id));
    assert.throws(() =>
      parseReview(resource, { ...value, hasMore: "false" }, id),
    );
  }
});
it("accepts empty and 100-item histories without implying completeness", () => {
  assert.equal(
    parseReview("requests", { ...requests, items: [] }, id).requestOnly,
    true,
  );
  const items = Array.from({ length: 100 }, (_, i) => ({
    ...requests.items[0],
    requestId: `10000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  }));
  assert.equal(
    parseReview("requests", { ...requests, items, hasMore: true }, id).hasMore,
    true,
  );
});
it("labels journal terminal states without promising provider or booking truth", () => {
  assert.match(operationLabel("FINALIZED"), /not a current booking receipt/);
  assert.match(operationLabel("ABORTED"), /not proof of provider absence/);
  assert.match(reviewError(503), /no recovery action/);
});
it("loads three independent views only on explicit requests", async () => {
  let calls = 0;
  const client = new CalendarReviewClient(async (input) => {
    calls++;
    return reader(input);
  });
  client.setScope(scope);
  assert.equal(calls, 0);
  await Promise.all(
    ["job", "operation", "requests"].map((resource) =>
      client.load(resource as "job" | "operation" | "requests"),
    ),
  );
  assert.equal(calls, 3);
  for (const view of Object.values(client.getState().views))
    assert.equal(view.state, "ready");
  client.dispose();
});
it("refuses missing session/role and non-owner/admin roles before reads", async () => {
  let calls = 0;
  const client = new CalendarReviewClient(async (input) => {
    calls++;
    return reader(input);
  });
  for (const patch of [
    { sessionKey: "" },
    { role: null },
    { role: "dispatcher" },
    { role: "technician" },
    { role: "viewer" },
  ]) {
    client.setScope({ ...scope, ...patch });
    await client.load("job");
    assert.equal(client.getState().allowed, false);
  }
  client.setScope({ ...scope, role: " AdMiN " });
  await client.load("job");
  assert.equal(calls, 1);
  client.dispose();
});
it("refuses invalid references locally", async () => {
  const client = new CalendarReviewClient(() => {
    throw new Error("must not read");
  });
  client.setScope({ ...scope, jobId: "bad", operationId: "bad" });
  for (const resource of ["job", "operation", "requests"] as const) {
    await client.load(resource);
    assert.equal(client.getState().views[resource].state, "error");
  }
  client.dispose();
});
it("deduplicates repeated clicks and clears earlier data before refresh", async () => {
  const pending = deferred();
  let calls = 0;
  const client = new CalendarReviewClient(async (input) =>
    ++calls === 1 ? reader(input) : pending.promise,
  );
  client.setScope(scope);
  await client.load("operation");
  const load = client.load("operation");
  await client.load("operation");
  await flush();
  assert.equal(calls, 2);
  assert.deepEqual(client.getState().views.operation, { state: "loading" });
  pending.resolve({ status: 200, body: snapshot });
  await load;
  client.dispose();
});
for (const change of [
  "session",
  "job",
  "operation",
  "role",
  "clear",
  "dispose",
] as const) {
  it("discards late responses after " + change, async () => {
    const pending = deferred();
    let signal: AbortSignal | undefined;
    const client = new CalendarReviewClient(async (input) => {
      signal = input.signal;
      return pending.promise;
    });
    client.setScope(scope);
    const load = client.load("operation");
    await flush();
    if (change === "clear") client.clear();
    else if (change === "dispose") client.dispose();
    else
      client.setScope({
        ...scope,
        ...(change === "session"
          ? { sessionKey: "session-b" }
          : change === "job"
            ? { jobId: other }
            : change === "operation"
              ? { operationId: other }
              : { role: "viewer" }),
      });
    assert.equal(signal?.aborted, true);
    pending.resolve({ status: 200, body: snapshot });
    await load;
    assert.equal(client.getState().views.operation.data, undefined);
    assert.equal(client.getState().views.operation.state, "idle");
    client.dispose();
  });
}
it("clears every view on identity denial and ignores concurrent late successes", async () => {
  const pending = deferred();
  const client = new CalendarReviewClient(async ({ resource }) =>
    resource === "job"
      ? pending.promise
      : { status: 403, body: { private: "secret" } },
  );
  client.setScope(scope);
  const job = client.load("job");
  await client.load("operation");
  pending.resolve({ status: 200, body: history });
  await job;
  assert.equal(client.getState().allowed, false);
  for (const view of Object.values(client.getState().views)) {
    assert.equal(view.state, "error");
    assert.equal(view.data, undefined);
  }
  client.setScope({ ...scope, jobId: other });
  assert.equal(client.getState().allowed, false);
  client.setScope({ ...scope, sessionKey: "session-new" });
  assert.equal(client.getState().allowed, true);
  client.dispose();
});
for (const status of [400, 404, 429, 500, 503]) {
  it(
    "keeps partial reads independent on " + status + " without retry",
    async () => {
      let calls = 0;
      const client = new CalendarReviewClient(async (input) => {
        calls++;
        return input.resource === "requests"
          ? { status, body: { message: "private-error" } }
          : reader(input);
      });
      client.setScope(scope);
      await client.load("operation");
      await client.load("requests");
      assert.equal(client.getState().views.operation.state, "ready");
      assert.equal(client.getState().views.requests.state, "error");
      assert.equal(
        JSON.stringify(client.getState()).includes("private-error"),
        false,
      );
      assert.equal(calls, 2);
      client.dispose();
    },
  );
}
it("times out even if a reader ignores abort, then discards its late result", async () => {
  const pending = deferred();
  let calls = 0;
  let signal: AbortSignal | undefined;
  const client = new CalendarReviewClient(async (input) => {
    calls++;
    signal = input.signal;
    return pending.promise;
  }, 5);
  client.setScope(scope);
  await client.load("operation");
  assert.equal(signal?.aborted, true);
  assert.equal(client.getState().views.operation.state, "error");
  pending.resolve({ status: 200, body: snapshot });
  await flush();
  assert.equal(client.getState().views.operation.state, "error");
  assert.equal(calls, 1);
  client.dispose();
});
it("bounds malformed success and synchronous or asynchronous reader failures", async () => {
  for (const read of [
    async () => ({ status: 200, body: { private: "malformed" } }),
    () => {
      throw new Error("private-sync");
    },
    async () => {
      throw new Error("private-async");
    },
  ]) {
    const client = new CalendarReviewClient(read);
    client.setScope(scope);
    await client.load("operation");
    assert.equal(client.getState().views.operation.state, "error");
    assert.equal(JSON.stringify(client.getState()).includes("private"), false);
    client.dispose();
  }
});
it("is unlinked from all app routes and has no network, credential storage or mutation implementation", () => {
  const root = new URL("../app/", import.meta.url);
  function files(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? files(join(dir, entry.name))
        : [join(dir, entry.name)],
    );
  }
  for (const path of files(root.pathname).filter((path) =>
    /\.[jt]sx?$/.test(path),
  ))
    assert.doesNotMatch(
      readFileSync(path, "utf8"),
      /calendar-review|CalendarReviewPanel/,
    );
  for (const name of ["client.ts", "contract.ts", "review-panel.tsx"])
    assert.doesNotMatch(
      readFileSync(new URL(name, import.meta.url), "utf8"),
      /\bfetch\s*\(|localStorage|sessionStorage|document\.cookie|method:\s*["']POST/,
    );
});
