# Optional SMS enrollment — unavailable-policy checkpoint

2026-09-12. User approved local intake implementation with sending disabled. This bounded checkpoint implements only the fail-closed unavailable-policy branch in the existing local protected intake journey, not enrollment or durable consent capture.

Approved public policy URLs, customer support contact and a trusted tenant disclosure/configuration source remain unresolved. The checkbox is therefore unchecked and disabled on every render. No hardcoded Eternity identity is placed in a tenant-generic fixture. No placeholder legal links or false saved-consent success are shown. Request preview remains usable without texts; existing seven-field payload and backend consent records are untouched.

## Validation

- Backend build, lint and architecture check passed.
- Backend Jest: 99 suites passed, one skipped; 1,887 tests passed, three skipped.
- Production dependency audit: zero findings.
- JavaScript syntax and diff checks passed.
- Browser verification at 390px and 1280px passed using mocked intake responses. Tests cover disabled/unchecked default, continue-without-SMS, edit/re-render, keyboard navigation, no horizontal overflow and exclusion of tampered checkbox state from the draft payload.
- Screenshots and summary are adjacent. No browser/database end-to-end consent persistence proof is claimed; no provider calls or database writes occur in this browser harness.
- Next.js app was not changed; no new UI-app build claim. No production configuration changed.

Reproduce from this focused backend checkout:

    PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs SMS_INTAKE_EVIDENCE_DIR=/absolute/output/directory node scripts/verify-sms-intake-unavailable.mjs
    npm run build
    npm run lint
    npm run arch:check
    npm test -- --runInBand

Review both screenshots, verify preview works without SMS, and note that no new consent is recorded. Existing opt-outs cannot be changed by this UI. This is not the full approved consent implementation; enabled enrollment and server-side evidence capture remain pending the approved policy/configuration contract.

No deployment, migration, provider action, account creation, legal publication, sending or spending. APP-013 sole Now; 3/8 accepted milestones unchanged.
