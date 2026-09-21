# APP-013 / P06 R11 final-capacity coordinator binding

## Approved section and acceptance criterion

- Section: APP-013 / P06 R11 under owner-approved `APP013_P06_R11_FINAL_CAPACITY_CHANGE_REQUEST.md` alternative 1.
- Criterion: exactly one future packet may use a 500000-micro phone flow under a 3000000-micro account ceiling after a fresh read proves no more than 2500000 micros of valid retained phone liability, and address admission must bind account and tenant to four operations / 400000 micros while session remains two operations / 200000 micros.
- Connected workflow: preserve every retained hold while allowing the same supervised phone-verification, eligible-address and reviewed-submit journey to use the approved remaining capacity.

## Demonstrated missing behavior

The existing attended coordinator still required the consumed four-hold / 2000000-micro liability and 2500000-micro phone ceiling. It did not bind the newly approved address account and tenant limits. A final-capacity packet would therefore fail local plan review or could omit the exact address-limit authorization boundary.

## Change

The local attended coordinator now requires five retained phone holds totaling 2500000 micros, a 500000-micro flow, and a 3000000-micro account ceiling. It also requires the packet and review plan to agree on address cost 100000 micros, account and tenant four operations / 400000 micros, and session two operations / 200000 micros. Any mismatch fails closed at `PLAN_BINDING` before prompting for a password or invoking a child mode.

## Verification

- `python3 -B -m unittest scripts.test_p06_r11_attended_coordinator` — 13 tests passed.
- Positive exact-plan coverage and negative phone-ceiling, plan-address-limit and packet-address-limit coverage pass.
- `git diff --check` passed.

No private packet, LOGIN, database write, activation, deployment, provider request, verification code, browser/customer action, hold release, secret/IAM change, billing change or live execution occurred from this local change. No automatic retry was added. No scope deviation beyond the owner-approved final-capacity policy.
