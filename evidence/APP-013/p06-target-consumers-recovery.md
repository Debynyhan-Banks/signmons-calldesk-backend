# P06-R02 — target and consumer qualification (partial)

Read-only continuation after owner confirmed Neon is dedicated to Signmons. Entry backend39aafa8/governance16705af. No customer rows, secret payloads, SQL, provider calls, resource changes or application requests this turn. No scope deviation.

## Verified observations

Previously observed signed-in Neon UI: organization Signmons Free; project signmons-staging (soft-smoke-54063480), AWS Ohio; sole default branch named production (br-young-term-ayfi7ist); endpoint ep-nameless-frog-ayk5gr5y matches the endpoint in prior privately verified staging URL. UI reports PostgreSQL18, six-hour history, no snapshots or schedule. That UI observation is not a restore test or an enduring recovery point; any selected time expires. The branch name alone does not establish production traffic.

Fresh gcloud metadata: project signmons has one listed Cloud Run service signmons-calldesk-staging and one job signmons-calldesk-migrate. All nine traffic-tagged service revisions reference signmons-staging-database-url:latest. Secret metadata shows version2 enabled,1 disabled. This establishes configured references, not which version each already-running instance resolved or an exhaustive inventory of external clients.

Normal traffic remains100% signmons-calldesk-staging-app013bounds, digest37286933d882466b8592120f48eb69c34e14cdb5a23c1f37480e39a1e6ff933a. Repository release evidence links it to PR18/b6f1d13 and records inbound voice/SMS availability. Its SCHEDULING_ENABLED=true and SMS_DELIVERY_ENABLED=false. Old app013-sms-test tag has both scheduling and SMS delivery=true. Seven other tags include app009, app012-candidate, phone-preflight and four BE008 tags; all except phone-preflight report scheduling=true. Phone-preflight reports inspected scheduling/SMS/background/old-phone flags=false. Configuration does not prove actual sends, running workers or unrestricted public access; zero normal traffic does not prove a tagged revision cannot receive requests.

Existing migration job uses image tagfd6828a, runtime service account, npx prisma migrate deploy and the same latest database secret reference. It was NOT executed. This old job is not the reviewed immutable26-migration runner and must not be reused by assumption.

Only PostgreSQL16 and17 installations found under /opt/homebrew/opt; PostgreSQL18 was not found there. R01 remains valid as a local16.11 rehearsal; it is not target18 compatibility proof.

## Remaining within R02

- Qualify PostgreSQL18 using an explicitly reviewed local/disposable method; do not change the target server or install software silently.
- Resolve direct migration connection from authoritative Neon metadata, not by editing a pooler hostname. No credential retrieval this turn.
- Review exact baseline source/readers and all known tagged/job consumers, and a maintenance procedure preventing competing writes. Cloud inventory alone cannot establish absence of external clients.
- Bind recovery owner, usable fresh checkpoint/expiry and verified restore procedure. No snapshot creation, restore, data copy or paid plan authorized. Six-hour UI history alone does not close recovery.
- Prepare exact proposed maintenance/resource actions before asking execution permission; do not disable old tags, scheduling, webhooks or jobs by inference.

R02 stays OPEN. Closed R01; open R02–R12:11 remaining, added0. No R03 migration-approval request until qualifications pass. Accepted5/60, walkthrough3/8; ETA unvalidated. Smallest next decision: approve planning the exact staging maintenance and PostgreSQL18 rehearsal method, not external execution. Owner previously asked to stop for questions; report these findings before selecting a software installation, backup or maintenance change.

Docs-only checks: architecture, backend governance, frozen/full consistency,21 governance regressions and whitespace; no new runtime/browser result claimed.

