import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SMS_KEYS,
  parseMessagingSettings,
  settingsError,
} from "./customer-messaging-settings.ts";
const valid = () => ({
  updatedAt: "2030-01-01T00:00:00.000Z",
  source: "saved",
  templates: SMS_KEYS.map((key) => ({
    key,
    enabled: true,
    body: "Example Service: fixture. Reply STOP.",
    templateVersion: 1,
    private: "omit",
  })),
});
test("projects the four exact previews without extra fields", () => {
  assert.equal(
    JSON.stringify(
      parseMessagingSettings({ ...valid(), secret: "omit" }),
    ).includes("omit"),
    false,
  );
});
for (const [name, update] of Object.entries({
  missing: { templates: [] },
  duplicate: { templates: Array(4).fill(valid().templates[0]) },
  timestamp: { updatedAt: "today" },
  source: { source: "unknown" },
  boolean: {
    templates: valid().templates.map((t) => ({ ...t, enabled: "yes" })),
  },
  version: {
    templates: valid().templates.map((t) => ({ ...t, templateVersion: 2 })),
  },
  long: {
    templates: valid().templates.map((t) => ({ ...t, body: "x".repeat(1601) })),
  },
})) {
  test(`rejects invalid ${name} response`, () =>
    assert.throws(() => parseMessagingSettings({ ...valid(), ...update })));
}
test("unknown write outcome never claims failure or retries", () =>
  assert.match(settingsError(503, true), /unconfirmed.*Reload/));
test("401 and 403 require a new session; conflict requires reload", () => {
  for (const status of [401, 403])
    assert.match(settingsError(status), /new authorized session/);
  assert.match(settingsError(409), /Reload/);
});
