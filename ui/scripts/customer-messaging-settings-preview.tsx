import React from "react";
import { createRoot } from "react-dom/client";
import MessagingSettingsPage from "../src/app/app/messaging-settings/page";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MessagingSettingsPage />
  </React.StrictMode>,
);
