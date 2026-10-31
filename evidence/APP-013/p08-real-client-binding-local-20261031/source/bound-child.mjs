import {readSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {authorize, close, verifySources, need, planHash, exactApp, exactIdentity} from '../../p08-coordinator-auth-local-20261031/source/authority.mjs';
import {CoordinatorAuthSequence} from './recovery-sequence.mjs';
import {boundClients, PREFLIGHT_SQL} from './bound-clients.mjs';
import {SQL} from '../../p08-coordinator-auth-local-20261031/source/client.mjs';

const MAX_INPUT = 65536;
const MODES = new Set(['--fixture-auth', '--fixture-closeout']);
const SCENARIOS = new Set(['normal', 'lost_output', 'lost_activation', 'session_failure', 'hang', 'exit']);
function input() {
  const bytes = Buffer.alloc(MAX_INPUT + 1); let used = 0;
  while (used < bytes.length) {const n = readSync(0, bytes, used, bytes.length - used, null); if (!n) break; used += n;}
  need(used > 0 && used <= MAX_INPUT, 'INPUT_BOUNDS');
  const v = JSON.parse(bytes.subarray(0, used).toString('utf8'));
  need(v && Object.keys(v).sort().join(',') ===
    'approval,fixtureNow,journalPath,localOnly,plan,receipt,runtime,scenario,target', 'INPUT_SHAPE');
  need(v.localOnly === true && SCENARIOS.has(v.scenario) &&
    typeof v.fixtureNow === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(v.fixtureNow),
    'LOCAL_FIXTURE_ONLY');
  return v;
}
function fixturePorts(v, journal) {
  const prior = journal.authClient, target = v.target, now = Date.parse(v.fixtureNow);
  const state = {row: {...target, status: prior?.activatedVersion && !prior?.disabledVersion ? 'ACTIVE' : 'DISABLED',
    updatedAt: prior?.disabledVersion ?? prior?.activatedVersion ?? '2026-01-01T00:00:00.000Z'},
    firebaseDisabled: !prior?.firebaseEnableIntent || prior?.phase === 'CLOSEOUT_FINISHED',
    validSince: prior?.phase === 'CLOSEOUT_FINISHED' ? Math.floor(now / 1000) : 0,
    sessionOpen: false};
  const tokenPayload = {sub: target.id, tenantId: target.tenantId, role: 'admin', testOnly: true,
    iss: 'https://securetoken.google.com/signmons', aud: 'signmons',
    exp: Math.floor(now / 1000) + 300, iat: Math.floor(now / 1000)};
  const idToken = 'header.' + Buffer.from(JSON.stringify(tokenPayload)).toString('base64url') + '.signature';
  const dbFactory = async (config, password, name) => {
    need(config.host === 'fixture.invalid' && config.port === 5432 &&
      config.database === 'fixture_child' && config.user === 'fixture_admin' &&
      password === 'SYNTHETIC_HIDDEN_PASSWORD' && name === 'p08-auth-' + v.plan.operationId,
      'FIXTURE_DATABASE_SCOPE');
    return {connection: {stream: {encrypted: true, authorized: true}},
      async connect() {state.sessionOpen = true;},
      async end() {state.sessionOpen = false;},
      async query(sql, args) {
        if (sql === PREFLIGHT_SQL) {need(args[0] === target.tenantId, 'PREFLIGHT_TENANT');
          return {rows: [{database: 'fixture_child', username: 'fixture_admin', status: 'ACTIVE'}]};}
        if (sql === SQL.get) return {rows: [{...state.row}], rowCount: 1};
        if (sql === SQL.activate) {
          need(state.row.status === 'DISABLED' && args[4] === state.row.updatedAt, 'ACTIVATE_VERSION');
          state.row = {...state.row, status: 'ACTIVE', updatedAt: '2026-01-01T00:00:01.000Z'};
          if (v.scenario === 'lost_activation') throw Error('SYNTHETIC_RESPONSE_LOST');
          return {rows: [{...state.row}], rowCount: 1};
        }
        if (sql === SQL.disable) {
          need(state.row.status === 'ACTIVE' && args[4] === state.row.updatedAt, 'DISABLE_VERSION');
          state.row = {...state.row, status: 'DISABLED', updatedAt: '2026-01-01T00:00:02.000Z'};
          return {rows: [{...state.row}], rowCount: 1};
        }
        throw Error('UNLISTED_SQL');
      }};
  };
  const fetcher = async (url, opts) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    let value;
    if (url.endsWith('/accounts:lookup')) value = {users: [{localId: target.id,
      email: target.email, displayName: target.fullName, disabled: state.firebaseDisabled,
      emailVerified: false,
      customAttributes: JSON.stringify({tenantId: target.tenantId, role: 'admin', testOnly: true}),
      validSince: String(state.validSince)}]};
    else if (url.endsWith('/accounts:update')) {
      if ('disableUser' in body) state.firebaseDisabled = body.disableUser;
      if ('validSince' in body) state.validSince = body.validSince;
      value = {localId: target.id};
    } else if (url.includes(':signBlob')) value = {signedBlob: Buffer.from('synthetic-signature').toString('base64')};
    else if (url.endsWith('/keyString')) value = {keyString: 'synthetic-only-key'};
    else if (url.includes('signInWithCustomToken')) value = {localId: target.id, idToken};
    else if (url === `${v.runtime.origin}/jobs/dispatch-board/${v.plan.jobId}`)
      value = {jobId: v.plan.jobId};
    else throw Error('UNLISTED_URL');
    return {ok: true, text: async () => JSON.stringify(value)};
  };
  return {state, dbFactory, fetcher,
    ownerAuth: async () => ({principal: v.plan.ownerPrincipal, impersonationOverride: false,
      credentialOverride: false, accessToken: 'SYNTHETIC_OWNER_OAUTH_TOKEN'}),
    sessionProbe: async name => {
      need(name === 'p08-auth-' + v.plan.operationId, 'SESSION_SCOPE');
      return v.scenario === 'session_failure' ? 1 : Number(state.sessionOpen);
    }};
}
export async function runFixture(mode, v) {
  need(MODES.has(mode), 'MODE'); verifySources();
  const cap = authorize(v.plan, v.approval, {target: v.target, receipt: v.receipt,
    runtime: v.runtime, journalPath: v.journalPath, now: () => Date.parse(v.fixtureNow),
    mode: mode === '--fixture-auth' ? 'run' : 'closeout'});
  try {
    if (v.scenario === 'exit') throw Error('SYNTHETIC_CHILD_EXIT');
    if (v.scenario === 'hang') await new Promise(resolve => setTimeout(resolve, 30000));
    const journal = JSON.parse(readFileSync(v.journalPath, 'utf8'));
    const ports = fixturePorts(v, journal);
    const secret = {password: 'SYNTHETIC_HIDDEN_PASSWORD'};
    const binding = {operationId: v.plan.operationId, planSha256: planHash(v.plan),
      project: v.plan.project, tenantId: v.plan.tenantId, jobId: v.plan.jobId,
      targetId: v.target.id,
      database: {host: 'fixture.invalid', port: 5432, database: 'fixture_child', user: 'fixture_admin'}};
    const clients = await boundClients(cap, {binding, secret, ...ports, now: () => Date.parse(v.fixtureNow)});
    if (mode === '--fixture-closeout' && journal.authClient?.phase === 'CLOSEOUT_FINISHED') {
      let clean = false;
      try {
        exactApp(await clients.db.get(), v.target, 'DISABLED');
        const user = exactIdentity(await clients.fb.get(), v.target, true);
        need(Date.parse(user.tokensValidAfterTime) >= Date.parse(journal.authClient.revocationIntentAt),
          'REVOCATION_READBACK');
        await clients.close();
        clean = journal.authClient.residuals?.length === 0;
      } finally {clients.clear();}
      return {status: clean ? 'P08_COORDINATOR_AUTH_CLEANUP_VERIFIED' :
        'P08_COORDINATOR_AUTH_CONTAINMENT_UNCONFIRMED', authenticated: false,
      residuals: clean ? [] : ['AUTH_CLOSEOUT_RESIDUAL'], sessionClosed: clean,
      liveAuthorization: false, authProofReady: false};
    }
    return mode === '--fixture-auth' ?
      await new CoordinatorAuthSequence(cap, clients).run() :
      await new CoordinatorAuthSequence(cap, clients).closeout(true);
  } finally {close(cap);}
}
async function main() {
  const mode = process.argv[2]; need(MODES.has(mode), 'NATIVE_DISABLED');
  const v = input(); const result = await runFixture(mode, v);
  if (v.scenario !== 'lost_output') process.stdout.write(JSON.stringify(result) + '\n');
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch(() => {process.stdout.write('{"status":"P08_BOUND_LOCAL_CHILD_STOPPED"}\n'); process.exitCode = 2;});
