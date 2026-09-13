// Local operator-only policy setup. No provider calls or browser persistence.
(() => {
  const el = (id) => document.getElementById(id);
  let state,
    job,
    pending,
    busy = false,
    dirty = false,
    epoch = 0,
    abort;
  const ids = [
    "loadPolicy",
    "feeRequired",
    "feeCents",
    "depositRequired",
    "depositCents",
    "savePolicy",
    "policyAck",
    "approvePolicy",
    "applyPolicyAck",
    "applyPolicy",
  ];
  function paint() {
    for (const id of ids) el(id).disabled = busy || !!pending;
    el("savePolicy").disabled = busy || !!pending || !state;
    el("approvePolicy").disabled =
      busy || !!pending || !state?.policy || dirty || !el("policyAck").checked;
    el("applyPolicy").disabled =
      busy ||
      !!pending ||
      !state?.policy?.approved ||
      !job ||
      !el("applyPolicyAck").checked;
    el("retryPolicy").hidden = !pending;
    el("retryPolicy").disabled = busy;
  }
  function clear() {
    epoch++;
    abort?.abort();
    state = job = pending = undefined;
    busy = dirty = false;
    for (const id of [
      "feeRequired",
      "depositRequired",
      "policyAck",
      "applyPolicyAck",
    ])
      el(id).checked = false;
    el("feeCents").value = el("depositCents").value = "";
    el("policySnapshot").textContent = "";
    el("policySummary").textContent = "";
    el("policyStatus").textContent =
      "Private policy review cleared. Committed changes are not undone.";
    paint();
  }
  document.addEventListener("job-readiness", (e) => {
    if (!pending && !busy) {
      job = e.detail;
      el("applyPolicyAck").checked = false;
      paint();
    }
  });
  document.addEventListener("job-readiness-invalidated", () => {
    if (!pending && !busy) {
      job = undefined;
      el("applyPolicyAck").checked = false;
      paint();
    }
  });
  async function run() {
    if (busy || !pending) return;
    const request = pending,
      current = epoch;
    busy = true;
    paint();
    abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 15000);
    try {
      const response = await fetch(request.path, {
        method: request.method,
        headers: {
          Authorization: "Bearer " + request.token,
          "Content-Type": "application/json",
        },
        body: request.body ? JSON.stringify(request.body) : undefined,
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: abort.signal,
      });
      if (!response.ok) throw { status: response.status };
      const raw = await response.text();
      if (raw.length > 16384) throw Error();
      const value = JSON.parse(raw);
      if (current !== epoch) return;
      if (request.path === "/job-payment-policy/apply") {
        if (
          value.jobId !== request.body.jobId ||
          value.approvedAt !== request.body.approvedAt ||
          value.policyBound !== true ||
          value.bookingAuthorized !== false ||
          value.deliveryAuthorized !== false ||
          value.paymentInitiated !== false
        )
          throw Error();
        job = undefined;
        el("applyPolicyAck").checked = false;
        el("policyStatus").textContent =
          "Reviewed policy attached. No charge or booking. Reload job readiness.";
      } else {
        if (
          typeof value.updatedAt !== "string" ||
          value.runtimeConnected !== false ||
          !Object.hasOwn(value, "policy")
        )
          throw Error();
        state = value;
        const describe = (p) =>
          p
            ? "Service fee: " +
              (p.serviceFeeRequired
                ? p.serviceFeeCents + " USD cents"
                : "not required") +
              "; deposit: " +
              (p.depositRequired
                ? p.depositPolicy.amountCents + " USD cents"
                : "not required")
            : "none";
        el("policySummary").textContent =
          "Saved draft — " +
          describe(value.policy?.draft) +
          ". Approved — " +
          describe(value.policy?.approved?.draft) +
          ".";
        dirty = false;
        const p = value.policy?.draft;
        el("feeRequired").checked = p?.serviceFeeRequired ?? false;
        el("feeCents").value = p?.serviceFeeCents ?? "";
        el("depositRequired").checked = p?.depositRequired ?? false;
        el("depositCents").value = p?.depositPolicy?.amountCents ?? "";
        el("policyAck").checked = el("applyPolicyAck").checked = false;
        el("policySnapshot").textContent = JSON.stringify(
          {
            version: value.updatedAt,
            savedDraft: p ?? null,
            approved: value.policy?.approved ?? null,
          },
          null,
          2,
        );
        el("policyStatus").textContent =
          "Policy loaded/saved. Only the separately approved snapshot can be attached to a job.";
      }
      pending = undefined;
    } catch (error) {
      if (current !== epoch) return;
      if ([400, 401, 403, 404, 409, 413, 415].includes(error?.status)) {
        pending = undefined;
        state = job = undefined;
        el("policySnapshot").textContent = "";
        el("policySummary").textContent = "";
        el("policyStatus").textContent =
          "Refused or changed. Reload policy and job readiness before reviewing again.";
      } else
        el("policyStatus").textContent =
          "Outcome unconfirmed. Retry only this exact request; it may already be saved.";
    } finally {
      clearTimeout(timeout);
      if (current === epoch) {
        busy = false;
        paint();
      }
    }
  }
  function send(path, method, body) {
    if (busy || pending) return;
    const token = el("operatorToken").value.trim();
    if (!token) {
      el("policyStatus").textContent = "Enter your operator token first.";
      return;
    }
    pending = { path, method, body, token };
    void run();
  }
  el("loadPolicy").onclick = () => send("/organization/payment-policy", "GET");
  el("savePolicy").onclick = () => {
    if (!state) return;
    send("/organization/payment-policy", "PUT", {
      expectedUpdatedAt: state.updatedAt,
      draft: {
        currency: "usd",
        serviceFeeRequired: el("feeRequired").checked,
        serviceFeeCents: el("feeRequired").checked
          ? Number(el("feeCents").value)
          : null,
        depositRequired: el("depositRequired").checked,
        depositPolicy: el("depositRequired").checked
          ? { kind: "fixed", amountCents: Number(el("depositCents").value) }
          : { kind: "none" },
        emergencyFeePolicy: { kind: "none" },
        paymentGateMode: "fail_closed",
        webhookValidationRequired: true,
      },
    });
  };
  el("approvePolicy").onclick = () => {
    if (state && !dirty && el("policyAck").checked)
      send("/organization/payment-policy/approve", "POST", {
        expectedUpdatedAt: state.updatedAt,
        acknowledged: true,
      });
  };
  el("applyPolicy").onclick = () => {
    if (job && state?.policy?.approved && el("applyPolicyAck").checked)
      send("/job-payment-policy/apply", "POST", {
        jobId: job.jobId,
        expectedUpdatedAt: job.updatedAt,
        approvedAt: state.policy.approved.approvedAt,
        acknowledged: true,
      });
  };
  for (const id of [
    "feeRequired",
    "feeCents",
    "depositRequired",
    "depositCents",
  ])
    el(id).oninput = () => {
      dirty = true;
      el("policyAck").checked = false;
      paint();
    };
  for (const id of ["policyAck", "applyPolicyAck"]) el(id).onchange = paint;
  el("retryPolicy").onclick = () => void run();
  el("clear").addEventListener("click", clear);
  el("operatorToken").addEventListener("input", clear);
  el("requestId").addEventListener("input", () => {
    job = undefined;
    paint();
  });
  window.addEventListener("pagehide", clear);
  paint();
})();
