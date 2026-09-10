// Local operator UI: tokens/decisions are memory-only; no customer credentials.
(() => {
  const el = (id) => document.getElementById(id);
  const readinessLabel = (code) =>
    ({
      MISSING_customerName: "Customer name is missing",
      MISSING_phone: "Phone is missing",
      MISSING_serviceAddress: "Service address is missing",
      MISSING_serviceCategory: "Service category is missing",
      MISSING_issueSummary: "Issue summary is missing",
      MISSING_urgency: "Urgency review is missing",
      MISSING_preferredWindow: "Preferred service window is missing",
      PAYMENT_POLICY_UNRESOLVED: "Payment policy needs operator review",
      PAYMENT_REQUIRED_NOT_REQUESTED: "Required payment has not been requested",
      PAYMENT_PENDING: "Required payment is pending",
      PAYMENT_FAILED: "Required payment failed",
      PAYMENT_CANCELED: "Required payment was cancelled",
      PAYMENT_REFUNDED: "Required payment was refunded",
      PAYMENT_SUCCEEDED: "Payment is recorded as received",
      PAYMENT_EXCEPTION_APPROVED: "Payment exception is recorded",
      PAYMENT_NOT_REQUIRED: "Job policy records no payment requirement",
      HUMAN_REVIEW_REQUIRED: "Human intake review is required",
      CONTACT_NOT_VERIFIED: "Customer contact is not verified",
      ADDRESS_NOT_VERIFIED: "Service address is not verified",
      CALENDAR_REVIEW_REQUIRED:
        "An unresolved Calendar operation needs operator review",
    })[code] ?? code;
  let loaded,
    admittedJob,
    pending,
    busy = false,
    epoch = 0,
    controller,
    timer;
  const note = (text) => {
    el("status").textContent = text;
  };
  function paint() {
    el("openReadiness").disabled = busy || !admittedJob;
    for (const id of ["operatorToken", "requestId", "load", "urgency", "ack"])
      el(id).disabled = busy || !!pending;
    el("review").hidden = !loaded;
    el("approve").disabled =
      busy ||
      !!pending ||
      !loaded ||
      !el("ack").checked ||
      !["STANDARD", "HIGH", "EMERGENCY"].includes(el("urgency").value);
    el("retry").hidden = !pending;
    el("retry").disabled = busy;
  }
  function clear(
    message = "Private state cleared. Prior decisions are not undone.",
  ) {
    epoch++;
    controller?.abort();
    clearTimeout(timer);
    loaded = pending = undefined;
    admittedJob = undefined;
    el("readiness").hidden = true;
    el("readinessFacts").textContent = el("confirmationPreview").textContent =
      "";
    busy = false;
    el("operatorToken").value =
      el("requestId").value =
      el("urgency").value =
        "";
    el("ack").checked = false;
    el("facts").textContent =
      el("version").textContent =
      el("receipt").textContent =
        "";
    el("result").hidden = true;
    note(message);
    paint();
  }
  function invalidate() {
    admittedJob = undefined;
    el("readiness").hidden = true;
    el("readinessFacts").textContent = el("confirmationPreview").textContent =
      "";
    loaded = undefined;
    el("facts").textContent = el("version").textContent = "";
    el("ack").checked = false;
    el("result").hidden = true;
    el("receipt").textContent = "";
    clearTimeout(timer);
    paint();
  }
  async function run(action) {
    if (busy || (action === "read" && pending)) return;
    const token = el("operatorToken").value.trim();
    if (!token) return;
    if (action === "approve" && (!pending || Date.now() >= pending.expires)) {
      pending = undefined;
      invalidate();
      note(
        "Deadline passed. Check existing job history; no automatic replacement or retry.",
      );
      return;
    }
    const body =
      action === "read"
        ? { requestId: el("requestId").value.trim() }
        : pending.body;
    const current = epoch,
      abort = new AbortController();
    controller = abort;
    busy = true;
    paint();
    const timeout = setTimeout(() => abort.abort(), 15000);
    try {
      const response = await fetch("/intake-review-request/" + action, {
        method: "POST",
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: abort.signal,
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw { status: response.status };
      const raw = await response.text();
      if (raw.length > 16384) throw Error("Invalid receipt");
      const value = JSON.parse(raw);
      if (current !== epoch) return;
      if (
        value.requestId !== body.requestId ||
        value.bookingAuthorized !== false ||
        value.deliveryAuthorized !== false
      )
        throw Error("Invalid receipt");
      if (action === "read") {
        const expires = Date.parse(value.expiresAt);
        if (
          value.state !== "PENDING_REVIEW" ||
          value.jobCreated !== false ||
          value.requiresHumanReview !== true ||
          value.urgencyAssessment !== "NOT_PERFORMED" ||
          !value.draft ||
          !Number.isFinite(expires) ||
          expires <= Date.now() ||
          !Number.isFinite(Date.parse(value.organizationApprovedAt))
        )
          throw Error("Invalid review");
        const keys = [
          "customerName",
          "phone",
          "address",
          "description",
          "issueCategory",
          "propertyType",
          "serviceIntent",
        ];
        if (
          Object.keys(value.draft).sort().join(",") !==
            [...keys].sort().join(",") ||
          keys.some(
            (key) =>
              typeof value.draft[key] !== "string" ||
              value.draft[key].length > 2000,
          )
        )
          throw Error("Invalid draft");
        loaded = {
          requestId: value.requestId,
          organizationApprovedAt: value.organizationApprovedAt,
          expires,
        };
        el("facts").textContent = keys
          .map((key) => key + ": " + value.draft[key])
          .join("\n");
        el("version").textContent =
          "Organization approval: " +
          loaded.organizationApprovedAt +
          ". Review deadline: " +
          value.expiresAt;
        el("ack").checked = false;
        el("urgency").value = "";
        el("result").hidden = true;
        timer = setTimeout(
          () => {
            if (!busy) {
              pending = undefined;
              invalidate();
              note(
                "Review expired. Check existing job history before any replacement.",
              );
            }
          },
          Math.max(0, expires - Date.now()),
        );
        note(
          "Request loaded. Review facts and choose urgency before approval.",
        );
      } else {
        if (
          value.state !== "ADMITTED" ||
          value.jobCreated !== true ||
          value.status !== "CREATED" ||
          value.humanReviewed !== true ||
          !/^[0-9a-f-]{36}$/i.test(value.jobId) ||
          value.organizationApprovedAt !==
            pending.body.expectedOrganizationApprovedAt ||
          value.urgency !== pending.body.review.urgency ||
          !["BOUND", "NOT_RECORDED"].includes(value.consentEvidence)
        )
          throw Error("Invalid admission");
        pending = undefined;
        invalidate();
        el("receipt").textContent =
          "Job: " +
          value.jobId +
          "\nRequest: " +
          value.requestId +
          "\nStatus: CREATED\nConsent association: " +
          value.consentEvidence +
          " (not sending permission)";
        admittedJob = value.jobId;
        el("result").hidden = false;
        note(
          "One job created. No appointment, payment, dispatch or message was performed.",
        );
      }
    } catch (error) {
      if (current !== epoch) return;
      if ([400, 401, 403, 409, 413, 415].includes(error?.status)) {
        pending = undefined;
        invalidate();
        if ([401, 403].includes(error.status)) el("operatorToken").value = "";
        note(
          "Request refused, expired or changed. Check existing job history; no automatic replacement.",
        );
      } else if (action === "approve")
        note(
          "Approval outcome unconfirmed. Retry only this exact decision; a job may already exist.",
        );
      else {
        invalidate();
        note(
          "Review unavailable. Reload explicitly; no decision was submitted.",
        );
      }
    } finally {
      clearTimeout(timeout);
      if (current === epoch) {
        busy = false;
        controller = undefined;
        paint();
      }
    }
  }
  el("openReadiness").onclick = async () => {
    if (busy || !admittedJob) return;
    const current = epoch,
      jobId = admittedJob,
      abort = new AbortController();
    controller = abort;
    busy = true;
    paint();
    el("readiness").hidden = true;
    el("readinessFacts").textContent = el("confirmationPreview").textContent =
      "";
    const timeout = setTimeout(() => abort.abort(), 15000);
    try {
      const response = await fetch("/booking-readiness/preview", {
        method: "POST",
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: abort.signal,
        headers: {
          Authorization: "Bearer " + el("operatorToken").value.trim(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ jobId }),
      });
      if (!response.ok) throw Error("Read refused");
      const raw = await response.text();
      if (raw.length > 16384) throw Error("Invalid preview");
      const value = JSON.parse(raw);
      if (current !== epoch) return;
      if (
        value.jobId !== jobId ||
        value.status !== "CREATED" ||
        value.snapshotOnly !== true ||
        value.bookingAuthorized !== false ||
        value.deliveryAuthorized !== false ||
        !Array.isArray(value.blockers) ||
        value.blockers.some((x) => typeof x !== "string") ||
        value.confirmation?.eligible !== false ||
        value.confirmation?.state !== "UNAVAILABLE" ||
        typeof value.confirmation.preview !== "string"
      )
        throw Error("Invalid preview");
      el("readinessFacts").textContent =
        "Job: " +
        jobId +
        "\nVersion: " +
        value.jobUpdatedAt +
        "\nAssessment: " +
        value.assessment +
        "\nPayment: " +
        value.payment.state +
        " — " +
        readinessLabel(value.payment.reason) +
        "\nBlockers:\n" +
        value.blockers.map(readinessLabel).join("\n");
      el("confirmationPreview").textContent = value.confirmation.preview;
      el("readiness").hidden = false;
      note(
        "Read-only snapshot loaded. This is not permission to book or send.",
      );
    } catch {
      if (current === epoch)
        note(
          "Readiness unavailable or job changed. No action performed; reload or ask the operator to review the job.",
        );
    } finally {
      clearTimeout(timeout);
      if (current === epoch) {
        busy = false;
        paint();
      }
    }
  };
  el("load").onclick = () => {
    invalidate();
    void run("read");
  };
  el("approve").onclick = () => {
    if (
      !loaded ||
      pending ||
      busy ||
      !el("ack").checked ||
      !["STANDARD", "HIGH", "EMERGENCY"].includes(el("urgency").value)
    )
      return;
    pending = {
      expires: loaded.expires,
      body: {
        requestId: loaded.requestId,
        expectedOrganizationApprovedAt: loaded.organizationApprovedAt,
        review: {
          urgency: el("urgency").value,
          reasonCode: "OPERATOR_REVIEWED_INTAKE",
          acknowledgeCustomerStatements: true,
        },
      },
    };
    void run("approve");
  };
  el("retry").onclick = () => {
    void run("approve");
  };
  el("ack").onchange = el("urgency").onchange = paint;
  el("requestId").oninput = el("operatorToken").oninput = () => {
    epoch++;
    controller?.abort();
    invalidate();
  };
  el("clear").onclick = () => clear();
  window.addEventListener("pagehide", () => clear(""));
  paint();
})();
