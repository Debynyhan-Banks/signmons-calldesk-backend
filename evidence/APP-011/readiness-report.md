# APP-011 Readiness Report

Date: 2026-09-02
Branch: `codex/app-011-customer-booking-flow`
Ticket: Customer booking status and confirmation flow

## Outcome

APP-011 is implemented and ready for owner review. It has not been merged, migrated or deployed.

## Acceptance Evidence

### Secure customer status

- Public boundary: `POST /appointments/manage`.
- The request carries the secure management token in the JSON body; the customer page reads it from the URL fragment, so it is not placed in server request paths or query logs.
- HMAC signature, purpose, version, expiry, tenant and job claims are verified before the job query.
- The customer response contains the request/booking state, appointment window, technician assignment state and payment state summary without exposing dispatch credentials.
- The existing lowercase `state` field remains for the Eternity management-page proxy; richer states are additive in `bookingState`.
- Desktop evidence: `customer-status-desktop.png`.
- Phone evidence: `customer-status-mobile.png`.

### Customer confirmation and reschedule request

- `confirm` records `appointment.customer_confirmed`.
- `request_reschedule` records `appointment.customer_reschedule_requested` with an optional normalized 500-character note.
- Existing direct calendar reschedule records `appointment.customer_rescheduled` after the calendar update succeeds.
- Confirmation and repeated identical reschedule requests return a `changed` flag to make replays visible and avoid avoidable duplicate events.

### Dispatcher visibility

- `GET /jobs/dispatch-board/:jobId` now returns `customerBooking` with state, label, last update and a bounded event timeline.
- The dispatch detail UI highlights `RESCHEDULE_REQUESTED` as action needed and displays the customer's note when provided.
- Secure management tokens are not selected, persisted in audit metadata or returned to dispatch.

### Audit and tenant isolation

- Added `CUSTOMER` to `AuditActorType` through migration `20260902130000_add_customer_audit_actor`.
- All customer events are written with the token-authorized `tenantId` and `jobId`.
- The integration compatibility path supplies `expectedTenantId`; a valid token for a different tenant fails before any job query.
- Focused tests cover customer confirmation, reschedule request, dispatcher projection and tenant mismatch rejection.

## Automated Gates

### Backend

- `npm run -s build` — passed.
- `npm test -- --runInBand` — passed: 23 suites, 163 tests; 1 suite/3 tests skipped by existing test policy.
- `npm run -s arch:check` — passed.
- Repository-wide lint is not an APP-011 completion gate and still reports five pre-existing APP-010 findings in `src/jobs/routing.service.ts`; no APP-011 file is named in the lint output.

### Frontend

- `npm run -s lint` — passed with no warnings or errors.
- `npm run -s build` — passed; `/appointment/manage` exported successfully.
- `npm test -- --runInBand` — passed: 17 tests.

## Manual Browser QA

- Chrome desktop full-page review passed.
- Phone viewport review passed with `scrollWidth === clientWidth`.
- Primary and secondary touch actions render at 50px high.
- Reschedule disclosure, note field and send action are keyboard/role addressable.
- Accessible snapshot exposes one `Secure booking link` label and clear heading/action hierarchy.

## Release Requirements

1. Owner approval of both customer and dispatch screens.
2. Focused commit and PR review.
3. Apply the Prisma migration before routing production traffic to the new backend revision.
4. Deploy Cloud Run and Firebase Hosting together so the public page and API contract remain aligned.
5. Run one isolated staging secure-link flow: view, confirm, request reschedule and dispatcher verification.
6. Record release identifiers and staging evidence before moving APP-011 to `Done`.
