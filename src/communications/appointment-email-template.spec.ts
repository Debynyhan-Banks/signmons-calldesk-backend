import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  AppointmentEmailInputError,
  type AppointmentEmailSnapshot,
  composeAppointmentEmail,
  previewAppointmentEmail,
} from "./appointment-email-template";

const fixture = (
  patch: Partial<AppointmentEmailSnapshot> = {},
): AppointmentEmailSnapshot => ({
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
  ...patch,
});
const actions = {
  allowedManagementOrigin: "https://appointments.example.invalid",
  managementUrl:
    "https://appointments.example.invalid/appointment/manage#fictional_only_not_a_real_credential",
};
const cancelled = () =>
  fixture({ kind: "cancelled", status: "CANCELLED", calendarEventId: null });

describe("inactive appointment email composition", () => {
  it("renders fixed branded confirmation, Eastern window, reference, fallback and private actions", () => {
    const result = composeAppointmentEmail(fixture(), actions);
    expect(result.templateId).toBe("appointment_email:confirmed:v1");
    expect(result.templateVersion).toBe(1);
    expect(result.sensitivity).toBe("customer-private");
    expect(result.subject).toBe(
      "Example Heating & Air: Your appointment is confirmed",
    );
    expect(result.text).toContain(
      "Tue, Sep 15, 2026, 10:00 AM EDT to Tue, Sep 15, 2026, 12:00 PM EDT (Eastern Time)",
    );
    expect(result.text).toContain(fixture().jobId.toUpperCase());
    expect(result.text).toContain("call or text +12025550123");
    expect(result.text).toContain("Keep your appointment link private");
    expect(result.text).toContain(actions.managementUrl);
    expect(result.html).toContain(`href="${actions.managementUrl}"`);
    expect(result.html).toContain('name="referrer" content="no-referrer"');
    expect(result.calendar?.filename).toBe("appointment.ics");
  });
  it("renders a replacement window for reschedule with stable calendar identity", () => {
    const initial = composeAppointmentEmail(fixture(), actions);
    const updated = composeAppointmentEmail(
      fixture({
        kind: "rescheduled",
        windowStart: "2026-09-16T14:00:00.000Z",
        windowEnd: "2026-09-16T16:00:00.000Z",
        updatedAt: "2026-09-10T17:00:00.000Z",
      }),
      actions,
    );
    expect(updated.text).toContain("replaces the previous appointment window");
    expect(updated.text).not.toContain("Sep 15");
    expect(updated.text).toContain("Sep 16");
    const uid = (content: string) =>
      content.replace(/\r\n /g, "").match(/^UID:(.+)$/m)?.[1];
    expect(uid(updated.calendar!.content)).toBe(uid(initial.calendar!.content));
    expect(updated.calendar!.content).toContain("DTSTART:20260916T140000Z");
    expect(updated.calendar!.content).toContain("DTSTAMP:20260910T170000Z");
  });
  it("cancellation omits links and calendar, labels the old window and advises removal", () => {
    const result = composeAppointmentEmail(cancelled());
    expect(result.templateId).toBe("appointment_email:cancelled:v1");
    expect(result.calendar).toBeNull();
    expect(result.text).toContain("Previously scheduled window");
    expect(result.text).toContain("Remove any saved calendar copy");
    expect(result.text).not.toContain("Arrival window:");
    expect(result.html).not.toMatch(
      /href=|appointment\.ics|Manage appointment/,
    );
    expect(() => composeAppointmentEmail(cancelled(), actions)).toThrow(
      AppointmentEmailInputError,
    );
  });
  it.each([
    [
      "2026-01-15T15:00:00.000Z",
      "2026-01-15T17:00:00.000Z",
      "10:00 AM EST",
      "12:00 PM EST",
    ],
    [
      "2026-03-08T06:30:00.000Z",
      "2026-03-08T07:30:00.000Z",
      "1:30 AM EST",
      "3:30 AM EDT",
    ],
    [
      "2026-11-01T05:30:00.000Z",
      "2026-11-01T06:30:00.000Z",
      "1:30 AM EDT",
      "1:30 AM EST",
    ],
    [
      "2026-09-16T03:00:00.000Z",
      "2026-09-16T05:00:00.000Z",
      "Sep 15, 2026, 11:00 PM EDT",
      "Sep 16, 2026, 1:00 AM EDT",
    ],
  ])(
    "formats winter/DST/midnight boundaries %s",
    (windowStart, windowEnd, start, end) => {
      const result = composeAppointmentEmail(
        fixture({ windowStart, windowEnd }),
        actions,
      );
      expect(result.text).toContain(start);
      expect(result.text).toContain(end);
    },
  );
  it.each([
    { kind: null },
    { kind: 1 },
    { kind: {} },
    { kind: "constructor" },
    { kind: "unknown" },
    { status: "REQUESTED" },
    { status: "CANCELLED" },
    { calendarOperationPending: true },
    { calendarOperationPending: undefined },
    { calendarEventId: null },
    { calendarEventId: "" },
    { brandName: "" },
    { brandName: "a".repeat(101) },
    { brandName: "Bad\r\nBcc: private@example.invalid" },
    { brandName: "Bad\u202eBrand" },
    { serviceType: "bad\u0000input" },
    { serviceType: "  " },
    { supportPhone: "202-555-0123" },
    { supportPhone: "+12025550123?body=hello" },
    { tenantId: "other-tenant" },
    { jobId: "private-invalid-id" },
    { windowStart: "2026-02-30T14:00:00.000Z" },
    { windowStart: "2026-09-15T14:00:00Z" },
    { windowStart: "2026-09-15T10:00:00.000-04:00" },
    { windowEnd: "2026-09-15T14:00:00.000Z" },
    { windowEnd: "2026-09-15T13:00:00.000Z" },
    { windowStart: "2026-09-15T14:00:01.000Z" },
    { updatedAt: "not-a-date" },
  ])("refuses invalid or unconfirmed canonical input %j", (patch) => {
    expect(() =>
      composeAppointmentEmail(
        fixture(patch as Partial<AppointmentEmailSnapshot>),
        actions,
      ),
    ).toThrow(AppointmentEmailInputError);
  });
  it("refuses null snapshot and uncleared cancellation event", () => {
    expect(() =>
      composeAppointmentEmail(null as unknown as AppointmentEmailSnapshot),
    ).toThrow(AppointmentEmailInputError);
    expect(() =>
      composeAppointmentEmail({
        ...cancelled(),
        calendarEventId: "still-present",
      }),
    ).toThrow(AppointmentEmailInputError);
  });
  it.each([
    "javascript:alert(1)",
    "http://appointments.example.invalid/appointment/manage#fictional_only_not_a_real_credential",
    "https://evil.example.invalid/appointment/manage#fictional_only_not_a_real_credential",
    "https://appointments.example.invalid.evil.test/appointment/manage#fictional_only_not_a_real_credential",
    "https://user:pass@appointments.example.invalid/appointment/manage#fictional_only_not_a_real_credential",
    "https://appointments.example.invalid/appointment/manage?token=private-secret",
    "https://appointments.example.invalid/appointment/manage?utm_source=tracking#fictional_only_not_a_real_credential",
    "https://appointments.example.invalid/other#fictional_only_not_a_real_credential",
    "https://appointments.example.invalid/appointment/manage#short",
    "https://appointments.example.invalid/appointment/manage#bad%20fragment_value_long_enough",
    "https://appointments.example.invalid/appointment/manage#bad\nfragment_value_long_enough",
    "https://appointments.example.invalid/appointment/manage",
  ])(
    "rejects unsafe/wrong-origin management action without disclosing it",
    (managementUrl) => {
      expect(() =>
        composeAppointmentEmail(fixture(), { ...actions, managementUrl }),
      ).toThrow("Appointment email inputs are invalid or not eligible.");
    },
  );
  it("requires a bare HTTPS server-approved origin and an active action", () => {
    for (const allowedManagementOrigin of [
      "http://appointments.example.invalid",
      "https://appointments.example.invalid/",
      "https://appointments.example.invalid?x=1",
      "bad-origin",
    ]) {
      expect(() =>
        composeAppointmentEmail(fixture(), {
          ...actions,
          allowedManagementOrigin,
        }),
      ).toThrow(AppointmentEmailInputError);
    }
    expect(() => composeAppointmentEmail(fixture())).toThrow(
      AppointmentEmailInputError,
    );
  });
  it("escapes HTML and calendar text; folds by UTF-8 octets without broken code points", () => {
    const result = composeAppointmentEmail(
      fixture({
        brandName: 'Example <img src=x> & "Air"',
        serviceType: "測試🔥".repeat(15) + "; fan, coil\\check",
      }),
      actions,
    );
    expect(result.html).toContain("&lt;img src=x&gt;");
    expect(result.html).not.toContain("<img");
    const calendar = result.calendar!.content;
    for (const line of calendar.split("\r\n"))
      expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
    expect(Buffer.from(calendar).toString("utf8")).toBe(calendar);
    const unfolded = calendar.replace(/\r\n /g, "");
    expect(unfolded).toContain("\\; fan\\, coil\\\\check");
    expect(unfolded).not.toContain("\ufffd");
  });
  it("calendar has required RFC 5545 fields and no secret link, recipient, provider ID or location", () => {
    const content = composeAppointmentEmail(
      fixture(),
      actions,
    ).calendar!.content.replace(/\r\n /g, "");
    for (const line of [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "DTSTAMP:20260909T160000Z",
      "DTSTART:20260915T140000Z",
      "DTEND:20260915T160000Z",
      "CLASS:PRIVATE",
      "END:VEVENT",
      "END:VCALENDAR",
    ])
      expect(content).toContain(line + "\r\n");
    expect(content).toMatch(/UID:[a-f0-9]{64}@appointments.signmons\r\n/);
    expect(content).not.toMatch(
      /METHOD:|ATTENDEE|ORGANIZER|VALARM|URL:|LOCATION:|fictional-event|fictional_only|https:/,
    );
    expect(content).not.toContain(fixture().jobId);
  });
  it("calendar identity differs across tenants", () => {
    const a = composeAppointmentEmail(fixture(), actions).calendar!.content;
    const b = composeAppointmentEmail(
      fixture({ tenantId: "33333333-3333-4333-8333-333333333333" }),
      actions,
    ).calendar!.content;
    expect(a).not.toBe(b);
  });
  it("operator preview does not read even an attached credential property", () => {
    const input = Object.assign(fixture(), {
      customerEmail: "private@example.invalid",
      customerAddress: "PRIVATE ADDRESS",
    });
    Object.defineProperty(input, "managementUrl", {
      get() {
        throw new Error("must not inspect credentials");
      },
    });
    const result = previewAppointmentEmail(input);
    expect(result.previewOnly).toBe(true);
    expect(result.text).toContain("omitted from operator preview");
    expect(JSON.stringify(result)).not.toMatch(
      /private@example|PRIVATE ADDRESS|fictional_only|https:|href=|BEGIN:VCALENDAR/,
    );
    expect(result).not.toHaveProperty("calendar");
    expect(previewAppointmentEmail(cancelled()).html).not.toContain(
      "Manage appointment",
    );
  });
  it("is deterministic, does not mutate inputs and does not emit logs", () => {
    const input = Object.freeze(fixture());
    const action = Object.freeze({ ...actions });
    const spies = [
      jest.spyOn(console, "log"),
      jest.spyOn(console, "warn"),
      jest.spyOn(console, "error"),
    ];
    try {
      expect(composeAppointmentEmail(input, action)).toEqual(
        composeAppointmentEmail(input, action),
      );
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
  it("is unregistered and has no runtime consumers, persistence, credential or network dependencies", () => {
    function files(directory: string): string[] {
      return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? files(join(directory, entry.name))
          : [join(directory, entry.name)],
      );
    }
    const source = readFileSync(
      join(__dirname, "appointment-email-template.ts"),
      "utf8",
    );
    expect(source).not.toMatch(
      /fetch\(|process\.env|console\.|@Injectable|Prisma|LoggingService|signManagementToken/,
    );
    for (const file of files(join(__dirname, ".."))) {
      if (
        !file.endsWith(".ts") ||
        file.endsWith(".spec.ts") ||
        file.endsWith("appointment-email-template.ts")
      )
        continue;
      // A shared event-kind type is erased at build time, not a runtime consumer.
      const consumer = readFileSync(file, "utf8").replace(
        /^import type \{ AppointmentEmailKind \} from "\.\/appointment-email-template";$/gm,
        "",
      );
      expect(consumer).not.toContain('from "./appointment-email-template"');
      expect(consumer).not.toContain("composeAppointmentEmail");
    }
  });
});
