import type { RequestHandler } from "express";
import { managedRuntimeOrigin } from "./controlled-intake-runtime-config";
import {
  requestContextMiddleware,
  setAuthContext,
} from "../common/context/request-context";
import {
  CUSTOMER_BROWSER_HEADERS,
  CustomerConsentBrowserTransport,
} from "./customer-consent-browser-transport";

type ServerBinding = Readonly<{
  security?: object;
  tenantId: string;
  integrationId: string;
  transport: CustomerConsentBrowserTransport;
}>;

/** Mount before CORS and body parsers. Undefined binding is closed. Binding must
 * come from reviewed server composition, never headers/environment defaults.
 * Managed ingress requires an opaque validated startup binding, never a header.
 */
export function customerSessionHttp(binding?: ServerBinding): RequestHandler {
  const configured = binding ? Object.freeze({ ...binding }) : undefined;
  return (req, res, next) => {
    if (!/^\/customer-session(?:[/?]|$)/.test(req.url)) return next();
    const refuse = () => {
      if (!res.headersSent && !res.destroyed)
        res
          .status(503)
          .set(CUSTOMER_BROWSER_HEADERS)
          .json({ error: "Customer request refused." });
    };
    if (!configured) return refuse();
    const managedOrigin = managedRuntimeOrigin(configured.security);
    if (
      configured.security &&
      (!managedOrigin || req.headers.host !== new URL(managedOrigin).host)
    )
      return refuse();
    // This handler owns its errors and context; downstream Nest guards do not run.
    requestContextMiddleware(req, res, () => {
      setAuthContext({
        tenantId: configured.tenantId,
        userId: `integration:${configured.integrationId}`,
        role: "webchat_integration",
      });
      req.setTimeout(8000, () => req.destroy());
      void configured.transport
        .handleStream(
          {
            method: req.method,
            url: req.url,
            rawHeaders: req.rawHeaders,
            peerAddress: req.socket.remoteAddress ?? "",
            encrypted:
              Boolean(managedOrigin) ||
              ("encrypted" in req.socket && req.socket.encrypted === true),
          },
          req,
        )
        .then((result) => {
          if (!res.headersSent && !res.destroyed)
            res.status(result.status).set(result.headers).json(result.body);
        })
        .catch(refuse)
        .finally(() => req.setTimeout(0));
    });
  };
}
