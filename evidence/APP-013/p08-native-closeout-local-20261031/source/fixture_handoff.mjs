// Isolated test driver: exercises the actual owned-key handoff with fake clients.
import {readFileSync, mkdtempSync, rmSync} from 'node:fs';
import {hash} from '../../p08-live-binder-local-20261029/source/auth/auth-authority-owned.mjs';
import {runLocalOwnedAuth} from '../../p08-live-binder-local-20261029/source/auth/auth-handoff.mjs';
import {plan as bridgePlan} from '../../p08-authentication-local-20261026/source/reuse/operator-bridge.mjs';

const receipt = JSON.parse(readFileSync(0, 'utf8'));
const now = Math.floor(Date.parse(receipt.ownedAt) / 1000) * 1000;
const iso = value => new Date(value).toISOString().replace('.000', '');
const target = {id: '10000000-0000-4000-8000-000000000001',
  tenantId: 'a1adcfd4-15be-404b-9ac3-5edb1fda20f0', email: 'operator@fixture.invalid',
  fullName: 'Signmons Test Administrator', role: 'ADMIN', status: 'DISABLED'};
const ownership = {operationId: '0bac708b-c4fb-4440-b9c6-f26ded85ea73', appOwned: true,
  firebaseOwned: true, claimsSet: true, status: 'LOCAL_DISABLED_PAIR_CLOSED',
  stage: 'CLOSEOUT_FINISHED', appUncertain: false, firebaseUncertain: false,
  residuals: [], targetHash: hash(target)};
const start = now - 10_000;
const basePlan = {status: 'PROPOSED_EXACT_OPERATOR_AUTHENTICATION', mode: 'LOCAL_NATIVE_BRIDGE_ONLY',
  externalActionAuthorized: false, automaticRetryAllowed: false, allowanceUsd: 0,
  serviceRetention: 'UNDECIDED_REFUSE_LIVE', projectNumber: '123456789012',
  projectNumberSha256: hash('123456789012'), operationId: receipt.operationId, target,
  jobId: bridgePlan.jobId, ownershipSha256: hash(ownership),
  ownershipPath: '/private/tmp/p08-account-proof-0bac708b-c4fb-4440-b9c6-f26ded85ea73/journal.json',
  ownerPrincipal: target.email, ownerPrincipalHash: hash(target.email),
  database: {host: 'ep-jolly-flower-ayc6w9hv.c-5.us-east-2.aws.neon.tech', database: 'neondb',
    user: 'neondb_owner', port: 5432, tls: 'VERIFY_FULL'},
  proposalCommit: 'a'.repeat(40), proposalSha256: hash('exact proposal'),
  actions: ['ownerOAuth', 'exactAccountRead', 'conditionalActivation', 'signBlob', 'exchange',
    'exactJobRead', 'disable', 'revoke', 'sessionReadback', 'privatePurge', 'exactApiKeyRead'],
  signing: {serviceAccount: 'signmons-calldesk-p07-runtime@signmons.iam.gserviceaccount.com'},
  exchange: {keyResource: receipt.keyResource, keySha256: null},
  runtime: {origin: bridgePlan.origin, jobId: bridgePlan.jobId, tenantId: target.tenantId,
    devAuthEnabled: false, revocationRequired: true, identityQualified: true,
    restorationApproved: true, serviceAccount: 'signmons-calldesk-p07-runtime@signmons.iam.gserviceaccount.com',
    revision: 'signmons-calldesk-staging-app013p07atomic1',
    image: 'us-east5-docker.pkg.dev/signmons/signmons/signmons-calldesk-backend@sha256:36f887749947c0b01db683482c081ca663534e7ffe597560b24597f3d46be9da',
    sourceSha256: 'c'.repeat(64), qualifiedUntil: iso(start + 180_000)},
  qualification: {status: 'QUALIFIED_DATABASE', jobId: bridgePlan.jobId,
    tenantId: target.tenantId, actorId: target.id, actorRole: 'admin',
    connectedAccountSha256: bridgePlan.connectedAccountSha256, currency: 'usd',
    amountTotalCents: 12500, policyDigest: 'd'.repeat(64),
    approvedAt: iso(start - 60_000), jobUpdatedAt: iso(start - 30_000)},
  window: {start: iso(start), cutoff: iso(start + 40_000), workEnd: iso(start + 80_000),
    cleanupEnd: iso(start + 120_000), purgeEnd: iso(start + 150_000)}};
const ownerApproval = {owner: 'Debynyhan Banks', decision: 'APPROVE_LOCAL_OWNED_KEY_DERIVATION',
  externalActionAuthorized: false, operationId: receipt.operationId,
  basePlanSha256: hash(basePlan), proposalCommit: basePlan.proposalCommit,
  proposalSha256: basePlan.proposalSha256, questionCallId: 'call_SYNTHETIC_LOCAL_ONLY',
  sourceManifestSha256: hash({})};
const context = {localOnly: true, ownership, proposal: 'exact proposal', sources: {}, now: () => now};
let row = {...target, updatedAt: '2026-01-01T00:00:00.000Z'};
let user = {uid: row.id, email: row.email, displayName: row.fullName, disabled: true,
  emailVerified: false, customClaims: {tenantId: row.tenantId, role: 'admin', testOnly: true},
  tokensValidAfterTime: new Date(0).toISOString()};
const clientsFactory = async () => ({
  db: {get: async () => ({...row}), activate: async version => {
    if (version !== row.updatedAt) throw Error('VERSION');
    row.status = 'ACTIVE'; row.updatedAt = '2026-01-01T00:00:01.000Z'; return {...row};
  }, disable: async version => {
    if (version !== row.updatedAt) throw Error('VERSION'); row.status = 'DISABLED'; return {...row};
  }},
  fb: {get: async () => structuredClone(user), enable: async () => {user.disabled = false;},
    disable: async () => {user.disabled = true;},
    revoke: async () => {user.tokensValidAfterTime = new Date(now).toISOString();}},
  issue: async () => 'SYNTHETIC_IN_MEMORY_TOKEN', authenticate: async token => {
    if (token !== 'SYNTHETIC_IN_MEMORY_TOKEN') throw Error('TOKEN');},
  dropToken() {}, clear() {}, async close() {return true;}
});
const directory = mkdtempSync('/private/tmp/p08-auth-proof-');
try {
  const result = await runLocalOwnedAuth({basePlan, ownerApproval, receipt, context,
    clientsFactory, directory, stepTimeout: 25});
  if (row.status !== 'DISABLED' || !user.disabled || result.liveAuthorization !== false)
    throw Error('LOCAL_CLOSEOUT');
  process.stdout.write(JSON.stringify(result));
} finally {rmSync(directory, {recursive: true});}
