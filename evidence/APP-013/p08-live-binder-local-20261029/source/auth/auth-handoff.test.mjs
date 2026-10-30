import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, readFileSync} from 'node:fs';
import {hash} from './auth-authority-owned.mjs';
import {runLocalOwnedAuth, native, verifyBundle} from './auth-handoff.mjs';
import {plan as bridgePlan} from '../../../p08-authentication-local-20261026/source/reuse/operator-bridge.mjs';

const number = '123456789012';
const operationId = '30000000-0000-4000-8000-000000000001';
const uid = '10000000-0000-4000-8000-000000000001';
const keyResource = `projects/${number}/locations/global/keys/signmons-p08-${operationId.replaceAll('-', '')}`;
const iso = value => new Date(value).toISOString().replace('.000', '');

function fixture() {
  const now = Math.floor(Date.now() / 1000) * 1000;
  const target = {id: uid, tenantId: 'a1adcfd4-15be-404b-9ac3-5edb1fda20f0',
    email: 'operator@fixture.invalid', fullName: 'Signmons Test Administrator', role: 'ADMIN', status: 'DISABLED'};
  const ownership = {operationId: '0bac708b-c4fb-4440-b9c6-f26ded85ea73', appOwned: true,
    firebaseOwned: true, claimsSet: true, status: 'LOCAL_DISABLED_PAIR_CLOSED',
    stage: 'CLOSEOUT_FINISHED', appUncertain: false, firebaseUncertain: false,
    residuals: [], targetHash: hash(target)};
  const start = now - 10_000;
  const basePlan = {status: 'PROPOSED_EXACT_OPERATOR_AUTHENTICATION', mode: 'LOCAL_NATIVE_BRIDGE_ONLY',
    externalActionAuthorized: false, automaticRetryAllowed: false, allowanceUsd: 0,
    serviceRetention: 'UNDECIDED_REFUSE_LIVE', projectNumber: number, projectNumberSha256: hash(number),
    operationId, target, jobId: bridgePlan.jobId, ownershipSha256: hash(ownership),
    ownershipPath: '/private/tmp/p08-account-proof-0bac708b-c4fb-4440-b9c6-f26ded85ea73/journal.json',
    ownerPrincipal: target.email, ownerPrincipalHash: hash(target.email),
    database: {host: 'ep-jolly-flower-ayc6w9hv.c-5.us-east-2.aws.neon.tech', database: 'neondb',
      user: 'neondb_owner', port: 5432, tls: 'VERIFY_FULL'},
    proposalCommit: 'a'.repeat(40), proposalSha256: hash('exact proposal'),
    actions: ['ownerOAuth', 'exactAccountRead', 'conditionalActivation', 'signBlob', 'exchange',
      'exactJobRead', 'disable', 'revoke', 'sessionReadback', 'privatePurge', 'exactApiKeyRead'],
    signing: {serviceAccount: 'signmons-calldesk-p07-runtime@signmons.iam.gserviceaccount.com'},
    exchange: {keyResource, keySha256: null},
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
    externalActionAuthorized: false, operationId, basePlanSha256: hash(basePlan),
    proposalCommit: basePlan.proposalCommit, proposalSha256: basePlan.proposalSha256,
    questionCallId: 'call_SYNTHETIC_LOCAL_ONLY', sourceManifestSha256: hash({})};
  const receipt = {operationId, keyResource, uid, etag: 'etag1',
    displayName: `Signmons P08 ${operationId}`,
    restrictions: {apiTargets: [{service: 'identitytoolkit.googleapis.com'}]},
    keyStringSha256: hash('synthetic-only-key'), createdInOperation: true,
    deleted: false, ownedAt: iso(now)};
  const context = {localOnly: true, ownership, proposal: 'exact proposal', sources: {}, now: () => now};
  return {basePlan, ownerApproval, receipt, context};
}

function clients(f, {failIssue = false, failClose = false} = {}) {
  let row = {...f.basePlan.target, updatedAt: '2026-01-01T00:00:00.000Z'};
  let user = {uid: row.id, email: row.email, displayName: row.fullName,
    disabled: true, emailVerified: false,
    customClaims: {tenantId: row.tenantId, role: 'admin', testOnly: true},
    tokensValidAfterTime: new Date(0).toISOString()};
  const calls = [];
  const api = {calls, get row() { return row; }, get user() { return user; },
    db: {get: async () => ({...row}), activate: async version => {
      assert.equal(version, row.updatedAt); calls.push('activate'); row.status = 'ACTIVE';
      row.updatedAt = '2026-01-01T00:00:01.000Z'; return {...row};
    }, disable: async version => {
      assert.equal(version, row.updatedAt); calls.push('disable'); row.status = 'DISABLED'; return {...row};
    }},
    fb: {get: async () => structuredClone(user), enable: async () => {calls.push('enable'); user.disabled = false;},
      disable: async () => {calls.push('firebaseDisable'); user.disabled = true;},
      revoke: async () => {calls.push('revoke'); user.tokensValidAfterTime = new Date(f.context.now()).toISOString();}},
    issue: async () => {calls.push('issue'); if (failIssue) throw Error('PRIVATE_TOKEN_FAILURE'); return 'SYNTHETIC_IN_MEMORY_TOKEN';},
    authenticate: async token => {assert.equal(token, 'SYNTHETIC_IN_MEMORY_TOKEN'); calls.push('authenticate');},
    dropToken() {calls.push('dropToken');}, clear() {calls.push('clear');},
    async close() {calls.push('close'); if (failClose) throw Error('SESSION_CLOSE_FAILED'); return true;}};
  return api;
}

async function execute(f, c) {
  const directory = mkdtempSync('/private/tmp/p08-auth-proof-');
  try {
    const result = await runLocalOwnedAuth({...f, clientsFactory: async () => c, directory, stepTimeout: 25});
    return {result, journal: readFileSync(directory + '/journal.json', 'utf8')};
  } finally {rmSync(directory, {recursive: true});}
}

test('owned numeric-project receipt traverses actual controller and closes account', async () => {
  const f = fixture(), c = clients(f), {result, journal} = await execute(f, c);
  assert.equal(result.status, 'P08_OPERATOR_AUTHENTICATED_AND_CLOSED');
  assert.equal(result.authenticated, true);
  assert.deepEqual(result.residuals, []);
  assert.equal(result.sessionsAbsent, true);
  assert.equal(result.liveAuthorization, false);
  assert.equal(result.authProofReady, false);
  assert.equal(c.row.status, 'DISABLED');
  assert.equal(c.user.disabled, true);
  assert.deepEqual(c.calls.filter(x => ['activate', 'enable', 'issue', 'authenticate',
    'firebaseDisable', 'revoke', 'disable'].includes(x)),
  ['activate', 'enable', 'issue', 'authenticate', 'firebaseDisable', 'revoke', 'disable']);
  assert(!journal.includes('SYNTHETIC_IN_MEMORY_TOKEN'));
});

test('foreign or deleted key refuses before account mutation', async () => {
  for (const edit of [f => {f.receipt.deleted = true;},
    f => {f.receipt.keyResource = f.receipt.keyResource.replace(number, '999999999999');}]) {
    const f = fixture(), c = clients(f); edit(f);
    await assert.rejects(() => execute(f, c));
    assert(!c.calls.includes('activate'));
  }
});

test('lost token issue still disables and revokes, without logging secret', async () => {
  const f = fixture(), c = clients(f, {failIssue: true});
  const {result, journal} = await execute(f, c);
  assert.equal(result.authenticated, false);
  assert.equal(c.row.status, 'DISABLED');
  assert.equal(c.user.disabled, true);
  assert(!journal.includes('PRIVATE_TOKEN_FAILURE'));
  assert.deepEqual(result.residuals, []);
});

test('session closeout failure is an explicit residual', async () => {
  const f = fixture(), c = clients(f, {failClose: true});
  const {result} = await execute(f, c);
  assert.equal(result.status, 'P08_AUTH_HANDOFF_CLOSEOUT_UNCONFIRMED');
  assert(result.residuals.includes('DATABASE_SESSION_READBACK'));
  assert.equal(result.sessionsAbsent, false);
});

test('source lock and native refusal', () => {
  assert.equal(verifyBundle(), true);
  assert.equal(native(), 2);
});
