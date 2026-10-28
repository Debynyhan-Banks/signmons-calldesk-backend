# P08 access-sequence source inspection

R1-W01 / APP-013 / 3A / P08 planning evidence only. Backend source `ba2336d`; governance source `3ea7eb4`. No code, provider, database, account, IAM, key, runtime or payment change occurred.

The existing disabled local model correctly refuses native execution, but it is not a safe basis for the next external operation. It conditionally enables only `policytroubleshooter.googleapis.com` and then immediately calls API Keys GET/create/delete. The actual October 28 service-state evidence records both Policy Troubleshooter and API Keys as disabled. The model has no API Keys state/readback/enable branch, so a live operation derived from it would contain an unqualified prerequisite.

The model also couples five permission diagnostics to key creation. Four tuples concern existing resources and can be evaluated before any key exists: runtime `firebaseauth.users.get`, owner `firebaseauth.users.get`, owner `firebaseauth.users.update`, and owner `iam.serviceAccounts.signBlob`. Only `apikeys.keys.getKeyString` depends on a newly created exact key. Splitting these stages prevents key creation while existing-resource access is still unknown.

The model's `RETAIN_IF_ENABLED` decision is suitable for local simulation only and is not external authorization. Google documents that enabling a service associates it with the project, adds monitoring, can expose roles and enables billing where applicable. Policy Intelligence features other than the specifically listed premium features are offered at no additional charge, but other Google services can still charge. Google also documents dependency and recent-usage safeguards on service disable. Therefore an external decision must explicitly choose retention and must not promise zero cost or automatically force disablement.

Recommended sequence:

1. Locally separate a diagnostics-only controller from the temporary-key controller and keep both native paths unbound.
2. After separate owner approval, enable and retain Policy Troubleshooter only, then run the four existing-resource diagnostics. Treat unknown/unsupported results as blockers.
3. Only if those diagnostics support the unchanged restoration design, separately qualify/enable the API Keys API and run the exact temporary-key lifecycle plus the fifth key-specific diagnostic in the same authentication/retirement block.

This is a material prerequisite correction. It requires owner approval before implementation. It does not add a product subsystem, ticket, acceptance milestone or MVP feature. The next observable result is a disabled, tested split controller or a local blocker, not API enablement or payment readiness.

Public contract references inspected October 28:

- https://docs.cloud.google.com/policy-intelligence/docs/troubleshoot-access
- https://docs.cloud.google.com/policy-intelligence/docs/billing-questions
- https://docs.cloud.google.com/service-usage/docs/enabled-service
- https://docs.cloud.google.com/service-usage/docs/enable-disable
- https://docs.cloud.google.com/service-usage/docs/reference/rest/v1/services/disable
- https://cloud.google.com/api-keys/pricing

Public documentation establishes contracts and published pricing only. It does not prove current Signmons organization visibility, service dependencies, live API behavior or actual charges.
