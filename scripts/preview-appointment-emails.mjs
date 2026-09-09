// Local-only fictional rendering. No application modules, database, env credentials or providers.
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const require = createRequire(import.meta.url);
const {
  composeAppointmentEmail,
  previewAppointmentEmail,
} = require("../dist/communications/appointment-email-template.js");

export function createEmailFixtureServer() {
  const base = {
    kind: "confirmed",
    tenantId: "11111111-1111-4111-8111-111111111111",
    jobId: "22222222-2222-4222-8222-222222222222",
    brandName: "Example Heating & Air",
    supportPhone: "+12025550123",
    serviceType: "HVAC diagnostic",
    status: "CONFIRMED",
    calendarOperationPending: false,
    calendarEventId: "fictional-event",
    windowStart: "2026-09-15T14:00:00.000Z",
    windowEnd: "2026-09-15T16:00:00.000Z",
    updatedAt: "2026-09-09T16:00:00.123Z",
  };
  const actions = {
    allowedManagementOrigin: "https://appointments.example.invalid",
    managementUrl:
      "https://appointments.example.invalid/appointment/manage#fictional_only_not_a_real_credential",
  };
  const pages = new Map();
  const cases = [
    base,
    {
      ...base,
      kind: "rescheduled",
      windowStart: "2026-09-16T14:00:00.000Z",
      windowEnd: "2026-09-16T16:00:00.000Z",
    },
    { ...base, kind: "cancelled", status: "CANCELLED", calendarEventId: null },
  ];
  for (const input of cases) {
    const email = composeAppointmentEmail(
      input,
      input.kind === "cancelled" ? undefined : actions,
    );
    const preview = previewAppointmentEmail(input);
    pages.set(`/${input.kind}/email`, ["text/html; charset=utf-8", email.html]);
    pages.set(`/${input.kind}/text`, ["text/plain; charset=utf-8", email.text]);
    pages.set(`/${input.kind}/operator`, [
      "text/html; charset=utf-8",
      preview.html,
    ]);
    if (email.calendar)
      pages.set(`/${input.kind}/appointment.ics`, [
        email.calendar.contentType,
        email.calendar.content,
      ]);
  }
  pages.set("/", [
    "text/html; charset=utf-8",
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Fictional appointment email previews</title></head><body style="font:18px/1.6 Arial,sans-serif;max-width:700px;margin:32px auto;padding:16px"><h1>Appointment email previews</h1><p>Fictional local fixtures only. No email is sent. Management links are not real credentials and must not be opened.</p>${cases.map(({ kind }) => `<h2>${kind}</h2><ul><li><a href="/${kind}/email">Customer HTML</a></li><li><a href="/${kind}/text">Plain text</a></li><li><a href="/${kind}/operator">Credential-free operator preview</a></li>${kind === "cancelled" ? "" : `<li><a href="/${kind}/appointment.ics" download="appointment.ics">Download fictional calendar copy</a></li>`}</ul>`).join("")}<p>Browser rendering does not prove Gmail, Outlook or Apple Mail compatibility. Calendar files are copies, not live synchronization.</p></body></html>`,
  ]);
  const counts = { GET: 0, HEAD: 0, refused: 0 };
  const server = createServer((req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    if (req.method !== "GET" && req.method !== "HEAD") {
      counts.refused++;
      res.writeHead(405).end();
      return;
    }
    counts[req.method]++;
    const entry = pages.get(req.url);
    if (!entry) {
      res.writeHead(404).end();
      return;
    }
    if (req.url.endsWith(".ics"))
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="appointment.ics"',
      );
    res.writeHead(200, { "Content-Type": entry[0] });
    res.end(req.method === "HEAD" ? undefined : entry[1]);
  });
  return { server, counts };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const { server } = createEmailFixtureServer();
  server.listen(0, "127.0.0.1", () =>
    console.log(
      `Fictional email previews only: http://127.0.0.1:${server.address().port}/`,
    ),
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => server.close());
}
