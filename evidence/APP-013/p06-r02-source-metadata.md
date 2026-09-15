# P06-R02 source metadata inspection — 2026-09-15

## Authority and method

Owner said continue after the explicit metadata-only inspection request. Entry backendab83586/governance3b98e2b; both origins fetched; focused worktrees clean; unrelated saved checkout changes preserved. APP013_P06_R02_EXTERNAL_PACKET.md is the query/authority boundary. No scope deviation.

Existing Chrome Neon tab, authenticated console, exact child br-sparkling-sun-ay6gr5e8 / project soft-smoke-54063480 / neondb / endpoint ep-jolly-flower-ayc6w9hv. Replaced default sample CREATE/INSERT SQL before running anything. Four read-only transactions, each BEGIN READ ONLY,10s local statement timeout and ROLLBACK, completed successfully around10:52-10:58UTC. Additional compact catalog reads resolved UI100-row rendering and schema/default ACL details; no customer rows, passwords, query-text history from other sessions or role hashes read. Console automatically retained metadata-query history. No saved query, credential, grant, schema or data mutation.

## Verified metadata

- PostgreSQL18.6, aarch64 Linux; current_user neondb_owner; database11,165,696bytes (about10.65MiB).
- Encoding UTF8; datcollate/datctype C.UTF-8. Local locale inventory includes C.UTF-8, but cross-OS collation equality is not proven merely by matching names.
- Exactly13 migration records, all finished, none rolled back. All13 displayed SHA256 values match corresponding first13 repository migration.sql files; pending13 remain unapplied.
- Public relations23 ordinary tables and112 indexes; all neondb_owner owned, all relacl NULL (default ACL), RLS/force-RLS false. No public sequences, views or other relation kinds in this inventory.
-34 enums, all neondb_owner owned. Zero public functions. Sole extension plpgsql1.0, owned by managed cloud_admin.
- Public schema owner pg_database_owner; ACL {pg_database_owner=UC/pg_database_owner,=U/pg_database_owner}.
- Two default ACL entries, both cloud_admin/public: tables {neon_superuser=a*r*w*d*D*x*t*m*/cloud_admin}; sequences {neon_superuser=r*w*U*/cloud_admin}. Do not discard these in a claimed security-equivalent restore.
- neondb_owner is not PostgreSQL superuser, but has createdb/createrole/replication/bypassrls true and membership in neon_superuser. No p06 migration roles exist. Twenty built-in/managed roles and12 membership records inspected; no secret attributes.
- Other-session aggregate returned zero rows at inspection time. This is a point-in-time observation, not proof no outside client can connect later.

## Exact public table inventory

AuditLog; CommunicationContent; CommunicationEvent; Conversation; ConversationJobLink; Customer; CustomerCoverageCheck; Job; JobOffer; LedgerEntry; Payment; PropertyAddress; RoutingRule; ServiceArea; ServiceCategory; SmsConsentRecord; StripeEvent; TenantOrganization; TenantSubscription; User; UserAvailabilityBlock; UserServiceCapability; _prisma_migrations.

## Exact public enum inventory

AuditActorType; AvailabilityBlockType; CommunicationChannel; CommunicationDirection; CommunicationProvider; CommunicationStatus; ConnectOnboardingStatus; ConversationChannel; ConversationJobRelation; ConversationStatus; CoverageReasonCode; CoverageStatus; JobOfferChannel; JobOfferStatus; JobStatus; JobUrgency; LedgerEntryType; PaymentStatus; PreferredWindowLabel; ProficiencyLevel; RedactionLevel; RefundStatus; RoutingRuleStatus; RoutingTimeScope; ServiceAreaStatus; ServiceAreaType; SmsConsentSource; SmsConsentStatus; StripeEventStatus; SubscriptionStatus; TechnicianJobStatus; TenantStatus; UserRole; UserStatus.

## Consumer and resource readback

Google Cloud project signmons/us-east5 still lists one service signmons-calldesk-staging and one job signmons-calldesk-migrate. All nine currently traffic-tagged revisions and the job reference signmons-staging-database-url:latest; no plaintext DATABASE_URL values shown. Numeric metadata:2enabled,1disabled; no payload read, so endpoint content was not independently reverified today. Normal traffic100% app013bounds at digest37286933d882466b8592120f48eb69c34e14cdb5a23c1f37480e39a1e6ff933a. Scheduling true, SMS false. app013smstest has both true. Job still image tagfd6828a; not the reviewed migration runner. No change to traffic, jobs or flags.

Prior evidence maps shared secret to parent; current metadata references remain unchanged. This inspection covers known tagged/job consumers, not every possible external client or resolved secret version in warm instances. Do not point shared consumers at child or assume zero normal traffic makes tags unreachable.

Neon dashboard: Signmons Free;2/10branches;1.84/100CUh;0.04/0.5GBstorage;0historyGB;0/5GBnetwork. Metrics explicitly may lag an hour and are not updated for inactive projects. Child fixed0.25CU became active during authorized reads; parent displayed idle. No plan/compute setting changed; consumed compute quota is not asserted zero. No invoice or absolute billing guarantee inferred.

Mac host free34,514,648KiB. Encrypted image remained locked/unmounted this turn; its internal free space was NOT refreshed (prior measured1,871,068KiB). Actual source size is well below prior free capacity, but full archive/restore/WAL/log headroom still must be bounded in the execution packet.

## Consequence and next step

Source metadata requirement is now inspected, not waiting for another inspection approval. Finalize the one scoped credential/private-backup execution packet using these inventories. Explicitly handle managed default ACL roles, encoding/collation, exact ownership manifest and rollback, secure child-only credential delivery, ownership-enabled encrypted mount, resource caps and UTC expiry. Do not transfer ownership before a recovery plan accounts for the pre-change security state. No role creation, private export, actual restore, migration, secret access or deployment authorized by this turn.

R02 remains open for actual isolated access/recovery proof. R01 closed, R02-R12 open11; added0; packages5/60 and walkthrough3/8 unchanged; ETA unvalidated. No new acceptance or scope deviation.

Validation: documentation-only; governance baseline/full consistency,21governance tests, architecture and whitespace passed. No new runtime or browser product acceptance claimed. Final console readback remained ACTIVE at0.25CU after metadata reads; auto-suspension not yet observed this turn, and no compute setting was changed.
