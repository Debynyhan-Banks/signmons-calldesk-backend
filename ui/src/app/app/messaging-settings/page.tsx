"use client";
import { useEffect, useRef, useState } from "react";
import {
  MessagingSettingsError,
  requestMessagingSettings,
  settingsError,
  type MessagingSettings,
  type SmsPreferences,
} from "@/lib/customer-messaging-settings";
import { messageLabel } from "@/lib/notification-history";
import styles from "./settings.module.css";

export default function MessagingSettingsPage() {
  const [token, setToken] = useState("");
  const [channel, setChannel] = useState<"sms" | "email">("sms");
  const [snapshot, setSnapshot] = useState<MessagingSettings | null>(null);
  const [events, setEvents] = useState<SmsPreferences | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const generation = useRef(0),
    controller = useRef<AbortController | null>(null),
    pending = useRef(false);
  useEffect(
    () => () => {
      generation.current++;
      controller.current?.abort();
    },
    [],
  );
  function clear() {
    generation.current++;
    controller.current?.abort();
    setSnapshot(null);
    setEvents(null);
    setNotice("");
    setAcknowledged(false);
  }
  async function request(saving = false) {
    if (
      pending.current ||
      !token.trim() ||
      (saving && (!snapshot || !events || !acknowledged))
    )
      return;
    const input =
      saving && snapshot && events
        ? { expectedUpdatedAt: snapshot.updatedAt, events: { ...events } }
        : undefined;
    const current = ++generation.current;
    const abort = new AbortController();
    controller.current = abort;
    pending.current = true;
    setBusy(true);
    setSnapshot(null);
    setEvents(null);
    setAcknowledged(false);
    setNotice(saving ? "Saving preferences…" : "Loading settings…");
    const timer = setTimeout(() => abort.abort(), 15_000);
    try {
      const result = await requestMessagingSettings(
        token,
        abort.signal,
        input,
        channel,
      );
      if (current !== generation.current) return;
      if (saving)
        setNotice(
          "Preferences saved. No message was sent. Reload to review current settings.",
        );
      else {
        setSnapshot(result);
        setEvents(
          Object.fromEntries(
            result.templates.map((t) => [t.key, t.enabled]),
          ) as SmsPreferences,
        );
        setNotice(
          channel === "email"
            ? "Email preferences loaded. Delivery is unavailable; these switches do not grant customer consent."
            : "Settings loaded. Previews use an example date and technician, not customer data.",
        );
      }
    } catch (error) {
      if (current === generation.current) {
        const status =
          error instanceof MessagingSettingsError ? error.status : undefined;
        if (status === 401 || status === 403) setToken("");
        setNotice(settingsError(status, saving));
      }
    } finally {
      clearTimeout(timer);
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <main className={styles.shell}>
      <nav aria-label="CallDesk">
        <a href="/app/notifications">← Notification center</a>
        <span>Signmons / CallDesk</span>
      </nav>
      <header>
        <p className={styles.eyebrow}>Customer communications</p>
        <h1>Messaging settings</h1>
        <p>
          Choose customer SMS or email event preferences independently. Email
          delivery remains unavailable.
        </p>
      </header>
      <section className={styles.connection} aria-label="Owner connection">
        <label>
          Communication channel
          <select
            value={channel}
            onChange={(e) => {
              clear();
              setChannel(e.target.value as "sms" | "email");
            }}
          >
            <option value="sms">Customer SMS</option>
            <option value="email">Customer email</option>
          </select>
        </label>
        <label>
          Operator ID token
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={token}
            onChange={(e) => {
              clear();
              setToken(e.target.value);
            }}
          />
        </label>
        <button disabled={busy || !token.trim()} onClick={() => void request()}>
          Load settings
        </button>
        <button
          onClick={() => {
            clear();
            setToken("");
          }}
        >
          Clear session
        </button>
      </section>
      <p role="status" className={styles.notice}>
        {notice ||
          "Use a current owner or admin token. Tokens stay in memory only."}
      </p>
      <p className={styles.boundary}>
        Preferences do not turn delivery on or bypass consent, opt-out, quiet
        hours, or Calendar checks. Email preferences are not consent or proof of
        a finalized booking. Other recipient roles and events are not
        configurable here.
      </p>
      {snapshot && events && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void request(true);
          }}
        >
          <p>
            {snapshot.source === "default"
              ? "No saved email preferences. All three events are blocked by default."
              : snapshot.source === "legacy"
                ? "No saved preferences yet. Existing SMS events remain permitted, subject to all delivery controls."
                : snapshot.source === "invalid"
                  ? channel === "email"
                    ? "Stored email preferences need administrator review. All three events are blocked; saving is unavailable."
                    : "Stored preferences are invalid. All four events are blocked until valid settings are saved."
                  : "Saved tenant preferences"}
          </p>
          <div className={styles.cards}>
            {snapshot.templates.map((template) => (
              <section
                className={styles.card}
                key={template.key}
                aria-label={messageLabel(template.key)}
              >
                <label className={styles.toggle}>
                  <input
                    type="checkbox"
                    checked={events[template.key]}
                    onChange={(e) => {
                      setEvents({
                        ...events,
                        [template.key]: e.target.checked,
                      });
                      setAcknowledged(false);
                    }}
                  />
                  {messageLabel(template.key)}
                </label>
                <p className={styles.meta}>
                  {channel === "email"
                    ? "Customer email · preference only"
                    : `Customer SMS · fixed template v${template.templateVersion}`}{" "}
                  · {events[template.key] ? "Permitted" : "Blocked"}
                </p>
                <blockquote>{template.body}</blockquote>
              </section>
            ))}
          </div>
          <section className={styles.save} aria-label="Save preferences">
            <label>
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
              />{" "}
              I reviewed these preferences. Permitted events may be sent later
              only when delivery is separately enabled and all checks pass.
            </label>
            <p>
              {channel === "email" ? (
                "Email delivery is not connected. Saving changes only the tenant preference and its audit. It does not verify mailbox ownership, grant consent, issue links or queue a message."
              ) : (
                <>
                  Blocking stops new queue admission and suppresses queued
                  messages when checked before sending. It cannot recall an
                  in-flight message. Permitting an event does not replay
                  previously stopped notifications.
                </>
              )}
            </p>
            <button
              disabled={
                busy ||
                !acknowledged ||
                (channel === "email" && snapshot.source === "invalid")
              }
              type="submit"
            >
              Save preferences
            </button>
          </section>
        </form>
      )}
    </main>
  );
}
