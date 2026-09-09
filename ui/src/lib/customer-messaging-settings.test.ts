import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SMS_KEYS,
  parseEmailSettings,
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
const email = () => ({
  updatedAt: "2030-01-01T00:00:00.000Z",
  source: "default",
  events: {
    APPOINTMENT_CONFIRMED: false,
    APPOINTMENT_RESCHEDULED: false,
    APPOINTMENT_CANCELLED: false,
  },
  recipientRole: "customer",
  deliveryAvailable: false,
});
test("email projects three blocked preferences, never server-supplied private fields", () => {
  const result = parseEmailSettings({
    ...email(),
    address: "private",
    body: "private",
  });
  assert.equal(result.templates.length, 3);
  assert.equal(result.source, "default");
  assert.ok(
    result.templates.every(
      (t) => !t.enabled && t.body.includes("not an email preview"),
    ),
  );
  assert.doesNotMatch(JSON.stringify(result), /private/);
});
for (const [name, patch] of Object.entries({
  delivery: { deliveryAvailable: true },
  role: { recipientRole: "owner" },
  missing: { events: {} },
  extra: { events: { ...email().events, TECHNICIAN_ON_THE_WAY: false } },
  version: { updatedAt: "today" },
  source: { source: "legacy" },
  defaultEnabled: {
    events: { ...email().events, APPOINTMENT_CONFIRMED: true },
  },
  invalidEnabled: {
    source: "invalid",
    events: { ...email().events, APPOINTMENT_CONFIRMED: true },
  },
  boolean: { events: { ...email().events, APPOINTMENT_CONFIRMED: "false" } },
}))
  test(`rejects unsafe email ${name}`, () =>
    assert.throws(() => parseEmailSettings({ ...email(), ...patch })));
test("saved email preferences remain separate from delivery availability", () => {
  assert.equal(
    parseEmailSettings({
      ...email(),
      source: "saved",
      events: { ...email().events, APPOINTMENT_CONFIRMED: true },
    }).templates[0].enabled,
    true,
  );
});
