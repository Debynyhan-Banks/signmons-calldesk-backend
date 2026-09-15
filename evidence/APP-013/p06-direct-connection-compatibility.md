# P06-R02 direct connection and baseline compatibility

Entry backendbb1fdc0/governance3872f63. Owner continuation authorizes read-only qualification, not resource changes. Focused origins fetched; clean at entry. No scope deviation.

Existing signed-in Chrome Neon project soft-smoke-54063480, branch br-young-term-ayfi7ist: Computes shows primary ep-nameless-frog-ayk5gr5y suspended. Connection details, with display-only pooling switch off, supplies direct hostname ep-nameless-frog-ayk5gr5y.c-5.us-east-2.aws.neon.tech, database neondb, role neondb_owner, sslmode=require and channel_binding=require. Password remains hidden; no Copy snippet/Show password/reset, secret payload retrieval, SQL or connection attempt. This identifies the authoritative direct endpoint; it does not prove credential authentication or migration session settings. Schema public remains prior read-only evidence.

Recovery page still displays six-hour history and no snapshots/schedule. No Preview data, Create or Restore action. Page's displayed timestamp may be stale until refreshed; no specific durable recovery point claimed.

Read-only gcloud job execution list: latest three recorded completions are September7; existing migration job was not executed. This does not establish absence of other database writers.

## Actual old-reader constraint

Repository release evidence binds normal staging image37286933... to PR18/b6f1d13. That source's Prisma PropertyAddress declares googlePlaceId:String, latitude:Float, longitude:Float non-null. SmsConsentRecord lacks revision. New migration drops location NOT NULL and introduces consent revision/default/update trigger. Preserved existing non-null rows passing migration tests do not show old generated readers can handle new null-location records. No runtime failure induced or customer rows read.

Consequently a disabled candidate plus schema upgrade is not permission to enable new intake while these old readers share its data. Before nullable-location writes, either (A) explicitly isolate the controlled test database from old consumers, or (B) review/qualify a coordinated reader replacement and maintenance window. Do not silently rewire secrets, remove tags, stop webhooks, enable/disable workers, deploy replacements or create a branch. Old scheduling/SMS-enabled tag settings make mere zero-percent traffic insufficient evidence of writer isolation.

## Proposed decision within R02, not implemented

Recommend evaluating an isolated Neon test/recovery branch rather than exposing old readers to new records. This is a proposed change to the previously shared-target release plan, NOT an approved resource. Before creation: verify branch/snapshot entitlement and incremental costs, exact inherited data/retention, no integrations attached, recovery/readback procedure, expiry/deletion ownership and explicit owner approval. Any approved change must record resource/connection/packet and dependency impact under the fixed baseline's change control; do not add hidden tasks or call it free by assumption.

Alternative retains the existing branch but requires verified recovery plus coordinated old-consumer quiescence/compatibility and explicit maintenance authority. Local rehearsal does not choose between these alternatives.

R02 remains OPEN: direct endpoint identified; PostgreSQL18 rehearsal complete; recovery and consumer-isolation decision unresolved. R01 closed; R02–R12 open (11), added0. No acceptance gain:5/60 packages,3/8 walkthrough, ETA unvalidated. Smallest owner decision is whether to investigate isolated-branch release/recovery instead of shared-target maintenance; either option still needs an exact resource/cost/execution packet before external action.

Checks: architecture, backend governance, governance frozen/full consistency,21 governance regressions and whitespace. Documentation-only; no fresh runtime/browser acceptance claimed.
