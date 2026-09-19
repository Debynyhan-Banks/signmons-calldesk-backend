# P06 / R10 fresh-packet local preparation

## Review checkpoint — 2026-09-19

The owner said `proceed` after the activate-before-deploy controller repair was committed and verified. This checkpoint resolves only stable local preparation decisions. It does not authorize or perform a provider/target read, private participant-binding access, packet creation, private-helper installation, database LOGIN, activation, deployment, verification code, Address Validation request or connected execution.

P06 remains 11/14 complete. R10, R11 and R12 remain open. No fresh packet, digest, operation ID, authorization record or runtime window exists.

## Section traceability

- **Approved section:** APP-013 / P06 / R10, preparation following the owner-approved sequence correction.
- **Acceptance criterion advanced:** make the repaired R10 sequence ready for one fresh, exact packet without reusing the consumed first attempt. R10 still closes only after the exact deployed revision/origin and activation readback match during a separately approved connected run.
- **Inspected missing behavior/evidence:** backend `158650bb26afeb190c670015a638aec3db46d52c` contains the tested inert controller; governance `01d98160527299286fff506619874eb39d0c352c` records its boundary. The consumed plan `b228f87a-ed6e-4253-a62a-b33128bb094a`, consumed revision `signmons-calldesk-staging-app013p06enabled` and expired September 18 window are rejected. Current provider/target state and a new attended window have not been refreshed or approved.
- **Connected workflow:** a future R10 run may enable only the same capped R11 phone -> address -> explicit reviewed-submit journey. It grants no payment, booking, scheduling, dispatch or confirmation authority.

## Stable local decisions

- Application source/image stay `59f2dabc022e3c9d91a1233aece6d8c67fe6c3b4` / `sha256:ea47a8371a04f773a5c51fc4f939250b7045eba92d3cbbeb68e49ceb0240be35`. The controller source is backend `158650bb26afeb190c670015a638aec3db46d52c`.
- The planned fresh revision is `signmons-calldesk-staging-app013p06enabled2`. The fixed tag remains `p06-intake-enabled`, with origin `https://p06-intake-enabled---signmons-calldesk-staging-p572d6wipq-ul.a.run.app`. Target absence must be freshly proven before packet creation and again before deployment.
- The success order is preflight -> limited runtime role -> activation reservation/mutation/readback -> zero-traffic deployment reservation/mutation/readback -> R11 handoff. General traffic remains 100% on `app013bounds`.
- Every post-activation stop first reconciles and, for the exact active digests only, revokes and reads back approval; it then removes the enabled tag, restores the runtime role to `NOLOGIN`/limit 0/past expiry, terminates only that role's sessions and proves final inactive state. Unknown outcomes are never replayed.
- The connected runtime remains at most 15 minutes. A later closeout interval may add at most 15 minutes. Exact absolute UTC timestamps, packet/digests and operation IDs will be generated only after the owner selects the attended block and authorizes the required current read-only refresh.
- Existing caps, policy, bundle version 1, child database URL version 2 and private participant binding are candidates for reuse only after fresh metadata/readback checks. This checkpoint did not access their payloads or assert that time-sensitive provider state is unchanged.

## Finite next preparation

1. Owner supplies one future attended block and authorizes current read-only Twilio and target/resource readbacks plus fresh-packet preparation. This does not authorize execution.
2. Refresh exact account/service/restriction/rate metadata, target absence, normal traffic, immutable image/config, numeric secret-version metadata, inactive approvals/runtime role and participant-binding readiness through the existing private boundary.
3. Stop on any drift. Otherwise generate one new packet ID, packet/runtime/phone digests, activation/readback/revoke/readback operation IDs and exact runtime/closeout timestamps. Install only the guarded private review helpers and run their no-action check.
4. Publish a sanitized exact review record. Ask the owner separately to approve or refuse that exact packet/window before any LOGIN, activation, deployment, provider request, verification code or execution.

## Tests, exclusions and finish

- Positive review requires the controller's fresh-plan validator, current inactive preflight, target absence, exact source/image/config/bundle versions, participant match, provider restrictions/caps and all safety flags false.
- Negative review stops on a stale/overlong window, consumed ID/revision, target collision, provider drift, wrong digest/account/participant, active or partial approval, exhausted cap, unknown state or unexpected traffic/tag/IAM/configuration.
- No new runtime code, schema, migration, dependency or infrastructure is introduced. Rollback for this documentation-only checkpoint is deletion of its two evidence files and synchronized governance text.
- Observable finish: the stable local decisions and the smallest next owner authorization are reviewable. No external or private action occurred. The original dirty APP-010 checkout remains preserved.

No scope deviation beyond the already approved R10 sequence change.
