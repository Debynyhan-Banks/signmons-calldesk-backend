"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  ApiError,
  RequestAuth,
  RoutingSnapshot,
  RoutingTimeScope,
  configureTechnicianRouting,
  getRoutingSnapshot,
  saveRoutingRule,
  saveServiceArea,
} from "@/lib/api";
import base from "../intake-review/intake-review.module.css";
import styles from "./routing.module.css";

type AuthMode = "firebase" | "dev";

export default function RoutingPage() {
  const hasDevAuth = Boolean(process.env.NEXT_PUBLIC_DEV_AUTH_SECRET);
  const [authMode, setAuthMode] = useState<AuthMode>(
    hasDevAuth ? "dev" : "firebase",
  );
  const [tenantId, setTenantId] = useState(
    process.env.NEXT_PUBLIC_TENANT_ID ?? "",
  );
  const [bearerToken, setBearerToken] = useState("");
  const [data, setData] = useState<RoutingSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const auth = useMemo<RequestAuth>(
    () =>
      authMode === "firebase"
        ? { bearerToken }
        : {
            devAuth: {
              secret: process.env.NEXT_PUBLIC_DEV_AUTH_SECRET ?? "",
              role: process.env.NEXT_PUBLIC_DEV_AUTH_ROLE ?? "dispatcher",
              userId:
                process.env.NEXT_PUBLIC_DEV_AUTH_USER_ID ?? "dev-dispatcher",
              tenantId,
            },
          },
    [authMode, bearerToken, tenantId],
  );
  const authReady =
    authMode === "firebase"
      ? Boolean(bearerToken.trim())
      : Boolean(hasDevAuth && tenantId.trim());

  const load = useCallback(async () => {
    if (!authReady) return;
    setLoading(true);
    setError(null);
    try {
      setData(await getRoutingSnapshot(auth, tenantId));
    } catch (caught) {
      setError(message(caught));
    } finally {
      setLoading(false);
    }
  }, [auth, authReady, tenantId]);

  useEffect(() => {
    if (hasDevAuth && tenantId) void load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const submitArea = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError(null);
    setNotice(null);
    try {
      await saveServiceArea(
        null,
        {
          name: String(form.get("name") ?? ""),
          status: "ACTIVE",
          postalCodes: String(form.get("postalCodes") ?? "")
            .split(/[\s,]+/)
            .filter(Boolean),
        },
        auth,
        tenantId,
      );
      event.currentTarget.reset();
      setNotice("Service area saved and audit logged.");
      await load();
    } catch (caught) {
      setError(message(caught));
    }
  };

  const submitRule = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const optional = (key: string) => String(form.get(key) ?? "") || undefined;
    setError(null);
    setNotice(null);
    try {
      await saveRoutingRule(
        null,
        {
          name: String(form.get("name") ?? ""),
          status: "ACTIVE",
          priority: Number(form.get("priority") ?? 100),
          serviceCategoryId: optional("serviceCategoryId"),
          serviceAreaId: optional("serviceAreaId"),
          urgency: optional("urgency") as
            | "STANDARD"
            | "HIGH"
            | "EMERGENCY"
            | undefined,
          timeScope: String(form.get("timeScope") ?? "ANY") as RoutingTimeScope,
          requireAvailable: true,
          requireOnCall: form.get("requireOnCall") === "on",
          escalateToOwner: form.get("escalateToOwner") === "on",
          escalateToOnCall: form.get("escalateToOnCall") === "on",
        },
        auth,
        tenantId,
      );
      event.currentTarget.reset();
      setNotice("Routing rule saved and audit logged.");
      await load();
    } catch (caught) {
      setError(message(caught));
    }
  };

  const toggleTech = async (
    tech: RoutingSnapshot["technicians"][number],
    field: "isAvailable" | "isOnCall",
  ) => {
    setError(null);
    setNotice(null);
    try {
      await configureTechnicianRouting(
        tech.id,
        {
          isAvailable:
            field === "isAvailable" ? !tech.isAvailable : tech.isAvailable,
          isOnCall: field === "isOnCall" ? !tech.isOnCall : tech.isOnCall,
          capabilities: tech.serviceCapabilities,
        },
        auth,
        tenantId,
      );
      setNotice(`${tech.fullName}'s routing status was updated.`);
      await load();
    } catch (caught) {
      setError(message(caught));
    }
  };

  return (
    <main className={base.shell}>
      <aside className={base.nav}>
        <a className={base.brand} href="/">
          <span className={base.mark}>S</span>
          <span>
            <strong>Signmons</strong>
            <small>CallDesk</small>
          </span>
        </a>
        <nav aria-label="CallDesk">
          <a className={base.disabledNav} href="/app/intake-review">
            <span>01</span> Intake review
          </a>
          <a className={base.disabledNav} href="/app/urgency-review">
            <span>02</span> Urgency review
          </a>
          <a className={base.disabledNav} href="/app/dispatch">
            <span>03</span> Dispatch board
          </a>
          <a className={base.activeNav} href="/app/routing">
            <span>04</span> Routing rules
          </a>
        </nav>
        <div className={base.navFooter}>
          <span className={base.liveDot} /> Tenant-controlled policy
        </div>
      </aside>
      <section className={base.workspace}>
        <header className={base.topbar}>
          <div>
            <p className={base.eyebrow}>Operations / Routing</p>
            <h1>Routing control center</h1>
            <p>
              Define where you work, who is available and how emergencies
              escalate.
            </p>
          </div>
          <div className={base.connectionPanel}>
            <div
              className={base.authTabs}
              role="group"
              aria-label="Authentication mode"
            >
              <button
                className={authMode === "firebase" ? base.authActive : ""}
                onClick={() => setAuthMode("firebase")}
                type="button"
              >
                Operator token
              </button>
              {hasDevAuth ? (
                <button
                  className={authMode === "dev" ? base.authActive : ""}
                  onClick={() => setAuthMode("dev")}
                  type="button"
                >
                  Local dev
                </button>
              ) : null}
            </div>
            <input
              aria-label={
                authMode === "firebase" ? "Operator token" : "Tenant ID"
              }
              onChange={(event) =>
                authMode === "firebase"
                  ? setBearerToken(event.target.value)
                  : setTenantId(event.target.value)
              }
              placeholder={
                authMode === "firebase" ? "Paste operator token" : "Tenant UUID"
              }
              type={authMode === "firebase" ? "password" : "text"}
              value={authMode === "firebase" ? bearerToken : tenantId}
            />
            <button
              disabled={!authReady || loading}
              onClick={() => void load()}
              type="button"
            >
              {loading ? "Loading…" : "Load routing"}
            </button>
          </div>
        </header>
        <div className={styles.content}>
          {error ? <div className={base.errorBanner}>{error}</div> : null}
          {notice ? <div className={styles.notice}>{notice}</div> : null}
          <section className={styles.metrics} aria-label="Routing status">
            <Metric
              label="Active rules"
              value={
                data?.rules.filter((rule) => rule.status === "ACTIVE").length ??
                0
              }
            />
            <Metric
              label="Service areas"
              value={
                data?.serviceAreas.filter((area) => area.status === "ACTIVE")
                  .length ?? 0
              }
            />
            <Metric
              label="Available techs"
              value={
                data?.technicians.filter((tech) => tech.isAvailable).length ?? 0
              }
            />
            <Metric
              label="On call now"
              value={
                data?.technicians.filter((tech) => tech.isOnCall).length ?? 0
              }
            />
          </section>
          <div className={styles.grid}>
            <section className={styles.panel}>
              <p className={base.eyebrow}>Coverage</p>
              <h2>Service areas</h2>
              <form onSubmit={submitArea}>
                <label>
                  Area name
                  <input
                    name="name"
                    placeholder="Greater Cleveland core"
                    required
                  />
                </label>
                <label>
                  ZIP codes
                  <textarea
                    name="postalCodes"
                    placeholder="44119, 44117, 44123"
                    required
                  />
                </label>
                <button disabled={!authReady} type="submit">
                  Add service area
                </button>
              </form>
              <div className={styles.list}>
                {data?.serviceAreas.map((area) => (
                  <article key={area.id}>
                    <strong>{area.name}</strong>
                    <span>{area.status}</span>
                    <small>
                      {area.definition.postalCodes?.join(", ") ??
                        "No ZIP codes"}
                    </small>
                  </article>
                ))}
              </div>
            </section>
            <section className={styles.panel}>
              <p className={base.eyebrow}>Policy</p>
              <h2>Routing rules</h2>
              <form onSubmit={submitRule}>
                <label>
                  Rule name
                  <input
                    name="name"
                    placeholder="After-hours heating"
                    required
                  />
                </label>
                <div className={styles.two}>
                  <label>
                    Priority
                    <input
                      defaultValue="100"
                      min="1"
                      name="priority"
                      type="number"
                    />
                  </label>
                  <label>
                    Time
                    <select name="timeScope">
                      <option value="ANY">Any time</option>
                      <option value="BUSINESS_HOURS">Business hours</option>
                      <option value="AFTER_HOURS">After hours</option>
                    </select>
                  </label>
                </div>
                <label>
                  Service
                  <select name="serviceCategoryId">
                    <option value="">All services</option>
                    {data?.serviceCategories.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Area
                  <select name="serviceAreaId">
                    <option value="">All active areas</option>
                    {data?.serviceAreas.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Urgency
                  <select name="urgency">
                    <option value="">Any urgency</option>
                    <option>STANDARD</option>
                    <option>HIGH</option>
                    <option>EMERGENCY</option>
                  </select>
                </label>
                <div className={styles.checks}>
                  <label>
                    <input name="requireOnCall" type="checkbox" /> Require
                    on-call tech
                  </label>
                  <label>
                    <input name="escalateToOwner" type="checkbox" /> Emergency →
                    owner
                  </label>
                  <label>
                    <input name="escalateToOnCall" type="checkbox" /> Emergency
                    → on-call
                  </label>
                </div>
                <button disabled={!authReady} type="submit">
                  Add routing rule
                </button>
              </form>
              <div className={styles.list}>
                {data?.rules.map((rule) => (
                  <article key={rule.id}>
                    <strong>{rule.name}</strong>
                    <span>Priority {rule.priority}</span>
                    <small>
                      {[
                        rule.serviceCategory?.name ?? "All services",
                        rule.serviceArea?.name ?? "All areas",
                        rule.urgency ?? "Any urgency",
                        rule.timeScope,
                      ].join(" · ")}
                    </small>
                  </article>
                ))}
              </div>
            </section>
          </div>
          <section className={styles.panel}>
            <p className={base.eyebrow}>People</p>
            <h2>Technician availability and on-call</h2>
            <div className={styles.techGrid}>
              {data?.technicians.map((tech) => (
                <article className={styles.tech} key={tech.id}>
                  <div>
                    <strong>{tech.fullName}</strong>
                    <small>
                      {
                        tech.serviceCapabilities.filter((cap) => cap.isEnabled)
                          .length
                      }{" "}
                      enabled capabilities
                    </small>
                  </div>
                  <button
                    className={tech.isAvailable ? styles.active : ""}
                    onClick={() => void toggleTech(tech, "isAvailable")}
                    type="button"
                  >
                    {tech.isAvailable ? "Available" : "Unavailable"}
                  </button>
                  <button
                    className={tech.isOnCall ? styles.onCall : ""}
                    onClick={() => void toggleTech(tech, "isOnCall")}
                    type="button"
                  >
                    {tech.isOnCall ? "On call" : "Not on call"}
                  </button>
                </article>
              ))}
            </div>
          </section>
        </div>
      </section>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <article>
      <strong>{value}</strong>
      <span>{label}</span>
    </article>
  );
}
function message(error: unknown) {
  return error instanceof ApiError || error instanceof Error
    ? error.message
    : "Routing request failed.";
}
