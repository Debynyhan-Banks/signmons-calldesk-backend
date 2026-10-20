# APP-013 / 3A / P07 runtime-envelope preflight local correction

Date: October 20, 2026, Eastern time

## Status and traceability

Debynyhan Banks approved Alternative 1 in `APP013_P07_RUNTIME_ENVELOPE_PREFLIGHT_CORRECTION_PROPOSAL_20261020.md` for local correction/testing only. The correction is implemented in fresh private package `/private/tmp/p07-repaired-runtime-readiness-20261020-repair2`; the consumed package and its receipts remain untouched.

- Section: R1-W01 / APP-013 / 3A / P07.
- Criterion served: safely preserve the normal serving revision while preparing the separately constrained zero-traffic payment candidate.
- Demonstrated gap: the consumed controller incorrectly used the candidate envelope validator against the existing normal revision and stopped before mutation.
- Fresh identifiers: plan `6dbc6811-86d8-4bd1-8c71-1886ccf7edf6`, packet `8d64e774-bc2f-4222-87b8-77727198e4ac`, operation `45ae622a-2cb7-4ab7-ae90-f94d30c9336a`.

## Correction

Cloud preflight now describes the exact revision named by the single 100%-traffic route. It validates the preserved normal revision against its observed envelope: existing runtime identity, timeout 60, concurrency 40, 1 CPU, 512 MiB, maximum 2, minimum absent/zero, startup boost true, CPU-throttling annotation absent and service ingress all.

The candidate validator is unchanged: dedicated P07 identity, timeout 60, concurrency 40, 1 CPU, 512 MiB, maximum 1, minimum absent/zero, explicit CPU throttling true, startup boost true and ingress all. The payment return URL is now read from the exact normal revision rather than the service's latest template.

## Verification

- **31/31 focused tests passed**, including exact normal/candidate separation, normal identity/capacity refusal and unchanged strict candidate enforcement.
- Python and Node helper syntax passed.
- `--check` returned `P07_PREPARATION_CHECK_PASSED_NO_ACTION`.
- `--run`, `--recover` and `--retire` each refused `P07_REFUSED_WINDOW_NOT_BOUND`.
- No binding, owner approval, attempt or mutation journal exists. No external action occurred.
- Manifest SHA-256: `9796d2ae0ccc00ef19ee648e58faa979b7a16d14b9135c84ed343ee910a2c846`.
- Controller SHA-256: `4497d5549d9a7a36ffa749a3d8608e271bff3eaf014161965be5ae1d19ea74b6`.
- Test SHA-256: `5a67b12f72b25ccbc692592af491dd71d0c4951b752f43da9758a511202bb71d`.
- Plan SHA-256: `6f6145a20cf8f88a0c11a2b476d98c55b06ee89c6426eeb3e8f3afbfdc88b4e4`.

## Remaining and next result

The owner supplies a new attended window of at least 90 minutes with Terminal, current CHILD administrator password and signed-in Stripe Sandbox available. The implementer then binds exact times, reruns the complete gates and presents a fresh exact external-operation proposal. The prior operation remains consumed and cannot be retried.

Accepted progress remains **0/27 newly closed R1 packages; 6/60 legacy packages; 4/8 walkthrough milestones; 0/13 full-intelligence rows**. **No scope deviation from the approved Alternative 1 correction.**
