import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { CalendarReviewHttpSession } from "../src/calendar-review/http-session";
import { CalendarReviewSessionPanel } from "../src/calendar-review/session-panel";

declare global {
  interface Window {
    calendarReviewFixtureOrigin: string;
  }
}
// Fictional credentials only. Never import this harness from an app route.
const createSession = () =>
  new CalendarReviewHttpSession(
    window.calendarReviewFixtureOrigin,
    (url, init) => window.fetch(url, init),
  );
function Preview() {
  const [session, setSession] = useState(createSession);
  const [identity, setIdentity] = useState("owner-a");
  const [mounted, setMounted] = useState(true);
  return (
    <>
      <aside
        aria-label="Synthetic HTTP controls"
        style={{
          maxWidth: 1200,
          margin: "16px auto",
          padding: 16,
          background: "#e3edf7",
          font: "16px/1.6 Arial",
        }}
      >
        <strong>
          Local browser-to-HTTP fixture — fictional identity and read-only data
        </strong>
        <p>Job and operation reference: 11111111-1111-4111-8111-111111111111</p>
        <label>
          Fixture identity{" "}
          <select
            value={identity}
            onChange={(event) => setIdentity(event.target.value)}
          >
            {[
              "owner-a",
              "admin-a",
              "owner-b",
              "dispatcher",
              "bad",
              "missing-tenant",
              "failure-a",
              "delayed-a",
            ].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>{" "}
        <button
          onClick={() => session.bind({ bearerToken: identity, role: "owner" })}
        >
          Bind fixture session
        </button>{" "}
        <button
          onClick={() => {
            session.dispose();
            setSession(createSession());
          }}
        >
          Replace session object
        </button>{" "}
        <button onClick={() => session.clear()}>Sign out fixture</button>{" "}
        <button onClick={() => setMounted((value) => !value)}>
          {mounted ? "Unmount panel" : "Mount panel"}
        </button>
      </aside>
      {mounted && <CalendarReviewSessionPanel session={session} />}
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Preview />
  </React.StrictMode>,
);
