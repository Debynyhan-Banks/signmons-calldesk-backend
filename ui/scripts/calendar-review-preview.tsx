import React, { useCallback, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { CalendarReviewPanel } from "../src/calendar-review/review-panel";
import type { ReviewReader } from "../src/calendar-review/client";

const id = "11111111-1111-4111-8111-111111111111";
const time = "2039-01-01T12:00:00.000Z";
const snapshot = {
  snapshotOnly: true,
  operationId: id,
  jobId: id,
  action: "CREATE",
  status: "UNCERTAIN",
  createdAt: time,
  updatedAt: time,
  finishedAt: null,
  pendingHoldReviewCandidate: false,
  recoveryReviewCandidate: "uncertain_create",
  recoveryReadbackNotBefore: time,
  calendarId: "PRIVATE-CALENDAR",
  customer: { token: "PRIVATE-TOKEN" },
};
function Preview() {
  const [scenario, setScenario] = useState("ready");
  const [session, setSession] = useState("owner-a");
  const scenarioRef = useRef(scenario);
  scenarioRef.current = scenario;
  const [calls, setCalls] = useState(0);
  const read: ReviewReader = useCallback(async ({ resource, reference }) => {
    setCalls((value) => value + 1);
    const mode = scenarioRef.current;
    if (mode === "delayed")
      await new Promise((resolve) => setTimeout(resolve, 700));
    if (mode === "timeout")
      await new Promise((resolve) => setTimeout(resolve, 16_000));
    if (mode === "network") throw new Error("PRIVATE-NETWORK");
    if (["401", "403", "404", "429", "503"].includes(mode))
      return { status: Number(mode), body: { message: "PRIVATE-ERROR" } };
    if (mode === "partial" && resource === "requests")
      return { status: 503, body: {} };
    if (mode === "malformed")
      return { status: 200, body: { private: "PRIVATE-MALFORMED" } };
    const operation = {
      ...snapshot,
      operationId: reference,
      jobId: reference,
      ...(mode === "finalized"
        ? {
            status: "FINALIZED",
            finishedAt: time,
            recoveryReviewCandidate: null,
            recoveryReadbackNotBefore: null,
          }
        : {}),
    };
    const count = mode === "empty" ? 0 : mode === "truncated" ? 100 : 1;
    const items = Array.from({ length: count }, (_, index) => {
      const itemId = `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      return resource === "requests"
        ? {
            requestId: itemId,
            kind: "uncertain_create",
            requestedAt: time,
            actorId: "PRIVATE-ACTOR",
            metadata: "PRIVATE-METADATA",
          }
        : { ...operation, operationId: itemId };
    });
    return {
      status: 200,
      body:
        resource === "operation"
          ? operation
          : {
              snapshotOnly: true,
              ...(resource === "requests" ? { requestOnly: true } : {}),
              hasMore: mode === "truncated",
              items,
            },
    };
  }, []);
  return (
    <>
      <aside
        aria-label="Synthetic preview controls"
        style={{
          maxWidth: 1200,
          margin: "16px auto",
          padding: 16,
          background: "#e3edf7",
          font: "16px/1.6 Arial",
        }}
      >
        <strong>
          Local synthetic fixtures only — no credentials or provider access
        </strong>
        <p>Example job and operation reference: {id}</p>
        <label>
          Fixture scenario{" "}
          <select
            value={scenario}
            onChange={(event) => setScenario(event.target.value)}
          >
            {[
              "ready",
              "empty",
              "truncated",
              "finalized",
              "partial",
              "malformed",
              "network",
              "delayed",
              "timeout",
              "401",
              "403",
              "404",
              "429",
              "503",
            ].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>{" "}
        <label>
          Fixture session{" "}
          <select
            value={session}
            onChange={(event) => setSession(event.target.value)}
          >
            {["owner-a", "admin-b", "dispatcher"].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <p>
          Injected read calls:{" "}
          <output aria-label="Injected read calls">{calls}</output>
        </p>
      </aside>
      <CalendarReviewPanel
        sessionKey={session}
        role={session.split("-")[0]}
        read={read}
      />
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Preview />
  </React.StrictMode>,
);
