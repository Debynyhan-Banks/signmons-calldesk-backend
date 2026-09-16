# P06-R06 — exact cloud diff, stable bindings and runtime-role gap

Entry backend23206a9 / governance0157c8b, both remotes fetched, focused trees clean; backend PR21 open. Owner reviewed U02 and requested continuation. Saved backend unrelated deletions/modifications/untracked files preserved. Documentation/read-only work only; no runtime code, secret payload access, IAM change, provider call, deployment, charge or database write.

## Fresh observations

- gcloud identity debynyhan@signmons.com. Project IAM etag BwZbetDk92Y=: runtime direct role firebaseauth.viewer only; runtime SA policy has no bindings. Existing Twilio-token resource grants runtime secretAccessor. Owner's metadata-only testIamPermissions returned versions.access/add and secrets.setIamPolicy, HTTP200. No extra owner role is needed on that resource; other resources require exact pre-use checks, not blanket inference.
- Metadata list still13 existing secret resources, none of the five proposed P06 names. Twelve inherited non-database bindings resolved to enabled numeric versions: admin2, conversation encryption2, Stripe webhook5, all other inherited listed bindings1. Old versions/consumers left unchanged; no payload/account correspondence inferred from metadata.
- Cloud Run baseline100% app013bounds, nine unchanged tags, latest ready00065-guw. Proposed app013p06disabled/app013p06enabled revisions and p06-intake-disabled/p06-intake-enabled tags absent. Service max2, revision max1, concurrency40, timeout60sec,1vCPU/512Mi, CPU throttling/startup boosttrue. Six safety flags false. Environment values except named public safety flags redacted; only secret reference names/versions retained.
- Existing Chrome Neon tab, exact child br-sparkling-sun-ay6gr5e8 / ep-jolly-flower-ayc6w9hv / neondb: SELECT returned SUSPENDED,2026-09-12T22:46:30.011Z; profile/payment keys absent; runtime/phone enabled fields null; categories0,jobs0,address operations0,address-held micros0. No raw settings or personal records queried.
- All non-pg roles queried without password columns: cloud_admin/neon_service/neon_superuser (provider roles), neondb_owner LOGIN with CREATEDB/CREATEROLE/REPLICATION/BYPASSRLS, and p06_migration_owner/p06_migration_runner bothNOLOGIN with all queried elevated flagsfalse. No existing limited application login. Dashboard Free displays1.89/100CUh,0.04/0.5GB,0/5GB, with delayed-metrics warning. Left existing tab on dashboard.

## Prepared deliverable

Governance APP013_P06_R06_REVIEW_PACKET.md contains exact principal/resource/role before-after, stable proposed UUIDs, numeric inherited versions, candidate names and proposed origin, operation/request caps, combined prior-hold accounting and finite cost scenario. New versions, bootstrap digest/actual approvals and enabled window are legitimately produced at R08/R10, never fictional values now. The restricted database credential is not qualified merely by naming a secret.

Three exact proposed cloud grants: runtime Service Usage Consumer at project; runtime Secret Accessor on new delivery bundle; runtime Secret Accessor on new limited-child DATABASE_URL secret. No source-key accessor for runtime, project-wide accessor, token creator, API enablement or additional owner grant proposed. Commands are review-only, never executed.

Provider-directory skill used before public-price refresh; installed CLI rejects directory command and website returned unsupported content type. Did not install/upgrade; official provider pages used instead. Budget proposal0.70new verification +2.00infrastructure, plus0.30/month gross retained five automatic-replication secret versions; prior0.70holds separate. Detailed gross scenario approximately0.56 excluding verification/retained secrets is an estimate, not an enforceable invoice ceiling. Secret Manager explicitly bills DISABLED versions too; cost stops only after separately authorized destruction, not disabling. Source links and assumptions in review packet.

## Remaining decision, not another implemented subsystem

Recommend preparing p06_intake_runtime on the isolated child with no ownership/elevated role membership and exact runtime object permissions. Current administrator backup/migration permission does not authorize putting a parent-capable credential in Cloud Run. Restricted-role grant/handoff/expiry tests need preparation after this design decision, then exact R07 review and R08 external authorization. Do not copy migration credentials, reset owner passwords or introduce another unapproved helper. No provider support email is required by this recommendation.

R06 stays open: privilege inventory now concrete but runtime credential path unresolved. Original12+U01+U02=14;7locally closed/7open. Packages5/60(8.3% tracked plan),walkthrough3/8(37.5%),P06unaccepted,ETAunvalidated. No scope deviation implemented; role configuration is a proposal within existing least-privilege setup, with no new task/count or code authorized.

Validation passed: documentation-only governance frozen/full consistency,21regression tests, backend baseline/architecture and both whitespace checks. Full application/build/lint/database/browser-journey tests not rerun; prior U02 results remain historical. Console readback is resource evidence, not customer acceptance.
