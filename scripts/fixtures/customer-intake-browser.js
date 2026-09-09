// Fictional local fixture only; no deployed route or AI/tool adapter.
(() => {
  const el = (id) => document.getElementById(id);
  let token,
    expires = 0,
    revision = 0,
    pending,
    busy = false,
    generation = 0,
    controller,
    timer;
  const status = (text) => {
    el("status").textContent = text;
  };
  function paint() {
    el("start").hidden = !!token || busy;
    el("intake").hidden = !token;
    el("forget").hidden = !token && !busy;
    el("message").disabled = busy || !!pending;
    el("send").disabled = busy || !!pending;
    el("retry").hidden = !pending;
    el("retry").disabled = busy;
  }
  function clear(message) {
    generation++;
    controller?.abort();
    clearTimeout(timer);
    token = pending = undefined;
    expires = revision = 0;
    busy = false;
    el("message").value = "";
    el("turns").replaceChildren();
    status(message);
    paint();
  }
  function alive() {
    if (!token || Date.now() >= expires) {
      clear(
        "Session expired or unavailable. Private state cleared. Start a new request explicitly; contact the office for an existing appointment.",
      );
      return false;
    }
    return true;
  }
  async function post(operation, body, signal) {
    const response = await fetch("/customer-session/" + operation, {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      signal,
      headers: {
        "Content-Type": "application/json",
        "X-CallDesk-Request": "customer-intake-v1",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw { status: response.status };
    const raw = await response.text();
    if (raw.length > 16384) throw Error("Invalid response");
    return JSON.parse(raw);
  }
  async function run(operation, body) {
    if (busy) return;
    const epoch = generation;
    busy = true;
    paint();
    const requestController = new AbortController();
    controller = requestController;
    const timeout = setTimeout(() => requestController.abort(), 15000);
    try {
      const value = await post(operation, body, requestController.signal);
      if (epoch !== generation) return;
      if (operation === "start") {
        const deadline = Date.parse(value.expiresAt);
        if (
          Object.keys(value).sort().join(",") !==
            "deliveryAuthorized,expiresAt,sessionToken" ||
          value.deliveryAuthorized !== false ||
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
        timer = setTimeout(
          () => {
            alive();
          },
          Math.max(0, expires - Date.now()),
        );
        status("Private session started. Scripted replies only.");
      } else {
        if (!alive()) return;
        if (
          Object.keys(value).sort().join(",") !==
            "deliveryAuthorized,reply,revision" ||
          value.deliveryAuthorized !== false ||
          typeof value.reply !== "string" ||
          !value.reply.trim() ||
          value.reply.length > 2000 ||
          value.revision !== revision + 1
        )
          throw Error("Invalid receipt");
        const row = document.createElement("li");
        row.textContent =
          "You: " + pending.message + "\nScripted reply: " + value.reply;
        el("turns").append(row);
        revision = value.revision;
        pending = undefined;
        el("message").value = "";
        status(
          "Message saved privately. No appointment booked; sending remains disabled.",
        );
      }
    } catch (error) {
      if (epoch !== generation) return;
      if (operation === "start")
        clear(
          "Start outcome is unconfirmed. No automatic retry. Starting again creates a new request; contact the office for an existing appointment.",
        );
      else if (!alive()) return;
      else if ([400, 401, 403, 409, 413, 415].includes(error?.status))
        clear(
          error.status === 409
            ? "Conversation changed or is unavailable. Private state cleared. Do not resend blindly; contact the office or explicitly start a new request."
            : "Session or request refused. Private state cleared. Start a new request explicitly; contact the office for an existing appointment.",
        );
      else
        status(
          "Outcome unconfirmed. Nothing will retry automatically. Retry the same message only, or clear this session. A message may already be saved.",
        );
    } finally {
      clearTimeout(timeout);
      if (epoch === generation) {
        busy = false;
        controller = undefined;
        paint();
      }
    }
  }
  el("start").onclick = () => {
    if (busy) return;
    clear("");
    void run("start", {});
  };
  el("send").onclick = () => {
    if (busy || pending || !alive()) return;
    const message = el("message").value;
    if (!message.trim() || message.length > 2000) {
      status("Enter a message of at most 2000 characters.");
      return;
    }
    pending = Object.freeze({
      sessionToken: token,
      interactionId: crypto.randomUUID(),
      message,
    });
    void run("continue", pending);
  };
  el("retry").onclick = () => {
    if (!busy && pending && alive()) void run("continue", pending);
  };
  el("forget").onclick = () =>
    clear(
      "Private state cleared. This does not undo a saved message. No automatic restart.",
    );
  window.addEventListener("pagehide", () => clear(""));
  paint();
})();
