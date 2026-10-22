# R1-W01 / APP-013 / 3A / P07 owner-operated account exact-window preparation

Date: October 22, 2026. Status: bound and locally verified; exact external approval absent.

Owner confirmed availability **3:00–3:45 p.m. Eastern today**, strict start cutoff **3:10**, transaction deadline **3:30**, closeout deadline **3:40**. UTC: `19:00`, `19:45`, `19:10`, `19:30`, `19:40`, respectively. No retry; USD 0.

- Package: `/private/tmp/p07-tenant-stripe-binding-owner-handoff-20261022-prep1`.
- Plan: `e13cca1d-b51d-44f0-bcc9-dcbe0b281f8e`.
- Packet: `852a8b36-2780-4003-85ec-14ad7491eb79`.
- Operation: `f0af9aa6-f83b-4557-a0cb-cfd9900fbb42`.
- Audit: `46971952-f8e7-455a-a48a-fb084b5e836a`.
- Preparation manifest: `47249f6299936855f4338516f907a7976831dbb68cef9617653c1883d0cbaddb`.
- Bound manifest: `4ccd327f942a593c3cbd7ea32c51a6c6908a9dc746a55c44828223977820d14b`.
- Binding: `aeee47af34113ff8caff8800f37a12be7b2b4f5afb10bd1a70e593ce402bdf6f`.
- Controller: `9bba476439b77ee24bd695b209d03ba21a8d894e96f0f4359f1c33b1b032f823`.

Binding added exact times, pinned the preparation manifest, updated disabled plan/README statuses and regenerated the manifest. Transaction, predicates, audit, readback/recovery and owner handoff behavior remain unchanged. The exact later approval must include `owner_operated_connected_account_handoff`; owner alone may use the clipboard for this ID. Automation may not operate Terminal/clipboard. The current account-detail ID control must be confirmed in the later approved read-only Stripe qualification before the owner copies it.

Verification after binding:

- `python3 -B -m unittest -v test_controller.py`: **14/14 passed**.
- `python3 -B -m unittest -v test_postgres_contract.py`: **5/5 passed**, synthetic rows/disposable Unix-socket-only PostgreSQL 16.11 cluster removed.
- Controller AST syntax, exact seven-file inventory, private directory/files and all manifest hashes passed.
- `python3 -B controller.py --check`: `P07_TENANT_BINDING_PREPARATION_CHECK_PASSED_NO_ACTION`.
- `--run` and `--recover`: both `P07_TENANT_BINDING_REFUSED_OWNER_APPROVAL_INVALID` before hidden input/database access.

No owner live approval, Stripe receipt, attempt, mutation intent, result or closeout exists in the new package. Prior consumed attempts and verified closeout remain immutable. No browser, clipboard, live database or provider action occurred. Governance baseline/consistency, 25 safeguards, architecture and whitespace checks are recorded with this checkpoint.

Exact next decision: governance `APP013_P07_OWNER_OPERATED_ACCOUNT_OPERATION_PROPOSAL_20261022.md`. Success is exact tenant update/audit/readback and verified closeout; failure is a consumed fixed stop. Runtime readiness, Sandbox payment and 3A acceptance remain open. Measures stay **0/27 R1; 6/60 legacy; 4/8 walkthrough; 0/13 intelligence**. **Approved procedural deviation only; no additional scope deviation.**
