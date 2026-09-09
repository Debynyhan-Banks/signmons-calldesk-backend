// Fictional test UI only. Tokens stay in this page's memory, never URLs/storage.
let sessionToken,
  promptToken,
  busy = false;
const node = (id) => document.getElementById(id);
const clear = () => {
  sessionToken = promptToken = undefined;
  node("email").value = "";
  node("mailbox").textContent = "";
  node("prompt").textContent = "";
  node("address").hidden = node("permission").hidden = true;
  node("start").hidden = false;
};
const call = async (operation, body) => {
  const response = await fetch("/customer-session/" + operation, {
    method: "POST",
    mode: "cors",
    credentials: "omit",
    cache: "no-store",
    referrerPolicy: "no-referrer",
    headers: {
      "Content-Type": "application/json",
      "X-CallDesk-Request": "customer-intake-v1",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw Error("Request refused");
  return response.json();
};
const run = async (fn) => {
  if (busy) return;
  busy = true;
  try {
    await fn();
  } catch {
    clear();
    node("status").textContent =
      "Request unavailable. No automatic retry. Contact the office for an existing appointment.";
  } finally {
    busy = false;
  }
};
node("start").onclick = () =>
  run(async () => {
    clear();
    const result = await call("start", {});
    sessionToken = result.sessionToken;
    node("start").hidden = true;
    node("address").hidden = false;
    node("status").textContent = "";
  });
node("capture").onclick = () =>
  run(async () => {
    await call("capture", { sessionToken, email: node("email").value });
    const result = await call("prompt", { sessionToken });
    promptToken = result.promptToken;
    node("address").hidden = true;
    node("permission").hidden = false;
    node("mailbox").textContent = result.mailbox;
    node("prompt").textContent = result.prompt;
    node("confirmed").checked = false;
    node("grant").disabled = true;
  });
node("confirmed").onchange = () => {
  node("grant").disabled = !node("confirmed").checked;
};
const respond = (response) =>
  run(async () => {
    await call("respond", {
      sessionToken,
      promptToken,
      response,
      mailboxConfirmed: node("confirmed").checked,
    });
    clear();
    node("status").textContent =
      "Choice recorded privately. Sending remains disabled.";
  });
node("grant").onclick = () => respond("GRANTED");
node("decline").onclick = () => respond("DECLINED");
