import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID, createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync} from 'node:fs';
import {authorize, gate, close, hash, planHash, verifySources, native} from './authority.mjs';
import {database, adapters, SQL} from './client.mjs';
import {CoordinatorAuthSequence} from './sequence.mjs';
import {plan as bridgePlan} from '../../p08-authentication-local-20261026/source/reuse/operator-bridge.mjs';

const TARGET = Object.freeze({id: '10000000-0000-4000-8000-000000000001',
  tenantId: bridgePlan.tenantId, email: 'debynyhan@signmons.com',
  fullName: 'Signmons Test Administrator', role: 'ADMIN'});
const iso = n => new Date(n).toISOString().replace('.000', '');
function fixture(t) {
  const OP = randomUUID();
  const start = Math.floor(Date.now() / 1000) * 1000 - 1000;
  const clock = {value: start + 1500};
  const plan = {mode: 'LOCAL_INTEGRATED_PACKET_ONLY', externalActionAuthorized: false,
    automaticRetryAllowed: false, allowanceUsd: 0, serviceRetention: 'RETAIN_ENABLED_AFTER_KEY_DELETE',
    project: 'signmons', projectNumber: '123456789012',
    projectNumberSha256: hash('123456789012'), operationId: OP,
    tenantId: TARGET.tenantId, jobId: bridgePlan.jobId, ownerPrincipal: TARGET.email,
    runtimeIdentity: 'signmons-calldesk-p07-runtime@signmons.iam.gserviceaccount.com',
    keyId: 'signmons-p08-' + OP.replaceAll('-', ''),
    window: {start: iso(start), cutoff: iso(start + 10000), workEnd: iso(start + 30000),
      cleanupEnd: iso(start + 45000), purgeEnd: iso(start + 50000)}};
  const approval = {decision: 'APPROVE_LOCAL_SINGLE_COORDINATOR', externalActionAuthorized: false,
    operationId: OP, planSha256: planHash(plan)};
  const receipt = {operationId: OP,
    keyResource: `projects/${plan.projectNumber}/locations/global/keys/${plan.keyId}`,
    uid: 'synthetic-uid', etag: 'synthetic-etag', displayName: `Signmons P08 ${OP}`,
    restrictions: {apiTargets: [{service: 'identitytoolkit.googleapis.com'}]},
    keyStringSha256: hash('synthetic-key'), createdInOperation: true, deleted: false,
    ownedAt: iso(start)};
  const runtime = {origin: bridgePlan.origin, jobId: plan.jobId, tenantId: plan.tenantId,
    revocationRequired: true, devAuthEnabled: false, identityQualified: true,
    restorationApproved: true, serviceAccount: plan.runtimeIdentity};
  const root = `/private/tmp/p08-coordinator-${OP}`;
  mkdirSync(root, {mode: 0o700}); chmodSync(root, 0o700);
  const journalPath = root + '/journal.json';
  writeFileSync(journalPath, JSON.stringify({operationId: OP, planSha256: planHash(plan),
    phase: 'PREFLIGHT', authAttempted: true, keyCreateAttempted: true,
    keyUidSha256: hash(receipt.uid), keyDeleteAttempted: false,
    authProofAccepted: false}), {mode: 0o600, flag: 'wx'});
  t.after(() => rmSync(root, {recursive: true, force: true}));
  return {plan, approval, receipt, runtime, journalPath, target: TARGET, clock,
    now: () => clock.value};
}

function cap(f, extra = {}) {
  return authorize(f.plan, f.approval, {target: f.target, receipt: f.receipt,
    runtime: f.runtime, journalPath: f.journalPath, now: f.now, ...extra});
}

test('source-pinned extraction, local authority and native refusal', (t) => {
  assert.equal(verifySources(), true);
  const manifest = JSON.parse(readFileSync(new URL('./source-manifest.json', import.meta.url)));
  assert.equal(manifest.status, 'DISABLED_LOCAL_ONLY');
  for (const [name, digest] of Object.entries(manifest.files)) {
    if (name === 'test_client.mjs') continue;
    assert.equal(createHash('sha256').update(readFileSync(new URL('./' + name, import.meta.url)))
      .digest('hex'), digest);
  }
  const f = fixture(t);
  const c = cap(f);
  assert.equal(gate(c).p.exchange.keySha256, f.receipt.keyStringSha256);
  assert.throws(() => gate({}), {code: 'CAPABILITY_REQUIRED'});
  assert.throws(() => native(), {code: 'P08_COORDINATOR_AUTH_NATIVE_DISABLED'});
  assert.throws(() => adapters(c, {}), {code: 'INJECTED_TRANSPORT_REQUIRED'});
  close(c);
  assert.throws(() => gate(c), {code: 'CAPABILITY_REQUIRED'});
});

test('approval, owner, owned key, source scope and timing refuse before transport', (t) => {
  for (const mutate of [
    f => {f.approval.externalActionAuthorized = true;},
    f => {f.plan.externalActionAuthorized = true;},
    f => {f.receipt.keyResource += '-foreign';},
    f => {f.receipt.restrictions.apiTargets[0].service = 'foreign.googleapis.com';},
    f => {f.runtime.origin = 'https://foreign.run.app';},
    f => {f.target = {...f.target, tenantId: '20000000-0000-4000-8000-000000000001'};},
    f => {f.clock.value = Date.parse(f.plan.window.cutoff);},
  ]) {
    const f = fixture(t); mutate(f);
    assert.throws(() => cap(f));
  }
});

test('deadline, clock rollback and interruption are checked on every client step', (t) => {
  const f = fixture(t); const signal = {aborted: false}; const c = cap(f, {signal});
  f.clock.value += 1000; assert.ok(gate(c));
  f.clock.value -= 2000; assert.throws(() => gate(c), {code: 'CLOCK_ROLLBACK'});
  f.clock.value += 3000; signal.aborted = true;
  assert.throws(() => gate(c), {code: 'INTERRUPTED'});
  assert.ok(gate(c, true));
  f.clock.value = Date.parse(f.plan.window.cleanupEnd);
  assert.throws(() => gate(c, true), {code: 'OPERATION_DEADLINE'});
});

test('single coordinator journal owns authentication and drift stops later work', (t) => {
  const f = fixture(t);
  const c = cap(f);
  const journal = {operationId: f.plan.operationId, planSha256: planHash(f.plan),
    phase: 'CLOSED', authAttempted: true, keyCreateAttempted: true,
    keyUidSha256: hash(f.receipt.uid), keyDeleteAttempted: false,
    authProofAccepted: false};
  writeFileSync(f.journalPath, JSON.stringify(journal), {mode: 0o600});
  assert.throws(() => gate(c), {code: 'JOURNAL_OWNERSHIP'});
  assert.throws(() => cap(f), {code: 'JOURNAL_OWNERSHIP'});
  close(c);
});

test('historical SQL text and conditional activation/disable remain exact', async (t) => {
  const f = fixture(t); const c = cap(f);
  let row = {...f.target, status: 'DISABLED', updatedAt: '2026-01-01T00:00:00.000Z'};
  const seen = [];
  const pg = {async query(text, params) {
    seen.push({text, params});
    if (text === SQL.get) return {rows: [{...row}], rowCount: 1};
    if (text === SQL.activate) {
      if (params[4] !== row.updatedAt || row.status !== 'DISABLED') return {rows: [], rowCount: 0};
      row = {...row, status: 'ACTIVE', updatedAt: '2026-01-01T00:00:01.000Z'};
      return {rows: [{...row}], rowCount: 1};
    }
    if (text === SQL.disable) {
      if (params[4] !== row.updatedAt || row.status !== 'ACTIVE') return {rows: [], rowCount: 0};
      row = {...row, status: 'DISABLED', updatedAt: '2026-01-01T00:00:02.000Z'};
      return {rows: [{...row}], rowCount: 1};
    }
    throw Error('UNLISTED_SQL');
  }};
  const db = database(pg, f.target, cleanup => gate(c, cleanup));
  const before = await db.get();
  const active = await db.activate(before.updatedAt);
  assert.equal(active.status, 'ACTIVE');
  await assert.rejects(() => db.activate(before.updatedAt), {code: 'ACTIVATION_CONFLICT'});
  const disabled = await db.disable(active.updatedAt);
  assert.equal(disabled.status, 'DISABLED');
  assert.deepEqual(seen.map(x => x.text), [SQL.get, SQL.activate, SQL.activate, SQL.disable]);
  assert.equal(seen[0].params[0], TARGET.id);
  assert.equal(seen[0].params[1], TARGET.tenantId);
  close(c);
});

test('injected Firebase and signing/exchange keep exact identity and one issuance', async (t) => {
  const f = fixture(t); const c = cap(f);
  const state = {disabled: true, validSince: 0, claims: {tenantId: TARGET.tenantId,
    role: 'admin', testOnly: true}};
  const requests = [];
  const tokenPayload = {sub: TARGET.id, tenantId: TARGET.tenantId, role: 'admin', testOnly: true,
    iss: 'https://securetoken.google.com/signmons', aud: 'signmons',
    exp: Math.floor(Date.now()/1000) + 300, iat: Math.floor(Date.now()/1000)};
  const idToken = 'header.' + Buffer.from(JSON.stringify(tokenPayload)).toString('base64url') + '.signature';
  const fetcher = async (url, opts) => {
    requests.push({url, opts});
    const body = opts.body ? JSON.parse(opts.body) : null;
    let value;
    if (url.endsWith('/accounts:lookup')) value = {users: [{localId: TARGET.id,
      email: TARGET.email, displayName: TARGET.fullName, disabled: state.disabled,
      emailVerified: false, customAttributes: JSON.stringify(state.claims),
      validSince: String(state.validSince)}]};
    else if (url.endsWith('/accounts:update')) {
      if ('disableUser' in body) state.disabled = body.disableUser;
      if ('validSince' in body) state.validSince = body.validSince;
      value = {localId: TARGET.id};
    } else if (url.includes(':signBlob')) value = {signedBlob: Buffer.from('synthetic-signature').toString('base64')};
    else if (url.endsWith('/keyString')) value = {keyString: 'synthetic-key'};
    else if (url.includes('signInWithCustomToken')) value = {localId: TARGET.id, idToken};
    else if (url === `${bridgePlan.origin}/jobs/dispatch-board/${bridgePlan.jobId}`) value = {jobId: bridgePlan.jobId};
    else throw Error('UNLISTED_URL');
    return {ok: true, text: async () => JSON.stringify(value)};
  };
  const api = adapters(c, {accessToken: 'synthetic-owner-oauth', fetcher});
  assert.equal((await api.fb.get()).disabled, true);
  await api.fb.enable();
  assert.equal((await api.fb.get()).disabled, false);
  const issued = await api.issue();
  assert.equal(issued, idToken);
  await assert.rejects(() => api.issue(), {code: 'TOKEN_ISSUANCE_ALREADY_ATTEMPTED'});
  assert.deepEqual(await api.authenticate(issued), {authenticated: true, actorId: TARGET.id});
  await api.fb.disable(); await api.fb.revoke();
  assert.equal((await api.fb.get()).disabled, true);
  assert.ok(state.validSince > 0);
  api.dropToken();
  await assert.rejects(() => api.authenticate(issued), {code: 'EXACT_TOKEN_REQUIRED'});
  api.clear(); close(c);
  assert.ok(requests.every(x => x.opts.redirect === 'error'));
});

test('lost signing response clears token and does not imply authentication', async (t) => {
  const f = fixture(t); const c = cap(f); let calls = 0;
  const api = adapters(c, {accessToken: 'synthetic', fetcher: async () => {
    calls++; throw Error('LOST_RESPONSE');
  }});
  await assert.rejects(() => api.issue(), {code: 'SIGN_EXCHANGE_REFUSED'});
  await assert.rejects(() => api.issue(), {code: 'TOKEN_ISSUANCE_ALREADY_ATTEMPTED'});
  assert.equal(calls, 1);
  api.clear(); close(c);
});

function fakeSequenceClients(f, {lostActivation = false, sessionFailure = false} = {}) {
  let row = {...f.target, status: 'DISABLED', updatedAt: '2026-01-01T00:00:00.000Z'};
  let user = {uid: f.target.id, email: f.target.email, displayName: f.target.fullName,
    disabled: true, emailVerified: false,
    customClaims: {tenantId: f.target.tenantId, role: 'admin', testOnly: true},
    tokensValidAfterTime: new Date(0).toISOString()};
  const state = {get row() {return row;}, get user() {return user;}, cleared: false, closed: false};
  const clients = {
    db: {get: async () => ({...row}), activate: async version => {
      assert.equal(version, row.updatedAt); row = {...row, status: 'ACTIVE',
        updatedAt: '2026-01-01T00:00:01.000Z'};
      if (lostActivation) throw Error('LOST_ACTIVATION_RESPONSE');
      return {...row};
    }, disable: async version => {
      assert.equal(version, row.updatedAt); row = {...row, status: 'DISABLED',
        updatedAt: '2026-01-01T00:00:02.000Z'}; return {...row};
    }},
    fb: {get: async () => structuredClone(user), enable: async () => {user.disabled = false;},
      disable: async () => {user.disabled = true;},
      revoke: async () => {user.tokensValidAfterTime = new Date().toISOString();}},
    issue: async () => 'SYNTHETIC_TOKEN_IN_MEMORY',
    authenticate: async token => assert.equal(token, 'SYNTHETIC_TOKEN_IN_MEMORY'),
    dropToken() {}, clear() {state.cleared = true;},
    async close() {if (sessionFailure) throw Error('SESSION_UNKNOWN'); state.closed = true;},
  };
  return {clients, state};
}

test('one coordinator journal owns activation, authentication and cleanup', async (t) => {
  const f = fixture(t); const c = cap(f); const {clients, state} = fakeSequenceClients(f);
  const result = await new CoordinatorAuthSequence(c, clients).run();
  assert.equal(result.status, 'P08_COORDINATOR_AUTHENTICATED_AND_CLOSED');
  assert.equal(result.authenticated, true);
  assert.deepEqual(result.residuals, []);
  assert.equal(state.row.status, 'DISABLED');
  assert.equal(state.user.disabled, true);
  assert.ok(state.closed && state.cleared);
  const journal = JSON.parse((await import('node:fs')).readFileSync(f.journalPath));
  assert.equal(journal.authClient.phase, 'CLOSEOUT_FINISHED');
  assert.equal(journal.authClient.authenticated, true);
  assert.equal(journal.authClient.sessionClosed, true);
  assert.ok(!JSON.stringify(journal).includes('SYNTHETIC_TOKEN_IN_MEMORY'));
  await assert.rejects(() => new CoordinatorAuthSequence(c, clients).run(),
    {code: 'JOURNAL_CONCURRENT_DRIFT'});
  close(c);
});

test('lost activation response retains uncertainty and never disables an unowned version', async (t) => {
  const f = fixture(t); const c = cap(f); const {clients, state} = fakeSequenceClients(f, {lostActivation: true});
  const result = await new CoordinatorAuthSequence(c, clients).run();
  assert.equal(result.authenticated, false);
  assert.equal(result.status, 'P08_COORDINATOR_AUTH_CONTAINMENT_UNCONFIRMED');
  assert.ok(result.residuals.includes('ACTIVATION_OUTCOME_UNKNOWN'));
  assert.equal(state.row.status, 'ACTIVE');
  assert.equal(state.user.disabled, true);
  assert.ok(state.cleared);
  close(c);
});

test('session closeout failure is a residual, not a success label', async (t) => {
  const f = fixture(t); const c = cap(f); const {clients} = fakeSequenceClients(f, {sessionFailure: true});
  const result = await new CoordinatorAuthSequence(c, clients).run();
  assert.equal(result.status, 'P08_COORDINATOR_AUTH_CONTAINMENT_UNCONFIRMED');
  assert.ok(result.residuals.includes('SESSION_CLOSEOUT'));
  assert.equal(result.sessionClosed, false);
  close(c);
});

test('independent closeout after cutoff uses the same journal and no mutation replay', async (t) => {
  const f = fixture(t); const {clients, state} = fakeSequenceClients(f);
  const j = JSON.parse((await import('node:fs')).readFileSync(f.journalPath));
  j.authClient = {operationId: f.plan.operationId, version: 1, phase: 'ACTIVATE_INTENT',
    activationIntent: true, firebaseEnableIntent: false, tokenIssueIntent: false,
    authenticated: false, closeoutAttempted: false, activatedVersion: null,
    disabledVersion: null, residuals: []};
  writeFileSync(f.journalPath, JSON.stringify(j));
  f.clock.value = Date.parse(f.plan.window.cutoff) + 1000;
  const c = cap(f, {mode: 'closeout'});
  const result = await new CoordinatorAuthSequence(c, clients).closeout(true);
  assert.equal(result.status, 'P08_COORDINATOR_AUTH_CONTAINMENT_UNCONFIRMED');
  assert.ok(result.residuals.includes('ACTIVATION_OUTCOME_UNKNOWN'));
  assert.equal(state.row.status, 'DISABLED');
  assert.equal(result.sessionClosed, true);
  close(c);
});
