"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import styles from "../messaging-settings/settings.module.css";

type Draft = {
  companyName: string;
  timezone: string;
  hours: string;
  services: string;
  fallback: string;
  greeting: string;
  tone: "warm" | "concise";
  faqs: { question: string; answer: string; source: string }[];
};
type Snapshot = {
  updatedAt: string;
  profile: null | {
    draft: Draft;
    approved: null | { draft: Draft; approvedAt: string; actorId: string };
  };
  runtimeConnected: false;
};
const empty: Draft = {
  companyName: "",
  timezone: "America/New_York",
  hours: "",
  services: "",
  fallback: "Please contact our team for help with that question.",
  greeting: "Hello.",
  tone: "warm",
  faqs: [{ question: "", answer: "", source: "" }],
};
const fields: {
  key: keyof Omit<Draft, "tone" | "faqs">;
  label: string;
  max: number;
}[] = [
  { key: "companyName", label: "Company display name", max: 120 },
  { key: "timezone", label: "Timezone", max: 80 },
  { key: "hours", label: "Business hours (approved description)", max: 500 },
  {
    key: "services",
    label: "Offered and unsupported services (approved description)",
    max: 500,
  },
  {
    key: "fallback",
    label: "Unknown-question / after-hours contact instructions",
    max: 500,
  },
  { key: "greeting", label: "Brand greeting", max: 200 },
];
export default function OrganizationPage() {
  const [token, setToken] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [form, setForm] = useState<Draft>(empty);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [ack, setAck] = useState(false);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const epoch = useRef(0),
    pending = useRef(false),
    abort = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      epoch.current++;
      abort.current?.abort();
    },
    [],
  );
  function clear() {
    epoch.current++;
    abort.current?.abort();
    setSnapshot(null);
    setForm(empty);
    setAck(false);
    setAnswer("");
    setQuestion("");
    setNotice("");
  }
  const dirty =
    !snapshot?.profile ||
    JSON.stringify(form) !== JSON.stringify(snapshot.profile.draft);
  async function request(action: "load" | "save" | "approve" | "preview") {
    if (pending.current || !token.trim() || (action !== "load" && !snapshot))
      return;
    if (action === "approve" && (!ack || dirty)) return;
    const current = ++epoch.current;
    const controller = new AbortController();
    abort.current = controller;
    pending.current = true;
    setBusy(true);
    setNotice("Working…");
    setAnswer("");
    setAck(false);
    const body =
      action === "save"
        ? { expectedUpdatedAt: snapshot!.updatedAt, draft: form }
        : action === "approve"
          ? { expectedUpdatedAt: snapshot!.updatedAt, acknowledged: true }
          : action === "preview"
            ? { expectedUpdatedAt: snapshot!.updatedAt, question }
            : undefined;
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const base =
        process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ??
        "http://localhost:3000";
      const response = await fetch(
        `${base}/organization/profile${action === "approve" || action === "preview" ? `/${action}` : ""}`,
        {
          method:
            action === "load" ? "GET" : action === "save" ? "PUT" : "POST",
          credentials: "omit",
          cache: "no-store",
          redirect: "error",
          referrerPolicy: "no-referrer",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${token.trim()}`,
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        },
      );
      if (!response.ok) throw new Error(String(response.status));
      const result = await response.json();
      if (current !== epoch.current) return;
      if (action === "preview") {
        if (
          result.mode !== "DETERMINISTIC_PREVIEW" ||
          typeof result.answer !== "string" ||
          result.actionsAuthorized !== false
        )
          throw new Error("invalid");
        setAnswer(result.answer);
        setNotice(
          result.matched
            ? "Exact approved FAQ match. Preview only; no action performed."
            : "No approved match. Human follow-up instructions shown; no callback task was created.",
        );
      } else {
        if (
          typeof result.updatedAt !== "string" ||
          result.runtimeConnected !== false ||
          !(result.profile === null || result.profile?.draft?.faqs)
        )
          throw new Error("invalid");
        setSnapshot(result);
        setForm(result.profile?.draft ?? structuredClone(empty));
        setNotice(
          action === "approve"
            ? "Saved version approved for preview. Live answering is not connected."
            : action === "save"
              ? "Draft saved. Existing approved version is unchanged."
              : "Organization loaded. Review facts before approval.",
        );
      }
    } catch (error) {
      if (current !== epoch.current) return;
      const code = error instanceof Error ? error.message : "";
      if (["401", "403"].includes(code)) {
        setToken("");
        setForm(empty);
      }
      setSnapshot(null);
      setNotice(
        code === "400"
          ? "Fields rejected. Check the required values, then reload before saving."
          : code === "409"
            ? "Version changed or approval is missing. Reload and review."
            : "Outcome unconfirmed or access unavailable. Reload before another save or approval.",
      );
    } finally {
      clearTimeout(timer);
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <main className={styles.shell}>
      <nav aria-label="CallDesk">
        <Link href="/" prefetch={false}>
          Signmons / CallDesk
        </Link>
        <a href="/app/intake-review">Customer intake review →</a>
      </nav>
      <header>
        <p className={styles.eyebrow}>Steel thread · organization setup</p>
        <h1>Teach Signmons about your business</h1>
        <p>
          Save your company facts and approved answers, then review the voice
          customers should hear.
        </p>
      </header>
      <p className={styles.boundary}>
        Owner/admin setup for an existing organization. Preview only: no live
        AI, booking, messages or provider changes. Do not enter secrets or
        customer information.
      </p>
      <section className={styles.connection} aria-label="Owner connection">
        <label>
          Operator ID token
          <input
            type="password"
            autoComplete="off"
            value={token}
            disabled={busy}
            onChange={(e) => {
              clear();
              setToken(e.target.value);
            }}
          />
        </label>
        <button
          disabled={busy || !token.trim()}
          onClick={() => request("load")}
        >
          Load organization
        </button>
        <button
          disabled={busy}
          onClick={() => {
            clear();
            setToken("");
          }}
        >
          Clear session
        </button>
      </section>
      <p role="status" aria-live="polite" className={styles.notice}>
        {notice}
      </p>
      {snapshot && (
        <>
          <section className={styles.boundary}>
            <h2>Operating rules stay authoritative</h2>
            <p>
              These descriptions do not change scheduling, coverage, payment or
              cancellation policy. Confirm consistency before approval.
              Automatic policy comparison is not implemented.
            </p>
            <a href="/app/routing">Review routing and availability</a> ·{" "}
            <a href="/app/messaging-settings">Review messaging settings</a>
            <p>
              Payment and cancellation policies require existing governed
              operator review; this form cannot override them.
            </p>
          </section>
          <fieldset disabled={busy} style={{ border: 0, padding: 0 }}>
            <legend>
              <h2>Company facts and brand voice</h2>
            </legend>
            <div className={styles.cards}>
              {fields.map((field) => (
                <label className={styles.card} key={field.key}>
                  {field.label}
                  <input
                    style={{ display: "block", width: "100%", padding: 12 }}
                    maxLength={field.max}
                    value={form[field.key]}
                    onChange={(e) => {
                      setForm({ ...form, [field.key]: e.target.value });
                      setAck(false);
                    }}
                  />
                </label>
              ))}
            </div>
            <label>
              Tone{" "}
              <select
                value={form.tone}
                onChange={(e) => {
                  setForm({ ...form, tone: e.target.value as Draft["tone"] });
                  setAck(false);
                }}
              >
                <option value="warm">Warm and helpful</option>
                <option value="concise">Clear and concise</option>
              </select>
            </label>
            <h2>Common questions</h2>
            {form.faqs.map((faq, index) => (
              <section
                className={styles.card}
                key={index}
                aria-label={`FAQ ${index + 1}`}
              >
                {(["question", "answer", "source"] as const).map((key) => (
                  <label key={key} style={{ display: "block" }}>
                    {key === "source"
                      ? "Approved source or accountable owner"
                      : key === "question"
                        ? "Question"
                        : "Answer"}
                    <input
                      style={{ display: "block", width: "100%", padding: 12 }}
                      maxLength={key === "answer" ? 1000 : 200}
                      value={faq[key]}
                      onChange={(e) => {
                        setForm({
                          ...form,
                          faqs: form.faqs.map((item, i) =>
                            i === index
                              ? { ...item, [key]: e.target.value }
                              : item,
                          ),
                        });
                        setAck(false);
                      }}
                    />
                  </label>
                ))}
                <button
                  disabled={form.faqs.length === 1}
                  onClick={() => {
                    setForm({
                      ...form,
                      faqs: form.faqs.filter((_, i) => i !== index),
                    });
                    setAck(false);
                  }}
                >
                  Remove FAQ {index + 1}
                </button>
              </section>
            ))}
            <button
              disabled={form.faqs.length >= 10}
              onClick={() => {
                setForm({
                  ...form,
                  faqs: [
                    ...form.faqs,
                    { question: "", answer: "", source: "" },
                  ],
                });
                setAck(false);
              }}
            >
              Add question
            </button>{" "}
            <button onClick={() => request("save")}>Save draft</button>
          </fieldset>
          <section className={styles.card}>
            <h2>Review and approve saved version</h2>
            <p>
              Approval records your identity and a version timestamp. Editing a
              draft does not update the approved answers. Only explicitly
              supported claims belong here.
            </p>
            <p>
              {snapshot.profile?.approved
                ? `Approved version: ${snapshot.profile.approved.approvedAt}`
                : "No approved version yet."}
            </p>
            <label>
              <input
                type="checkbox"
                checked={ack}
                disabled={busy || dirty}
                onChange={(e) => setAck(e.target.checked)}
              />{" "}
              I reviewed these saved facts, sources and instructions against
              company policy.
            </label>
            <p>
              <button
                disabled={busy || dirty || !ack}
                onClick={() => request("approve")}
              >
                Approve saved version
              </button>
            </p>
            {dirty && <p>Save changes before approval.</p>}
          </section>
          <section className={styles.card}>
            <h2>Try an approved answer</h2>
            <p>
              Exact question matching only. This tests the approved content, not
              an AI conversation. Unsaved/draft edits are never used.
            </p>
            <label>
              Customer question
              <input
                style={{ display: "block", width: "100%", padding: 12 }}
                maxLength={200}
                disabled={busy}
                value={question}
                onChange={(e) => {
                  setQuestion(e.target.value);
                  setAnswer("");
                }}
              />
            </label>
            <button
              disabled={busy || !snapshot.profile?.approved || !question.trim()}
              onClick={() => request("preview")}
            >
              Preview answer
            </button>
            <p aria-live="polite">{answer}</p>
          </section>
        </>
      )}
    </main>
  );
}
