import test from 'node:test';
import assert from 'node:assert/strict';
import {hash} from './auth-authority-owned.mjs';
import {deriveOwnedKeyAuthority, native} from './owned-key-authority.mjs';
import {plan as bridgePlan} from '../../p08-authentication-local-20261026/source/reuse/operator-bridge.mjs';
import {readFileSync} from 'node:fs';

const number = '123456789012';
const operationId = '30000000-0000-4000-8000-000000000001';
const uid = '10000000-0000-4000-8000-000000000001';
const keyResource = `projects/${number}/locations/global/keys/signmons-p08-${operationId.replaceAll('-', '')}`;
const iso = value => new Date(value).toISOString().replace('.000', '');

function fixture(customReceipt = null) {
  const now = Math.floor(Date.now() / 1000) * 1000;
  const op = customReceipt?.operationId ?? operationId;
  const resource = customReceipt?.keyResource ?? keyResource;
  const target = {id: uid, tenantId: 'a1adcfd4-15be-404b-9ac3-5edb1fda20f0',
    email: 'operator@fixture.invalid', fullName: 'Signmons Test Administrator', role: 'ADMIN', status: 'DISABLED'};
  const ownership = {operationId: '0bac708b-c4fb-4440-b9c6-f26ded85ea73', appOwned: true,
    firebaseOwned: true, claimsSet: true, status: 'LOCAL_DISABLED_PAIR_CLOSED',
    stage: 'CLOSEOUT_FINISHED', appUncertain: false, firebaseUncertain: false,
    residuals: [], targetHash: hash(target)};
  const start = now - 10_000;
  const p = {status: 'PROPOSED_EXACT_OPERATOR_AUTHENTICATION', mode: 'LOCAL_NATIVE_BRIDGE_ONLY',
    externalActionAuthorized: false, automaticRetryAllowed: false, allowanceUsd: 0,
    serviceRetention: 'UNDECIDED_REFUSE_LIVE', projectNumber: number, projectNumberSha256: hash(number),
    operationId: op, target, jobId: bridgePlan.jobId, ownershipSha256: hash(ownership),
    ownershipPath: '/private/tmp/p08-account-proof-0bac708b-c4fb-4440-b9c6-f26ded85ea73/journal.json',
    ownerPrincipal: target.email, ownerPrincipalHash: hash(target.email),
    database: {host: 'ep-jolly-flower-ayc6w9hv.c-5.us-east-2.aws.neon.tech', database: 'neondb',
      user: 'neondb_owner', port: 5432, tls: 'VERIFY_FULL'},
    proposalCommit: 'a'.repeat(40), proposalSha256: hash('exact proposal'),
    actions: ['ownerOAuth','exactAccountRead','conditionalActivation','signBlob','exchange',
      'exactJobRead','disable','revoke','sessionReadback','privatePurge','exactApiKeyRead'],
    signing: {serviceAccount: 'signmons-calldesk-p07-runtime@signmons.iam.gserviceaccount.com'},
    exchange: {keyResource: resource, keySha256: null},
    runtime: {origin: bridgePlan.origin, jobId: bridgePlan.jobId, tenantId: target.tenantId,
      devAuthEnabled: false, revocationRequired: true, identityQualified: true,
      restorationApproved: true, serviceAccount: 'signmons-calldesk-p07-runtime@signmons.iam.gserviceaccount.com',
      revision: 'signmons-calldesk-staging-app013p07atomic1',
      image: 'us-east5-docker.pkg.dev/signmons/signmons/signmons-calldesk-backend@sha256:36f887749947c0b01db683482c081ca663534e7ffe597560b24597f3d46be9da',
      sourceSha256: 'c'.repeat(64), qualifiedUntil: iso(start + 180_000)},
    qualification: {status: 'QUALIFIED_DATABASE', jobId: bridgePlan.jobId,
      tenantId: target.tenantId, actorId: target.id, actorRole: 'admin',
      connectedAccountSha256: bridgePlan.connectedAccountSha256, currency: 'usd', amountTotalCents: 12500,
      policyDigest: 'd'.repeat(64), approvedAt: iso(start - 60_000), jobUpdatedAt: iso(start - 30_000)},
    window: {start: iso(start), cutoff: iso(start + 40_000), workEnd: iso(start + 80_000),
      cleanupEnd: iso(start + 120_000), purgeEnd: iso(start + 150_000)}};
  const a = {owner: 'Debynyhan Banks', decision: 'APPROVE_LOCAL_OWNED_KEY_DERIVATION',
    externalActionAuthorized: false, operationId: op, basePlanSha256: hash(p),
    proposalCommit: p.proposalCommit, proposalSha256: p.proposalSha256,
    questionCallId: 'call_SYNTHETIC_LOCAL_ONLY', sourceManifestSha256: hash({})};
  const receipt = customReceipt ?? {operationId: op, keyResource: resource, uid, etag: 'etag1',
    displayName: `Signmons P08 ${op}`, restrictions: {apiTargets: [{service: 'identitytoolkit.googleapis.com'}]},
    keyStringSha256: hash('synthetic-only-key'), createdInOperation: true, deleted: false, ownedAt: iso(now)};
  const context = {localOnly: true, ownership, proposal: 'exact proposal', sources: {}, now: () => now};
  return {p, a, receipt, context};
}

test('owned canonical key derives hash and traverses unchanged authentication gates locally', () => {
  const f = fixture();
  const result = deriveOwnedKeyAuthority(f.p, f.a, f.receipt, f.context);
  assert.equal(result.keyResource, keyResource);
  assert.equal(result.liveAuthorization, false);
  assert.match(result.derivedPlanSha256, /^[a-f0-9]{64}$/);
  assert.equal(f.p.exchange.keySha256, null);
});

for (const [name, modify] of [
  ['foreign project', f => { f.receipt.keyResource = f.receipt.keyResource.replace(number, '999999999999'); }],
  ['wrong key hash', f => { f.receipt.keyStringSha256 = null; }],
  ['foreign UID', f => { f.receipt.uid = 'foreign'; }],
  ['broader key restriction', f => { f.receipt.restrictions.apiTargets.push({service: 'other.googleapis.com'}); }],
  ['deleted key', f => { f.receipt.deleted = true; }],
  ['stale ownership time', f => { f.receipt.ownedAt = iso(0); }],
  ['changed base plan', f => { f.p.target.email = 'foreign@fixture.invalid'; }],
  ['missing owner derivation', f => { f.a.decision = 'OTHER'; }],
  ['not local', f => { f.context.localOnly = false; }],
]) test(`${name} refuses before usable authority`, () => {
  const f = fixture(); modify(f);
  assert.throws(() => deriveOwnedKeyAuthority(f.p, f.a, f.receipt, f.context));
});

test('native entry refuses unbound', () => assert.equal(native(), 2));

if (process.env.P08_SYNTHETIC_PIPE === '1') {
  test('Python-produced serialized owned-key receipt traverses JS authority', () => {
    const receipt = JSON.parse(readFileSync(0, 'utf8'));
    const f = fixture(receipt);
    const result = deriveOwnedKeyAuthority(f.p, f.a, f.receipt, f.context);
    assert.equal(result.keyResource, receipt.keyResource);
    assert.equal(result.liveAuthorization, false);
  });
}
