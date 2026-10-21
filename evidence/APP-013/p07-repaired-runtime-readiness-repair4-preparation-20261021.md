# APP-013 / 3A / P07 repair-4 readiness preparation

Date: October 21, 2026, Eastern time

## Section and requirement

- Section: R1-W01 / APP-013/3A/P07.
- Acceptance criterion advanced: prepare the disabled runtime needed for a later authentic Sandbox payment on the accepted job. This preparation does not clear the payment gate and earns no acceptance credit.
- Connected workflow: payment policy and the admitted job must be read under verified TLS before a zero-traffic payment runtime can be prepared.

## Exact bound package

- Package: `/private/tmp/p07-repaired-runtime-readiness-20261021-repair4`.
- Plan: `0f2daeb9-fc75-40c2-b66b-097b6c986d7d`.
- Packet: `67157149-adc5-4a5b-a5c3-93066071403e`.
- Operation: `609bca17-276b-493f-bbd8-6edf7d5ad7e9`.
- Window: October 21, 2026, 7:00–8:30 a.m. Eastern.
- Strict start cutoff: before 7:15 a.m. Eastern.
- Ordinary work end: 8:00 a.m.; containment through 8:20 a.m.
- Retirement deadline: October 22, 2026, 7:00 a.m. Eastern.
- Manifest SHA-256: `d29ad5e6b0bf0aacfa2d95649740cb9cbade0ce8d0d12f1e5edbdba475706abd`.
- Binding SHA-256: `3d4e7239e14f4095a2ec84ea95a4d481846c94d2b6bdeef34c93cf8321a96d63`.
- Controller SHA-256: `b4b6c1d56333ed968eb6b122f4f613727453d5928cdc5f84b503333b8268743d`.
- Test SHA-256: `5b7b60278eb28ce005c75fbb68ef65f88530067739680cf43a481910b1a827ae`.

Both administrator and restricted-role `psql` paths require `PGSSLMODE=verify-full` and `PGSSLROOTCERT=system`, with no downgrade. Database stderr is classified in memory into fixed secret-safe codes and discarded.

## Verification

- `python3 -m unittest -v test_controller.py`: **35/35 passed**.
- Python and all three Node syntax checks passed.
- `python3 controller.py --check`: `P07_PREPARATION_CHECK_PASSED_NO_ACTION`.
- `--run`, `--recover` and `--retire`: each refused `P07_REFUSED_OWNER_APPROVAL_INVALID` with exit 2.
- Frozen baseline, governance consistency, architecture and whitespace checks pass.
- Private package directory mode remains `0700`.

`owner-approval.json`, `attempt.json`, `mutation-journal.json` and all provider/result receipts are absent. No database connection, Cloud or Stripe read/write, IAM or secret change, deployment, payment, booking or customer action occurred.

## Remaining gate

The owner approves or refuses governance proposal `APP013_P07_REPAIRED_RUNTIME_READINESS_OPERATION_REPAIR4_20261021.md` before the strict 7:15 a.m. start cutoff. Only after approval is installed and read back may the one-use attended command be handed off. P08/payment and 3A acceptance remain separate.

Accepted progress remains **0/27 newly closed R1 packages; 6/60 legacy packages; 4/8 walkthrough milestones; 0/13 full-intelligence rows**. **No scope deviation.**
