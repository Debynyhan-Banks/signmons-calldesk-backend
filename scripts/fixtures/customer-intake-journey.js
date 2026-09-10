// Local integrated fixture only. No provider, job creation or automatic retries.
(() => {
  const el = (id) => document.getElementById(id),
    fields = [
      "customerName",
      "phone",
      "address",
      "description",
      "issueCategory",
      "propertyType",
      "serviceIntent",
    ];
  let token,
    phoneRevision = 0,
    phoneLocked = false,
    phoneExpiryTimer,
    reviewedDraft,
    expires = 0,
    revision = 0,
    promptToken,
    email,
    step = "start",
    pending,
    busy = false,
    epoch = 0,
    controller,
    expiryTimer;
  const status = (value) => {
    el("status").textContent = value;
  };
  function paint() {
    el("phoneVerification").hidden =
      document.documentElement.dataset.phoneFixture !== "true";
    el("phone").readOnly = phoneLocked;
    for (const id of [
      "conversation",
      "email",
      "promptStep",
      "consent",
      "details",
      "preview",
      "submitted",
    ])
      el(id).hidden = step !== id;
    el("start").hidden = step !== "start" || busy;
    el("forget").hidden = !token && !busy;
    for (const control of document.querySelectorAll(
      "section input,section textarea,section select,section button",
    ))
      control.disabled = busy || !!pending;
    el("grant").disabled = busy || !!pending || !el("confirmed").checked;
    el("draft").disabled = busy || !!pending || !el("reviewed").checked;
    el("submitReview").hidden =
      document.documentElement.dataset.reviewSubmit !== "true" ||
      step !== "preview";
    el("retry").hidden = !pending || busy;
    el("retry").disabled = busy;
  }
  function clear(message) {
    epoch++;
    controller?.abort();
    clearTimeout(expiryTimer);
    clearTimeout(phoneExpiryTimer);
    phoneRevision = 0;
    phoneLocked = false;
    el("phoneStatus").textContent = "Not verified.";
    token = promptToken = email = pending = reviewedDraft = undefined;
    expires = revision = 0;
    step = "start";
    busy = false;
    for (const input of document.querySelectorAll("input,textarea")) {
      input.value = "";
      if (input.type === "checkbox") input.checked = false;
    }
    for (const select of document.querySelectorAll("select"))
      select.selectedIndex = 0;
    for (const id of [
      "reply",
      "mailbox",
      "permissionText",
      "summary",
      "requestReceipt",
    ])
      el(id).textContent = "";
    status(message);
    paint();
  }
  function alive() {
    if (!token || Date.now() >= expires) {
      clear(
        "Session expired or unavailable. Private state cleared. Start explicitly; contact the office for an existing appointment.",
      );
      return false;
    }
    return true;
  }
  function toDetails() {
    promptToken = undefined;
    el("mailbox").textContent = el("permissionText").textContent = "";
    step = "details";
  }
  async function run() {
    if (busy || !pending) return;
    const request = pending,
      generation = epoch,
      abort = new AbortController();
    controller = abort;
    busy = true;
    paint();
    const timeout = setTimeout(() => abort.abort(), 15000);
    try {
      const response = await fetch("/customer-session/" + request.operation, {
        method: "POST",
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        signal: abort.signal,
        headers: {
          "Content-Type": "application/json",
          "X-CallDesk-Request": "customer-intake-v1",
        },
        body: JSON.stringify(request.body),
      });
      if (!response.ok) throw { status: response.status };
      const raw = await response.text();
      if (raw.length > 16384) throw Error("Invalid response");
      const value = JSON.parse(raw);
      if (generation !== epoch) return;
      if (request.operation !== "start" && !alive()) return;
      if (value.deliveryAuthorized !== false) throw Error("Invalid receipt");
      switch (request.operation) {
        case "phone": {
          if (
            value.fixtureOnly !== true ||
            value.phoneAccessAuthorized !== false ||
            value.bookingAuthorized !== false ||
            !Number.isSafeInteger(value.revision) ||
            ![
              "EMPTY",
              "PENDING",
              "FIXTURE_VERIFIED",
              "EXPIRED",
              "EXHAUSTED",
            ].includes(value.state) ||
            !Number.isSafeInteger(value.expiresAt) ||
            !Number.isSafeInteger(value.retryAt)
          )
            throw Error("Invalid phone receipt");
          phoneRevision = value.revision;
          phoneLocked = value.state !== "EMPTY";
          el("phoneCode").value = "";
          clearTimeout(phoneExpiryTimer);
          el("phoneStatus").textContent =
            value.state === "FIXTURE_VERIFIED"
              ? "Test verification complete. Real phone access is NOT verified; no booking or sending permission."
              : value.state === "EMPTY"
                ? "Previous test proof cleared. Enter the corrected phone number."
                : value.state === "PENDING"
                  ? "Enter test code 123456. A wrong code uses an attempt. Resend is available after " +
                    new Date(value.retryAt).toLocaleTimeString() +
                    "."
                  : "Test challenge " +
                    value.state.toLowerCase() +
                    ". Request a new code when allowed or change the number.";
          if (value.expiresAt > Date.now())
            phoneExpiryTimer = setTimeout(() => {
              el("phoneStatus").textContent =
                "Test proof/challenge expired. No phone access authority. Request a code again when allowed.";
            }, value.expiresAt - Date.now());
          break;
        }
        case "start": {
          const deadline = Date.parse(value.expiresAt);
          if (
            typeof value.sessionToken !== "string" ||
            !value.sessionToken ||
            value.sessionToken.length > 4096 ||
            !Number.isFinite(deadline) ||
            deadline <= Date.now() ||
            deadline > Date.now() + 900000
          )
            throw Error("Invalid session");
          token = value.sessionToken;
          expires = deadline;
          expiryTimer = setTimeout(
            () => alive(),
            Math.max(0, expires - Date.now()),
          );
          step = "conversation";
          break;
        }
        case "continue":
          if (
            typeof value.reply !== "string" ||
            !value.reply.trim() ||
            value.reply.length > 2000 ||
            value.revision !== revision + 1
          )
            throw Error("Invalid turn");
          el("reply").textContent = "Scripted reply: " + value.reply;
          revision = value.revision;
          el("description").value = request.body.message;
          step = "email";
          break;
        case "capture":
          if (value.status !== "captured") throw Error("Invalid capture");
          email = request.body.email;
          step = "promptStep";
          break;
        case "prompt":
          if (value.state === "completed") {
            toDetails();
            break;
          }
          if (
            value.state !== "prompt" ||
            value.mailbox !== email ||
            typeof value.prompt !== "string" ||
            !value.prompt ||
            value.prompt.length > 2000 ||
            typeof value.promptToken !== "string" ||
            value.promptToken.length > 4096
          )
            throw Error("Invalid prompt");
          promptToken = value.promptToken;
          el("mailbox").textContent = value.mailbox;
          el("permissionText").textContent = value.prompt;
          step = "consent";
          break;
        case "respond":
          if (value.state !== "recorded")
            throw Error("Invalid consent receipt");
          toDetails();
          break;
        case "draft":
          if (
            value.jobCreated !== false ||
            value.bookingAuthorized !== false ||
            value.requiresHumanReview !== true ||
            value.urgencyAssessment !== "NOT_PERFORMED" ||
            value.transcriptRevision !== revision ||
            !["NOT_RECORDED", "GRANTED", "DECLINED", "REVOKED"].includes(
              value.emailChoice,
            ) ||
            !value.draft ||
            Object.keys(value.draft).sort().join(",") !==
              [...fields].sort().join(",") ||
            fields.some((key) => value.draft[key] !== request.body.draft[key])
          )
            throw Error("Invalid draft");
          el("summary").textContent =
            fields.map((key) => key + ": " + value.draft[key]).join("\n") +
            "\nEmail choice: " +
            value.emailChoice +
            "\nUrgency: not assessed\nTranscript revision: " +
            revision;
          step = "preview";
          reviewedDraft = request.body.draft;
          break;
        case "submit":
          if (
            value.requestId !== request.body.requestId ||
            value.state !== "PENDING_REVIEW" ||
            Date.parse(value.expiresAt) !== expires ||
            value.jobCreated !== false ||
            value.bookingAuthorized !== false
          )
            throw Error("Invalid review receipt");
          el("requestReceipt").textContent =
            "Review reference: " +
            value.requestId +
            ". Review deadline: " +
            value.expiresAt;
          step = "submitted";
          break;
      }
      pending = undefined;
      status(
        step === "submitted"
          ? "Request saved for operator review. Nothing booked or sent."
          : step === "preview"
            ? "Draft validated for review only. Nothing booked or sent."
            : "Step completed privately. Sending remains disabled.",
      );
    } catch (error) {
      if (generation !== epoch) return;
      if (request.operation === "start")
        clear(
          "Start outcome unconfirmed. No automatic retry or adoption. Start a new request explicitly.",
        );
      else if (!alive()) return;
      else if (
        [400, 429].includes(error?.status) &&
        request.operation === "phone"
      ) {
        pending = undefined;
        el("phoneCode").value = "";
        el("phoneStatus").textContent =
          error.status === 429
            ? "Code requests or attempts are limited. Wait for the resend time; session limits may require starting later. No text was sent."
            : "Check the country-code phone number and six-digit code.";
      } else if (error?.status === 400 && request.operation === "draft") {
        pending = undefined;
        status(
          "Check the draft fields and phone country code. No draft was saved.",
        );
      } else if ([400, 401, 403, 409, 413, 415].includes(error?.status))
        clear(
          "Request refused or session changed. Private state cleared. No automatic restart; contact the office if needed.",
        );
      else
        status(
          "Outcome unconfirmed. Retry this exact request only, or clear the session. Earlier steps may already be saved.",
        );
    } finally {
      clearTimeout(timeout);
      if (generation === epoch) {
        busy = false;
        controller = undefined;
        paint();
      }
    }
  }
  function submit(operation, body) {
    if (busy || pending || (operation !== "start" && !alive())) return;
    pending = Object.freeze({ operation, body });
    void run();
  }
  el("start").onclick = () => {
    if (!busy) {
      clear("");
      submit("start", {});
    }
  };
  for (const [id, action] of [
    ["phoneRequest", "request"],
    ["phoneCheck", "check"],
    ["phoneChange", "clear"],
  ]) {
    el(id).onclick = () =>
      submit("phone", {
        sessionToken: token,
        action,
        operationId: crypto.randomUUID(),
        expectedRevision: phoneRevision,
        phone: action === "clear" ? "" : el("phone").value.trim(),
        code: action === "check" ? el("phoneCode").value.trim() : "",
      });
  }
  el("continue").onclick = () => {
    const message = el("message").value.trim();
    if (!message || message.length > 400) {
      status("Enter a fictional issue up to 400 characters.");
      return;
    }
    submit("continue", {
      sessionToken: token,
      interactionId: crypto.randomUUID(),
      message,
    });
  };
  el("capture").onclick = () =>
    submit("capture", {
      sessionToken: token,
      email: el("mailboxInput").value.trim(),
    });
  el("skip").onclick = () => {
    if (!busy && !pending && alive()) {
      email = undefined;
      el("mailboxInput").value = "";
      toDetails();
      status("Email skipped. No consent recorded.");
      paint();
    }
  };
  el("prompt").onclick = () => submit("prompt", { sessionToken: token });
  el("confirmed").onchange = paint;
  el("reviewed").onchange = paint;
  for (const [id, response] of [
    ["grant", "GRANTED"],
    ["decline", "DECLINED"],
  ])
    el(id).onclick = () =>
      submit("respond", {
        sessionToken: token,
        promptToken,
        response,
        mailboxConfirmed: el("confirmed").checked,
      });
  el("draft").onclick = () => {
    if (!el("reviewed").checked) return;
    const draft = Object.freeze(
      Object.fromEntries(fields.map((key) => [key, el(key).value.trim()])),
    );
    submit("draft", { sessionToken: token, expectedRevision: revision, draft });
  };
  el("retry").onclick = () => {
    if (!busy && pending && alive()) void run();
  };
  el("submitReview").onclick = () => {
    if (
      step !== "preview" ||
      !reviewedDraft ||
      document.documentElement.dataset.reviewSubmit !== "true"
    )
      return;
    submit("submit", {
      sessionToken: token,
      requestId: crypto.randomUUID(),
      expectedRevision: revision,
      draft: reviewedDraft,
      confirmed: true,
    });
  };
  el("forget").onclick = () =>
    clear(
      "Private state cleared. Prior saved conversation and consent are not undone.",
    );
  window.addEventListener("pagehide", () => clear(""));
  paint();
})();
