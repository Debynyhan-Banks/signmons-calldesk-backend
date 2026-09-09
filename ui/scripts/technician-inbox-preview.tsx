import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { TechnicianInbox } from "../src/components/TechnicianInbox";
function Preview() {
  const [token, setToken] = useState("");
  return (
    <main
      style={{
        maxWidth: 1100,
        margin: "auto",
        padding: 16,
        fontFamily: "Arial, sans-serif",
      }}
    >
      <h1 style={{ overflowWrap: "anywhere" }}>
        CallDesk technician workspace
      </h1>
      <label>
        Fixture technician link{" "}
        <input
          type="password"
          autoComplete="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
      </label>
      <TechnicianInbox token={token} />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Preview />
  </StrictMode>,
);
