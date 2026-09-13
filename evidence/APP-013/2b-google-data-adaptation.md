# 2B Google-only data adaptation

Owner approved retaining Google and adapting the app to published guidelines. Governance APP013_2B_IMPLEMENTATION_CARD.md revises candidate storage and crash recovery; no runtime changes. Baselines: backend 01e0bdf, governance cbe0cdd.

Customer-confirmed address remains separate from a fixed short-lived allowlisted candidate. No raw Google response, county/verdict/responseId persistence is introduced. Recovery preserves the draft but cannot restore expired or missing authority; uncertain costs remain held. Attribution and deletion checks belong to existing 2B acceptance. Provider replacement is not selected.

Remaining design issue: county/validity consumption across asynchronous operator review and the final admission evidence lifecycle. Bootstrap/configuration and separate release/run approvals remain. No frozen criteria changed, provider request, spend, IAM, secret, deployment, customer data change or new section. APP-013/2B Now; 3/8 (37.5%) walkthrough unchanged, not whole-MVP completion. No scope deviation.

Validation: frozen-baseline and complete cross-repository consistency passed; all 17 governance regression tests passed; backend architecture and governance safeguard passed; both whitespace checks passed. Runtime tests, lint, build and browser QA were not rerun for this documentation-only change; no new runtime acceptance is claimed.
