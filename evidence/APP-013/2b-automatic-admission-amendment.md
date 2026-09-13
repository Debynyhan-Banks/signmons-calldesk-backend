# 2B automatic admission amendment prepared

Source baseline 8a3c737; governance baseline 891e673. Owner approved changing routine admission from operator approval to automatic Signmons execution on trusted verification/current tenant policy and explicit customer submission. Existing service currently requires operator context and returns pending human review; no runtime behavior changed here.

Governance APP013_2B_AUTOMATIC_ADMISSION_CHANGE.md contains exact old/new protected text, source gap, service-versus-customer/operator authority, exception-only handling, atomicity/replay/recovery tests and adoption boundary. Frozen baseline is unchanged pending exact-text review. Google retention and controlled-source identity mapping remain implementation gates; no claim that automation resolves legal retention by itself.

No merge, deployment, provider calls, spend or data changes. Scope-change direction approved; documentation packet only, not automatic job creation delivered. Accepted walkthrough remains 3/8 (37.5%), not whole-MVP completion.

Validation: all 17 governance regressions passed, frozen baseline and complete consistency passed, backend architecture and cross-repository safeguard passed, both whitespace checks passed. Runtime tests/lint/build/browser QA not rerun for documentation-only changes; no runtime acceptance claimed.
