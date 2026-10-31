import {readSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {authorize, close, verifySources, need} from '../../p08-coordinator-auth-local-20261031/source/authority.mjs';
import {CoordinatorAuthSequence} from '../../p08-coordinator-auth-local-20261031/source/sequence.mjs';

const MAX_INPUT = 65536;
const MODES = new Set(['--fixture-auth', '--fixture-closeout']);
const SCENARIOS = new Set(['normal', 'lost_output', 'lost_activation', 'session_failure', 'hang', 'exit']);

function input() {
  const bytes = Buffer.alloc(MAX_INPUT + 1);
  let used = 0;
  while (used < bytes.length) {
    const count = readSync(0, bytes, used, bytes.length - used, null);
    if (!count) break;
    used += count;
  }
  need(used > 0 && used <= MAX_INPUT, 'INPUT_BOUNDS');
  const value = JSON.parse(bytes.subarray(0, used).toString('utf8'));
  need(value && Object.keys(value).sort().join(',') ===
    'approval,fixtureNow,journalPath,localOnly,plan,receipt,runtime,scenario,target', 'INPUT_SHAPE');
  need(value.localOnly === true && SCENARIOS.has(value.scenario), 'LOCAL_FIXTURE_ONLY');
  need(typeof value.fixtureNow === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value.fixtureNow),
    'FIXTURE_CLOCK');
  return value;
}

function fakeClients(target, scenario, prior) {
  let row = {...target, status: prior?.activatedVersion || prior?.activationIntent ? 'ACTIVE' : 'DISABLED',
    updatedAt: prior?.activatedVersion ?? '2026-01-01T00:00:00.000Z'};
  let user = {uid: target.id, email: target.email, displayName: target.fullName,
    disabled: !prior?.firebaseEnableIntent, emailVerified: false,
    customClaims: {tenantId: target.tenantId, role: 'admin', testOnly: true},
    tokensValidAfterTime: new Date(0).toISOString()};
  return {
    db: {get: async () => ({...row}), activate: async version => {
      need(row.status === 'DISABLED' && row.updatedAt === version, 'FIXTURE_ACTIVATION_VERSION');
      row = {...row, status: 'ACTIVE', updatedAt: '2026-01-01T00:00:01.000Z'};
      if (scenario === 'lost_activation') throw Error('SYNTHETIC_LOST_RESPONSE');
      return {...row};
    }, disable: async version => {
      need(row.status === 'ACTIVE' && row.updatedAt === version, 'FIXTURE_DISABLE_VERSION');
      row = {...row, status: 'DISABLED', updatedAt: '2026-01-01T00:00:02.000Z'};
      return {...row};
    }},
    fb: {get: async () => structuredClone(user), enable: async () => {user.disabled = false;},
      disable: async () => {user.disabled = true;},
      revoke: async () => {user.tokensValidAfterTime = new Date().toISOString();}},
    issue: async () => 'SYNTHETIC_IN_MEMORY_TOKEN',
    authenticate: async token => need(token === 'SYNTHETIC_IN_MEMORY_TOKEN', 'TOKEN_SCOPE'),
    dropToken() {}, clear() {},
    async close() {if (scenario === 'session_failure') throw Error('SYNTHETIC_SESSION_FAILURE');},
  };
}

export async function runFixture(mode, request) {
  need(MODES.has(mode), 'MODE');
  verifySources();
  const cap = authorize(request.plan, request.approval, {target: request.target,
    receipt: request.receipt, runtime: request.runtime, journalPath: request.journalPath,
    now: () => Date.parse(request.fixtureNow),
    mode: mode === '--fixture-auth' ? 'run' : 'closeout'});
  try {
    if (request.scenario === 'exit') throw Error('SYNTHETIC_CHILD_EXIT');
    if (request.scenario === 'hang') await new Promise(resolve => setTimeout(resolve, 30000));
    const journal = JSON.parse(readFileSync(request.journalPath, 'utf8'));
    if (mode === '--fixture-closeout' && journal.authClient?.phase === 'CLOSEOUT_FINISHED') {
      const clean = journal.authClient.residuals?.length === 0 && journal.authClient.sessionClosed === true;
      return {status: clean ? 'P08_COORDINATOR_AUTH_CLEANUP_VERIFIED' :
        'P08_COORDINATOR_AUTH_CONTAINMENT_UNCONFIRMED', authenticated: false,
        residuals: clean ? [] : ['AUTH_CLOSEOUT_RESIDUAL'], sessionClosed: clean,
        liveAuthorization: false, authProofReady: false};
    }
    const clients = fakeClients(request.target, request.scenario, journal.authClient);
    const sequence = new CoordinatorAuthSequence(cap, clients);
    return mode === '--fixture-auth' ? await sequence.run() : await sequence.closeout(true);
  } finally {close(cap);}
}

export async function main() {
  const mode = process.argv[2];
  need(MODES.has(mode), 'NATIVE_DISABLED');
  const request = input();
  const result = await runFixture(mode, request);
  if (request.scenario !== 'lost_output') process.stdout.write(JSON.stringify(result) + '\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const code = ['JOURNAL_CONCURRENT_DRIFT', 'JOURNAL_OWNERSHIP', 'JOURNAL_PRIVATE',
      'OPERATION_DEADLINE', 'APPLICATION_DRIFT', 'IDENTITY_DRIFT', 'CLAIMS_DRIFT',
      'CLOSEOUT_RESERVED'].includes(error?.code) ? error.code : 'UNKNOWN';
    process.stdout.write(JSON.stringify({status: 'P08_LOCAL_CHILD_STOPPED', reason: code}) + '\n');
    process.exitCode = 2;
  });
}
