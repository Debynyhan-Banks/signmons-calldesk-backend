# APP-011 Readiness Report

Date: 2026-09-02
Branch: `codex/app-011-customer-booking-flow`
Ticket: Customer booking status and confirmation flow

## Outcome

APP-011 is owner-approved, merged and released to the Signmons CallDesk staging environment.

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

## Deployment Evidence

Released on 2026-09-02.

- Owner review: approved before merge and deployment.
- GitHub pull request: `#13`.
- Main merge: `28d394f6a205cb85398c5fc071582ea43f01c0dc`.
- Cloud Build: `5c478614-709a-4f15-9579-e964d7bcca67` (`SUCCESS`).
- Container: `us-east5-docker.pkg.dev/signmons/signmons/signmons-calldesk-backend:28d394f`.
- Container digest: `sha256:6721f0d940fd97890d6c75e5ba7e4e5de3e4c1163b4f20a3f975fac80701d787`.
- Prisma migration execution: `signmons-calldesk-migrate-xztrh` (`Completed=True`, one succeeded task).
- Cloud Run revision: `signmons-calldesk-staging-00024-wwn`, ready and serving 100 percent of staging traffic.
- Backend URL: `https://signmons-calldesk-staging-p572d6wipq-ul.a.run.app`.
- Customer page: `https://signmons-calldesk.web.app/appointment/manage`.
- Firebase Hosting target: `hosting:calldesk`; 44 static files released.

## Staging Acceptance

- Live liveness and database readiness returned HTTP `200` with `status: ok`.
- The public appointment boundary rejected an invalid management credential with sanitized HTTP `400` output.
- Production CORS preflight returned HTTP `204` and allowed `https://signmons-calldesk.web.app`.
- Chrome loaded the hosted customer route and confirmed that an invalid secure link fails closed with a safe resend-link instruction.
- Valid view, confirm, reschedule-request, dispatcher projection, tenant mismatch and audit behavior are covered by the released automated tests; owner UI review was completed against the isolated preview without creating or changing a real customer appointment.

## Build Identity Lockdown

The dedicated `signmons-build@signmons.iam.gserviceaccount.com` identity was enabled only for Cloud Build. Temporary Cloud Logging writer, build-bucket reader, build-object viewer and repository-scoped Artifact Registry writer grants were removed immediately after the successful build. Verification returned `disabled: true` and zero matching project, build-bucket and repository bindings.
