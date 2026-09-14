import { createHash } from "node:crypto";
import type { RequestHandler } from "express";

/** Two immutable assets only. The runtime loader must supply reviewed packaged bytes.
 * Omission is closed; no filesystem routing, credentials or provider construction. */
export function customerIntakePage(assets?: {
  html: string;
  script: string;
}): RequestHandler {
  const html = assets?.html
    .replace(
      '<html lang="en">',
      '<html lang="en" data-controlled-intake="true">',
    )
    .replace('src="/journey.js"', 'src="/customer-intake.js"');
  const script = assets?.script;
  const styles = [...(html ?? "").matchAll(/<style>([\s\S]*?)<\/style>/g)].map(
    (match) =>
      `'sha256-${createHash("sha256").update(match[1]).digest("base64")}'`,
  );
  const csp = `default-src 'none'; script-src 'self'; style-src ${styles.length ? styles.join(" ") : "'none'"}; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
  return (req, res, next) => {
    if (req.url !== "/customer-intake" && req.url !== "/customer-intake.js")
      return next();
    res.set({
      "Cache-Control": "private, no-store, max-age=0",
      "Content-Security-Policy": csp,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
    });
    if (!html || !script) {
      res.status(503).end();
      return;
    }
    if (req.method !== "GET") {
      res.set("Allow", "GET").status(405).end();
      return;
    }
    res
      .type(req.url === "/customer-intake" ? "html" : "application/javascript")
      .send(req.url === "/customer-intake" ? html : script);
  };
}
