// Local reviewed preference only. State stays in memory; no automatic retry.
(() => {
  const el = (id) => document.getElementById(id);
  let job,
    pending,
    busy = false,
    epoch = 0,
    abort;
  const note = (text) => (el("windowStatus").textContent = text);
  function paint() {
    el("windowReview").hidden = !job && !pending;
    for (const id of ["windowPreference", "windowAck"])
      el(id).disabled = busy || !!pending;
    el("saveWindow").disabled =
      busy ||
      !!pending ||
      !job ||
      !el("windowAck").checked ||
      !el("windowPreference").value.trim();
    el("retryWindow").hidden = !pending;
    el("retryWindow").disabled = busy;
  }
  function clear() {
    epoch++;
    abort?.abort();
    job = pending = undefined;
    busy = false;
    el("windowPreference").value = "";
    el("windowAck").checked = false;
    note("Private preference review cleared. Saved changes are not undone.");
    paint();
  }
  document.addEventListener("job-readiness", (e) => {
    if (busy || pending) return;
    job = { jobId: e.detail.jobId, updatedAt: e.detail.updatedAt };
    el("windowPreference").value = e.detail.preference ?? "";
    el("windowAck").checked = false;
    note("Review the customer preference before saving.");
    paint();
  });
  document.addEventListener("job-readiness-invalidated", () => {
    if (!busy && !pending) {
      job = undefined;
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
      const response = await fetch("/preferred-window-review/save", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + request.token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request.body),
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: abort.signal,
      });
      if (!response.ok) throw { status: response.status };
      const raw = await response.text();
      if (raw.length > 4096) throw Error();
      const value = JSON.parse(raw);
      if (current !== epoch) return;
      if (
        value.jobId !== request.body.jobId ||
        value.preference !== request.body.preference ||
        value.source !== "CUSTOMER_STATED_OPERATOR_REVIEW" ||
        !Number.isFinite(Date.parse(value.updatedAt)) ||
        value.availabilityChecked !== false ||
        value.bookingAuthorized !== false ||
        value.deliveryAuthorized !== false
      )
        throw Error();
      pending = undefined;
      job = undefined;
      el("windowAck").checked = false;
      el("windowPreference").value = "";
      document.dispatchEvent(new CustomEvent("window-review-saved"));
      note(
        "Preference saved, not booked. Reload job readiness before another review.",
      );
    } catch (error) {
      if (current !== epoch) return;
      if ([400, 401, 403, 404, 409, 413, 415].includes(error?.status)) {
        pending = undefined;
        job = undefined;
        el("windowPreference").value = "";
        el("windowAck").checked = false;
        document.dispatchEvent(new CustomEvent("window-review-refused"));
        note(
          "Refused or job changed. Reload readiness and review again. Saved work is not undone.",
        );
      } else
        note(
          "Save outcome unconfirmed. Retry only this exact preference; it may already be saved.",
        );
    } finally {
      clearTimeout(timeout);
      if (current === epoch) {
        busy = false;
        paint();
      }
    }
  }
  el("saveWindow").onclick = () => {
    if (busy || pending || !job || !el("windowAck").checked) return;
    const token = el("operatorToken").value.trim();
    if (!token) return;
    pending = {
      token,
      body: {
        jobId: job.jobId,
        expectedUpdatedAt: job.updatedAt,
        preference: el("windowPreference").value.trim(),
        acknowledged: true,
      },
    };
    void run();
  };
  el("retryWindow").onclick = () => void run();
  el("windowPreference").oninput = () => {
    el("windowAck").checked = false;
    paint();
  };
  el("windowAck").onchange = paint;
  for (const id of ["operatorToken", "requestId"])
    el(id).addEventListener("input", clear);
  el("clear").addEventListener("click", clear);
  window.addEventListener("pagehide", clear);
  paint();
})();
