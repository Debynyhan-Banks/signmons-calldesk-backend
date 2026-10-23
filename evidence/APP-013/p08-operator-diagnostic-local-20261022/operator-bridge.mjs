// Owner-approved local P08 proof/bridge. No user/IAM/token/payment launch CLI.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL(".", import.meta.url));
export const plan = JSON.parse(readFileSync(root + "plan.json", "utf8"));
const require = createRequire(plan.backend + "/package.json");
const { profile } = require(
  plan.backend + "/dist/tenants/organization-payment-policy.js",
);
export const uuid = (v) =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    v,
  );
export class BoundaryError extends Error {
  constructor(code, status = 409) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
const refuse = (ok, code, status) => {
  if (!ok) throw new BoundaryError(code, status);
};
export function qualifyActor(claims, user, tenant = plan.tenantId) {
  refuse(uuid(claims?.sub), "ACTOR_UUID_REQUIRED");
  refuse(
    claims.tenantId === tenant && !claims.impersonatedTenantId,
    "ACTOR_TENANT",
  );
  refuse(["owner", "admin"].includes(claims.role), "ACTOR_ROLE");
  refuse(
    user &&
      user.id === claims.sub &&
      user.tenantId === tenant &&
      user.status === "ACTIVE" &&
      ["OWNER", "ADMIN"].includes(user.role),
    "APPLICATION_ACTOR_REQUIRED",
  );
  return claims.sub;
}
export function normalizeDatabase(v, expected = plan) {
  refuse(
    v?.database === "neondb" && v.user === "neondb_owner",
    "DATABASE_IDENTITY",
  );
  refuse(
    v.roleCount === 1 &&
      v.roleClosed === true &&
      v.roleMemberships === 0 &&
      v.roleSessions === 0,
    "ROLE_BOUNDARY",
  );
  refuse(
    v.jobCount === 1 &&
      v.job?.id === expected.jobId &&
      v.job.tenantId === expected.tenantId,
    "EXACT_JOB",
  );
  const j = v.job,
    t = v.tenant;
  refuse(j.status === "CREATED" && j.deletedAt === null, "JOB_STATE");
  refuse(
    v.paymentCount === 0 &&
      v.calendarCount === 0 &&
      j.calendarEventId === null &&
      j.serviceWindowStart === null &&
      j.serviceWindowEnd === null,
    "ACTIVITY_PRESENT",
  );
  refuse(
    v.tenantCount === 1 &&
      t?.id === expected.tenantId &&
      t.status === "ACTIVE" &&
      t.chargesEnabled === true,
    "TENANT_STATE",
  );
  refuse(
    typeof t.stripeConnectAccountId === "string" &&
      /^acct_[A-Za-z0-9]+$/.test(t.stripeConnectAccountId),
    "ACCOUNT_FORMAT",
  );
  const accountHash = createHash("sha256")
    .update(t.stripeConnectAccountId)
    .digest("hex");
  refuse(accountHash === expected.connectedAccountSha256, "ACCOUNT_HASH");
  let approved;
  try {
    approved = profile(t.settings?.organizationPaymentPolicyV1)?.approved;
  } catch {
    throw new BoundaryError("APPROVED_POLICY_INVALID");
  }
  refuse(
    approved && Date.parse(approved.approvedAt) <= Date.now(),
    "APPROVED_POLICY_REQUIRED",
  );
  const digest = createHash("sha256")
    .update(JSON.stringify(approved))
    .digest("hex");
  const p = j.policySnapshot,
    a = p?.intakeAdmission;
  refuse(
    p &&
      a?.version === 2 &&
      a.actorId === "signmons-intake-admission-v1" &&
      a.humanReviewed !== true &&
      a.paymentApprovedAt === approved.approvedAt &&
      a.paymentDigest === digest,
    "CONTROLLED_POLICY_BINDING",
  );
  refuse(
    j.pricingSnapshot &&
      Object.keys(j.pricingSnapshot).length === 0 &&
      ![
        "paymentPolicyBinding",
        "depositRequired",
        "serviceFeeRequired",
        "paymentGateMode",
        "paymentGateException",
      ].some((k) => k in p),
    "EXISTING_TERMS",
  );
  const d = approved.draft;
  const amount =
    (d.serviceFeeRequired ? d.serviceFeeCents : 0) +
    (d.depositRequired ? d.depositPolicy.amountCents : 0);
  refuse(Number.isSafeInteger(amount) && amount > 0, "PAYMENT_AMOUNT_REQUIRED");
  refuse(
    v.actorCount === 1 && Array.isArray(v.actors) && v.actors.length === 1,
    "OPERATOR_SELECTION_REQUIRED",
  );
  const user = v.actors[0];
  qualifyActor(
    {
      sub: user.id,
      tenantId: expected.tenantId,
      role: user.role?.toLowerCase(),
    },
    user,
    expected.tenantId,
  );
  return {
    status: "QUALIFIED_DATABASE",
    actorId: user.id,
    actorRole: user.role.toLowerCase(),
    tenantId: expected.tenantId,
    jobId: expected.jobId,
    jobUpdatedAt: new Date(j.updatedAt).toISOString(),
    approvedAt: approved.approvedAt,
    policyDigest: digest,
    amountTotalCents: amount,
    currency: "usd",
    connectedAccountSha256: accountHash,
    roleClosed: true,
    businessMutation: false,
  };
}
export function qualifiedPaymentContext(v) {
  refuse(
    v?.status === "QUALIFIED_DATABASE" &&
      v.jobId === plan.jobId &&
      v.tenantId === plan.tenantId &&
      uuid(v.actorId) &&
      ["owner", "admin"].includes(v.actorRole),
    "QUALIFICATION_REQUIRED",
  );
  refuse(
    v.connectedAccountSha256 === plan.connectedAccountSha256 &&
      v.currency === "usd" &&
      Number.isSafeInteger(v.amountTotalCents) &&
      v.amountTotalCents > 0 &&
      /^[a-f0-9]{64}$/.test(v.policyDigest),
    "QUALIFICATION_MONEY",
  );
  refuse(
    Number.isFinite(Date.parse(v.approvedAt)) &&
      Number.isFinite(Date.parse(v.jobUpdatedAt)),
    "QUALIFICATION_VERSION",
  );
  return v;
}
export function createUpstream(transport, token, qualification, deadline) {
  const q = qualifiedPaymentContext(qualification);
  refuse(typeof token === "string" && token.length > 0, "AUTH_REQUIRED");
  const base = "/jobs/" + plan.jobId;
  const allow = new Map([
    ["GET " + base + "/payment-request", "read"],
    ["GET " + base + "/payment-events", "events"],
    ["GET /jobs/dispatch-board/" + plan.jobId, "detail"],
    ["POST /job-payment-policy/apply", "bind"],
    ["POST " + base + "/payment-requests", "create"],
    ["POST " + base + "/payment-request/recover", "recover"],
  ]);
  let reads = 0,
    creates = 0,
    recovers = 0,
    binds = 0;
  async function request(method, path, body, key) {
    refuse(Date.now() < deadline, "WORK_DEADLINE");
    const kind = allow.get(method + " " + path);
    refuse(kind, "ROUTE_NOT_ALLOWED", 403);
    if (kind === "read" || kind === "events" || kind === "detail")
      refuse(++reads <= 30, "READ_CEILING");
    if (kind === "bind") {
      refuse(++binds === 1, "BIND_CEILING");
      refuse(
        body?.jobId === q.jobId &&
          body.approvedAt === q.approvedAt &&
          body.acknowledged === true &&
          body.expectedUpdatedAt === q.jobUpdatedAt &&
          Object.keys(body).length === 4,
        "BIND_BODY",
      );
    }
    if (kind === "create") {
      refuse(++creates <= 2, "CREATE_CEILING");
      refuse(
        uuid(key) &&
          Object.keys(body ?? {}).length === 1 &&
          typeof body.expectedJobUpdatedAt === "string",
        "CREATE_BODY",
      );
    }
    if (kind === "recover") {
      refuse(
        ++recovers === 1 && body && Object.keys(body).length === 0,
        "RECOVERY_CEILING",
      );
    }
    const response = await transport(plan.origin + path, {
      method,
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      body: method === "POST" ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(
        Math.max(1, Math.min(15000, deadline - Date.now())),
      ),
      redirect: "error",
    });
    refuse(Date.now() < deadline, "WORK_DEADLINE");
    if (!response.ok)
      throw new BoundaryError(
        "UPSTREAM_HTTP_" + response.status,
        response.status,
      );
    const text = await response.text();
    refuse(Buffer.byteLength(text) <= 65536, "UPSTREAM_BODY_LIMIT");
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      throw new BoundaryError("UPSTREAM_JSON");
    }
    if (kind === "create" || kind === "recover") {
      const u = new URL(value.checkoutUrl);
      refuse(
        u.protocol === "https:" &&
          u.hostname === "checkout.stripe.com" &&
          !u.username &&
          !u.password,
        "CHECKOUT_ORIGIN",
      );
    }
    return value;
  }
  return {
    request,
    counts: () => ({ reads, creates, recovers, binds }),
    clear: () => {
      token = "";
    },
  };
}
const html = (csrf, nonce) =>
  `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Signmons attended Sandbox payment</title><style nonce="${nonce}">*{box-sizing:border-box}body{font:16px system-ui;background:#f3f5f9;color:#172033;margin:0;padding:20px}main{max-width:640px;margin:auto;background:white;padding:24px;border-radius:12px}button,a{display:inline-block;margin:8px 8px 0 0;padding:12px;font:inherit;max-width:100%}p{overflow-wrap:anywhere}label{display:block;margin:18px 0}button:disabled{opacity:.5}</style></head><body><main><h1>Attended Sandbox payment</h1><p>This internal test acts on one approved request. It cannot book or dispatch.</p><p id="money"></p><p id="state" role="status">Load the verified payment state.</p><label><input id="ack" type="checkbox"> I acknowledge the saved payment policy.</label><button id="read">Read verified status</button><button id="bind">Apply saved payment policy</button><button id="create">Create secure payment request</button><button id="recover">Recover active payment request</button><a id="checkout" hidden target="_blank" rel="noopener noreferrer">Open secure Sandbox Checkout</a><button id="clear">Clear private session</button></main><script nonce="${nonce}">const csrf=${JSON.stringify(csrf)};let busy=false,closed=false;const el=id=>document.getElementById(id);function paint(v){el('state').textContent=v.message;el('money').textContent=v.amountTotalCents?('Approved amount: USD '+(v.amountTotalCents/100).toFixed(2)):'';if(v.checkoutUrl){el('checkout').href=v.checkoutUrl;el('checkout').hidden=false;}}async function act(action){if(busy||closed)return;busy=true;for(const b of document.querySelectorAll('button'))b.disabled=true;try{const r=await fetch('/action',{method:'POST',headers:{'Content-Type':'application/json','X-P08-CSRF':csrf},body:JSON.stringify({action,acknowledged:el('ack').checked}),credentials:'same-origin',cache:'no-store',redirect:'error'});const v=await r.json();paint(v);if(action==='clear'&&r.ok){closed=true;el('checkout').removeAttribute('href');el('checkout').hidden=true;el('ack').checked=false;}}catch{paint({message:'Outcome unavailable. Do not create another request; use supported recovery.'});}finally{busy=false;for(const b of document.querySelectorAll('button'))b.disabled=closed;}}for(const action of ['read','bind','create','recover','clear'])el(action).onclick=()=>act(action);</script></body></html>`;
export async function createOperatorBridge({
  qualification,
  token,
  transport,
  deadline,
  dropCreateResponse = false,
  onClose = () => {},
}) {
  const q = qualifiedPaymentContext(qualification);
  refuse(Number.isFinite(deadline) && deadline > Date.now(), "WORK_DEADLINE");
  refuse(typeof transport === "function", "TRANSPORT_REQUIRED");
  const upstream = createUpstream(transport, token, q, deadline),
    bootstrap = randomBytes(32).toString("hex"),
    session = randomBytes(32).toString("hex"),
    csrf = randomBytes(32).toString("hex"),
    nonce = randomBytes(20).toString("hex"),
    key = randomUUID();
  let bound = false,
    version = q.jobUpdatedAt,
    busy = false,
    closed = false,
    booted = false,
    checkoutUrl = null,
    created = false,
    createAttempted = false,
    cleanupFailure = false;
  const noStore = {
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
  };
  let origin;
  const respond = (res, status, value) => {
    res
      .writeHead(status, { ...noStore, "Content-Type": "application/json" })
      .end(JSON.stringify(value));
  };
  const message = (status, gate) =>
    status === "SUCCEEDED" && gate === "UNLOCKED"
      ? "Verified payment succeeded; payment gate cleared."
      : status === "FAILED"
        ? "Payment has not succeeded; payment gate remains locked."
        : status === "PENDING"
          ? "Payment pending; payment gate remains locked."
          : "Payment not requested; payment gate remains locked.";
  async function close() {
    if (!closed) {
      closed = true;
      checkoutUrl = null;
      upstream.clear();
      try {
        await onClose();
      } catch (e) {
        cleanupFailure = true;
        throw e;
      }
    }
  }
  const server = createServer(async (req, res) => {
    req.setTimeout(Math.max(1, Math.min(5000, deadline - Date.now())), () =>
      req.destroy(),
    );
    try {
      refuse(req.headers.host === new URL(origin).host, "HOST", 403);
      refuse(Date.now() < deadline, "WORK_DEADLINE", 410);
      if (
        req.method === "GET" &&
        req.url === "/s/" + bootstrap &&
        !booted &&
        !closed
      ) {
        booted = true;
        res
          .writeHead(303, {
            ...noStore,
            "Set-Cookie": `p08=${session}; HttpOnly; SameSite=Strict; Path=/`,
            Location: "/",
          })
          .end();
        return;
      }
      refuse(
        req.headers.cookie === `p08=${session}` && !closed,
        "SESSION_CLOSED",
        403,
      );
      if (req.method === "GET" && req.url === "/") {
        res
          .writeHead(200, {
            ...noStore,
            "Content-Type": "text/html; charset=utf-8",
          })
          .end(html(csrf, nonce));
        return;
      }
      refuse(
        req.method === "POST" && req.url === "/action",
        "ROUTE_NOT_ALLOWED",
        403,
      );
      refuse(
        req.headers.origin === origin &&
          req.headers["x-p08-csrf"] === csrf &&
          (!req.headers["sec-fetch-site"] ||
            req.headers["sec-fetch-site"] === "same-origin"),
        "ORIGIN_OR_CSRF",
        403,
      );
      refuse(
        req.headers["content-type"] === "application/json",
        "CONTENT_TYPE",
        415,
      );
      let text = "";
      for await (const chunk of req) {
        text += chunk;
        refuse(Buffer.byteLength(text) <= 1024, "BODY_LIMIT", 413);
      }
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        throw new BoundaryError("BODY_INVALID", 400);
      }
      refuse(
        body &&
          Object.keys(body).sort().join(",") === "acknowledged,action" &&
          typeof body.acknowledged === "boolean" &&
          ["read", "bind", "create", "recover", "clear"].includes(body.action),
        "BODY_INVALID",
        400,
      );
      refuse(!busy, "ACTION_IN_PROGRESS");
      busy = true;
      try {
        if (body.action === "clear") {
          await close();
          res.setHeader(
            "Set-Cookie",
            "p08=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/",
          );
          respond(res, 200, {
            message:
              "Private session cleared. Committed payment state is unchanged.",
          });
          return;
        }
        if (body.action === "bind") {
          refuse(body.acknowledged && !bound, "POLICY_ACKNOWLEDGMENT");
          const r = await upstream.request(
            "POST",
            "/job-payment-policy/apply",
            {
              jobId: q.jobId,
              expectedUpdatedAt: version,
              approvedAt: q.approvedAt,
              acknowledged: true,
            },
          );
          refuse(
            r.jobId === q.jobId &&
              r.policyBound === true &&
              !r.paymentInitiated &&
              !r.bookingAuthorized &&
              !r.deliveryAuthorized,
            "BIND_RESPONSE",
          );
          version = r.updatedAt;
          bound = true;
          respond(res, 200, {
            message:
              "Saved payment policy applied; payment gate remains locked.",
            amountTotalCents: q.amountTotalCents,
          });
          return;
        }
        if (body.action === "create") {
          refuse(bound && !createAttempted, "ONE_LOGICAL_REQUEST");
          createAttempted = true;
          const r = await upstream.request(
            "POST",
            "/jobs/" + q.jobId + "/payment-requests",
            { expectedJobUpdatedAt: version },
            key,
          );
          created = true;
          checkoutUrl = r.checkoutUrl;
          if (dropCreateResponse) {
            dropCreateResponse = false;
            respond(res, 503, {
              message:
                "Request outcome uncertain. Recover the existing active payment request.",
            });
            return;
          }
          respond(res, 200, {
            message: "Secure customer payment request created.",
            checkoutUrl,
            amountTotalCents: q.amountTotalCents,
          });
          return;
        }
        if (body.action === "recover") {
          refuse(bound, "POLICY_REQUIRED");
          const r = await upstream.request(
            "POST",
            "/jobs/" + q.jobId + "/payment-request/recover",
            {},
          );
          created = true;
          checkoutUrl = r.checkoutUrl;
          respond(res, 200, {
            message: "Recovered the existing active payment request.",
            checkoutUrl,
            amountTotalCents: q.amountTotalCents,
          });
          return;
        }
        const [p, d, e] = await Promise.all([
          upstream.request("GET", "/jobs/" + q.jobId + "/payment-request"),
          upstream.request("GET", "/jobs/dispatch-board/" + q.jobId),
          upstream.request("GET", "/jobs/" + q.jobId + "/payment-events"),
        ]);
        refuse(d.jobId === q.jobId, "TRACKING_JOB");
        if (p.currency !== null && p.currency !== undefined)
          refuse(p.currency === "usd", "TRACKING_CURRENCY");
        if (p.amountTotalCents !== null && p.amountTotalCents !== undefined)
          refuse(p.amountTotalCents === q.amountTotalCents, "TRACKING_AMOUNT");
        refuse(
          [
            "NOT_REQUESTED",
            "PENDING",
            "FAILED",
            "SUCCEEDED",
            "CANCELED",
            "REFUNDED",
          ].includes(p.status) &&
            ["LOCKED", "UNLOCKED", "NOT_REQUIRED"].includes(
              d.paymentGate?.state,
            ) &&
            Array.isArray(e),
          "TRACKING_CONTRACT",
        );
        if (bound)
          refuse(
            p.status === "SUCCEEDED"
              ? d.paymentGate.state === "UNLOCKED"
              : d.paymentGate.state === "LOCKED",
            "PAYMENT_GATE_MISMATCH",
          );
        respond(res, 200, {
          message: bound
            ? message(p.status, d.paymentGate.state)
            : "Saved payment policy is not attached; payment readiness remains unverified.",
          amountTotalCents: q.amountTotalCents,
          paymentStatus: p.status,
          paymentGate: d.paymentGate.state,
          events: e.map((x) => ({
            type: x.type,
            processingStatus: x.processingStatus,
          })),
          ...(checkoutUrl ? { checkoutUrl } : {}),
        });
      } finally {
        busy = false;
      }
    } catch (e) {
      respond(res, e instanceof BoundaryError ? e.status : 503, {
        message:
          e instanceof BoundaryError
            ? "Operation refused: " + e.code
            : "Operation unavailable. Keep the existing request; do not retry blindly.",
      });
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = "http://127.0.0.1:" + server.address().port;
  const timer = setTimeout(
    () => {
      close()
        .catch(() => {})
        .finally(() => {
          server.close();
          server.closeAllConnections();
        });
    },
    Math.max(1, deadline - Date.now()),
  );
  timer.unref();
  return {
    origin,
    bootstrapUrl: origin + "/s/" + bootstrap,
    counts: upstream.counts,
    stop: async () => {
      clearTimeout(timer);
      await close();
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
    },
    state: () => ({ closed, bound, created, cleanupFailure }),
  };
}
async function stdin() {
  let data = "";
  for await (const chunk of process.stdin) {
    data += chunk;
    if (Buffer.byteLength(data) > 131072)
      throw new BoundaryError("INPUT_LIMIT");
  }
  return JSON.parse(data);
}
async function firebaseRead() {
  const { actorId, actorRole } = await stdin();
  refuse(uuid(actorId), "ACTOR_UUID_REQUIRED");
  const { execFileSync: authorize } = await import("node:child_process");
  let authority;
  try {
    authority = authorize(
      "/opt/homebrew/bin/python3",
      ["-B", root + "controller.py", "--authorize-helper"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15000 },
    );
  } catch {
    throw new BoundaryError("HELPER_READ_AUTHORITY_REQUIRED");
  }
  refuse(
    authority.trim() === "P08_HELPER_READ_AUTHORITY_MATCH",
    "HELPER_READ_AUTHORITY",
  );
  const qualified = JSON.parse(
    readFileSync(root + "database-qualification-private.json", "utf8"),
  );
  refuse(
    qualified.actorId === actorId && qualified.actorRole === actorRole,
    "HELPER_ACTOR_BINDING",
  );
  const { execFileSync } = await import("node:child_process");
  let access = "";
  try {
    access = execFileSync(
      "/opt/homebrew/bin/gcloud",
      ["auth", "print-access-token", "--account=debynyhan@signmons.com"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 15000,
        maxBuffer: 16384,
      },
    ).trim();
    const response = await fetch(
      "https://identitytoolkit.googleapis.com/v1/projects/signmons/accounts:lookup",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + access,
          "Content-Type": "application/json",
          "x-goog-user-project": "signmons",
        },
        body: JSON.stringify({ localId: [actorId] }),
        signal: AbortSignal.timeout(15000),
        redirect: "error",
      },
    );
    refuse(response.ok, "FIREBASE_HTTP_" + response.status);
    const text = await response.text();
    refuse(Buffer.byteLength(text) <= 65536, "FIREBASE_BODY_LIMIT");
    const v = JSON.parse(text);
    if (!v.users?.length) return { exists: false };
    refuse(v.users.length === 1, "FIREBASE_COUNT");
    const user = v.users[0];
    let claims;
    try {
      claims = JSON.parse(user.customAttributes ?? "{}");
    } catch {
      throw new BoundaryError("FIREBASE_CLAIMS");
    }
    return {
      exists: true,
      uidMatches: user.localId === actorId,
      disabled: user.disabled === true,
      tenantMatches: claims.tenantId === plan.tenantId,
      roleAllowed:
        claims.role === actorRole && ["owner", "admin"].includes(claims.role),
      stagingOnly: claims.stagingOnly === true,
      claimsExact:
        Object.keys(claims).sort().join(",") === "role,stagingOnly,tenantId",
    };
  } finally {
    access = "";
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === "--normalize")
      console.log(JSON.stringify(normalizeDatabase(await stdin())));
    else if (process.argv[2] === "--firebase-read")
      console.log(JSON.stringify(await firebaseRead()));
    else throw new BoundaryError("LIVE_BRIDGE_BINDING_REQUIRED");
  } catch (e) {
    console.log(
      JSON.stringify({
        status: "REFUSED",
        code: e instanceof BoundaryError ? e.code : "UNCONFIRMED",
      }),
    );
    process.exitCode = 1;
  }
}
