# P08 Stage A operation stop and containment

R1-W01 / APP-013 / 3A / P08. Debynyhan Banks approved the exact operation at governance proposal commit `571037f`; approval was recorded at `cf0affb`. One private-plan-bound attempt started at 1:15 p.m. Eastern on October 28 and returned `P08_STAGE_A_LAUNCH_REFUSED_UNBOUND` at 1:15:08.

Sanitized local diagnosis identified `APPROVAL_DOCUMENT_BINDING`: the launcher requires the immutable approved document to contain the operation UUID, but the fresh UUID was generated only after that document was approved and committed. The local synthetic approval fixture contained its synthetic UUID, so the mismatch between real document construction and plan construction was not tested. This is an implementer preparation defect, not Google, credential, permission, billing or project drift.

The refusal occurred before the launcher created its output directory, resolved the existing owner, requested a bearer or issued HTTPS. External commands/requests: zero. Provider mutations/sessions: zero. The exact private plan was deleted at 1:15:43, its directory was removed and absence was verified. No retry occurred. The approved attempt is consumed.

Remaining: propose a narrow local correction that makes the immutable operation ID exist before approval and tests the actual committed-document/private-plan construction path. Do not weaken or remove the document binding. Any corrected external operation requires a fresh exact document, window and owner approval. Stage A live facts, Stage B and 3A acceptance remain open. **Unintended preparation drift disclosed; containment verified; no scope deviation or substitute work.**
