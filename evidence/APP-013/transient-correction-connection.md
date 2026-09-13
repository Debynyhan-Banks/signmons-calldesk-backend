# Transient Google correction presentation connection

## Scope and result

Connected the controlled semantic inspection runner to a local browser correction page when the shared Google response parser reports CORRECTION_REQUIRED and the one-shot runner returns OBSERVED. Other statuses retain the prior enum-only private dialog. The page shows original/suggested addresses including unit, requires explicit confirmation, supports editing the original fields, and supports cancellation. Neither the page nor its selection dispatches a provider request.

This is implemented connection code with synthetic validation, not a new live Google test or durable customer-intake acceptance. The existing packet/hold checks are unchanged: the already-spent semantic packet cannot run again. No new packet, quota, token, permission, deployment, request or charge was created. Existing request holds are untouched.

## Privacy and authority boundary

The screen serves only on 127.0.0.1 with a random one-use path, exact Host/Origin checks, no-store headers, no external assets, escaped text, restrictive CSP, bounded bodies, and a two-minute server lifetime. A selected response page contains no address. Candidate selection is immutable on confirm; edits remain unverified customer input. All downstream authority flags are false. Refresh does not replay the private address page. Closing the tab leaves the server to expire; it does not create a retry.

Addresses exist transiently in process/browser memory; this is not a guarantee against browser/OS screenshots or forensic retention. There is no application file/database logging of address, provider body or selection. The inspection runner deliberately discards the selected address; the screen does not save a reusable draft or perform corrected-address revalidation. Real session/proof binding and permitted durable evidence remain separate acceptance work. Do not claim the closed prior real response was recovered.

## Validation and review

- Backend lint, build/Prisma generation, architecture check passed.
- Jest: 112 passing suites, 2,151 passing tests; existing 1 suite/3 tests skipped.
- 19 script tests passed: shared actual parser wire fixture, observed-only presentation, output filtering, confirmation/edit/cancel/expiry/open failure, cross-origin/duplicate/unknown field refusal, escaping, one-view handling, existing execution approval gates.
- Browser QA: actual loopback screen with fictional data, 390/1280 px layouts, confirm/edit/cancel, no external requests/page errors, address-free closure. Browser QA caught and fixed Referrer-Policy/Origin incompatibility; same-origin now preserves form origin without sending external referrers.
- No live Safari/customer/provider QA claimed. Screenshots are synthetic and local under /tmp/signmons-transient-correction-qa.

Review commands after build:

    node --test scripts/transient-correction-screen.test.mjs scripts/google-semantic-review.test.mjs scripts/run-google-address-inspection.test.mjs
    PLAYWRIGHT_MODULE=<installed playwright index.mjs> node scripts/transient-correction-browser-qa.mjs

Inspect review-390.png/review-1280.png and the runner/presenter diff. Do not execute the live semantic runner as a regression command.

## Next

Review this connection, then finish current-session corrected-address/admission integration and its evidence/approval gates within APP-013/2B. Any new live test needs a separately reviewed packet, allowance and window; do not reset either prior hold. Walkthrough acceptance remains 3/8 (37.5%), not an overall MVP estimate. No merge/release or transition to the next ticket.
