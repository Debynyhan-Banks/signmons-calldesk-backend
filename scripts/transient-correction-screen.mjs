// Loopback-only, one-use presentation. Never writes address data to disk/logs.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const escape = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const safe = (s, max, empty = false) =>
  typeof s === "string" &&
  (empty || !!s.length) &&
  s.length <= max &&
  !/[\p{Cc}\p{Cf}]/u.test(s);
const valid = (a) =>
  a &&
  safe(a.street, 150) &&
  safe(a.unit, 30, true) &&
  safe(a.city, 60) &&
  /^\d{5}(-\d{4})?$/.test(a.postalCode);
const outcome = (status, address) => ({
  status,
  ...(address ? { address } : {}),
  addressVerified: false,
  admissionAuthorized: false,
  bookingAuthorized: false,
  deliveryAuthorized: false,
});

export async function showTransientCorrection(
  entered,
  candidate,
  { open, timeoutMs = 120000 } = {},
) {
  if (
    !valid(entered) ||
    candidate?.country !== "US" ||
    candidate?.state !== "OH" ||
    !Array.isArray(candidate.addressLines) ||
    candidate.addressLines.length < 1 ||
    candidate.addressLines.length > 2 ||
    !valid({
      street: candidate.addressLines[0],
      unit: candidate.addressLines[1] ?? "",
      city: candidate.city,
      postalCode: candidate.postalCode,
    }) ||
    typeof open !== "function" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 120000
  )
    return outcome("REFUSED");
  let original = { ...entered };
  let suggested = {
    street: candidate.addressLines[0],
    unit: candidate.addressLines[1] ?? "",
    city: candidate.city,
    postalCode: candidate.postalCode,
  };
  const key = randomBytes(24).toString("hex");
  let origin,
    timer,
    done = false,
    displayed = false,
    resolve;
  const result = new Promise((r) => {
    resolve = r;
  });
  const finish = (value) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    original = suggested = undefined;
    server.close();
    server.closeAllConnections();
    resolve(value);
  };
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    // Keep same-origin form Origin available; never send a referrer externally.
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (done || req.headers.host !== origin.slice(7) || req.url !== "/" + key) {
      res.writeHead(404).end();
      return;
    }
    if (req.method === "GET") {
      if (displayed) {
        res
          .writeHead(410)
          .end("Review expired or already displayed. No request was sent.");
        return;
      }
      displayed = true;
      const line = (a) =>
        [a.street, a.unit, a.city, "OH", a.postalCode, "US"]
          .filter(Boolean)
          .map(escape)
          .join(", ");
      const fields = Object.entries(original)
        .map(
          ([name, value]) =>
            `<label>${escape(name)}<input name="${escape(name)}" value="${escape(value)}" maxlength="150"></label>`,
        )
        .join("");
      res.end(
        `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Signmons address correction</title><style>body{font:18px system-ui;max-width:800px;margin:32px auto;padding:16px;color:#19394c;background:#f5f8fa} .comparison{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:24px}p{overflow-wrap:anywhere}label{display:block;margin:12px 0}input{display:block;box-sizing:border-box;width:100%;font:inherit}button{font:inherit;padding:12px;margin:8px 0}fieldset{margin:24px 0}</style><h1>Review your address correction</h1><p>Private, temporary review only. No address verification, payment, booking or message is authorized. Closing this tab or waiting two minutes cancels the review. Do not refresh.</p><div class="comparison"><section><h2>You entered</h2><p>${line(original)}</p></section><section><h2>Google suggested</h2><p>${line(suggested)}</p></section></div><form method="post" action="/${key}"><label><input type="checkbox" name="confirmed" value="yes">I reviewed the exact suggested address, including apartment/unit.</label><button name="action" value="confirm">Confirm suggested address</button><fieldset><legend>Or edit your entered address</legend>${fields}<p>State: Ohio. Country: United States.</p><button name="action" value="edit">Use my edited address for later review</button></fieldset><button name="action" value="cancel">Cancel correction</button></form><p>Confirming or editing does not send another Google request. Values are not saved by this tool.</p></html>`,
      );
      return;
    }
    if (
      req.method !== "POST" ||
      !displayed ||
      req.headers.origin !== origin ||
      req.headers["content-type"] !== "application/x-www-form-urlencoded"
    ) {
      res.writeHead(403).end();
      return;
    }
    let raw = "";
    try {
      for await (const chunk of req) {
        raw += chunk;
        if (Buffer.byteLength(raw) > 4096) {
          res.writeHead(413).end();
          return;
        }
      }
      if (done) {
        res.writeHead(410).end();
        return;
      }
      const data = new URLSearchParams(raw);
      if (
        [...new Set(data.keys())].some(
          (k) =>
            ![
              "action",
              "confirmed",
              "street",
              "unit",
              "city",
              "postalCode",
            ].includes(k),
        ) ||
        [...data.keys()].some((k) => data.getAll(k).length !== 1)
      ) {
        res.writeHead(400).end();
        return;
      }
      let value;
      if (data.get("action") === "cancel") value = outcome("CANCELLED");
      else if (
        data.get("action") === "confirm" &&
        data.get("confirmed") === "yes"
      )
        value = outcome("CONFIRMED", { ...suggested });
      else if (data.get("action") === "edit") {
        const edited = Object.fromEntries(
          ["street", "unit", "city", "postalCode"].map((k) => [
            k,
            (data.get(k) ?? "").trim(),
          ]),
        );
        if (valid(edited)) value = outcome("EDITED", edited);
      }
      if (!value) {
        res
          .writeHead(400)
          .end(
            "No selection accepted. Return to the previous screen to review, or close this tab. No request sent.",
          );
        return;
      }
      res.end(
        "Review closed. No new request, verification, payment, booking or message. You may close this tab.",
        () => finish(value),
      );
    } catch {
      finish(outcome("CANCELLED"));
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.on("error", () => finish(outcome("UNAVAILABLE")));
  await new Promise((resolveListen) => {
    server.once("error", resolveListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  if (done) return result;
  origin = "http://127.0.0.1:" + server.address().port;
  timer = setTimeout(() => finish(outcome("EXPIRED")), timeoutMs);
  Promise.resolve()
    .then(() => open(origin + "/" + key))
    .catch(() => finish(outcome("UNAVAILABLE")));
  return result;
}
