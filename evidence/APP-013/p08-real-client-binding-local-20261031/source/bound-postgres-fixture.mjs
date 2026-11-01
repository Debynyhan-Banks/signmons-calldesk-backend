import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {readFileSync, writeFileSync, mkdirSync, chmodSync, rmSync} from 'node:fs';
import {authorize, close, hash, planHash} from '../../p08-coordinator-auth-local-20261031/source/authority.mjs';
import {boundClients, PREFLIGHT_SQL, native} from './bound-clients.mjs';
import {CoordinatorAuthSequence} from './recovery-sequence.mjs';
import {SQL} from '../../p08-coordinator-auth-local-20261031/source/client.mjs';
import {plan as bridgePlan} from '../../p08-authentication-local-20261026/source/reuse/operator-bridge.mjs';

const TARGET = {id: '10000000-0000-4000-8000-000000000001', tenantId: bridgePlan.tenantId,
  email: 'debynyhan@signmons.com', fullName: 'Signmons Test Administrator', role: 'ADMIN'};
const iso = n => new Date(n).toISOString().replace('.000', '');
function fixture(t) {
  const op = randomUUID(), base = Math.floor(Date.now()/1000)*1000;
  const clock = {value: base+1000};
  const plan = {mode: 'LOCAL_INTEGRATED_PACKET_ONLY', externalActionAuthorized: false,
    automaticRetryAllowed: false, allowanceUsd: 0, serviceRetention: 'RETAIN_ENABLED_AFTER_KEY_DELETE',
    project: 'signmons', projectNumber: '123456789012', projectNumberSha256: hash('123456789012'),
    operationId: op, tenantId: TARGET.tenantId, jobId: bridgePlan.jobId,
    ownerPrincipal: TARGET.email,
    runtimeIdentity: 'signmons-calldesk-p07-runtime@signmons.iam.gserviceaccount.com',
    keyId: 'signmons-p08-' + op.replaceAll('-', ''),
    window: {start: iso(base), cutoff: iso(base+10000), workEnd: iso(base+30000),
      cleanupEnd: iso(base+45000), purgeEnd: iso(base+50000)}};
  const approval = {decision:'APPROVE_LOCAL_SINGLE_COORDINATOR',externalActionAuthorized:false,
    operationId:op,planSha256:planHash(plan)};
  const receipt = {operationId:op,keyResource:`projects/${plan.projectNumber}/locations/global/keys/${plan.keyId}`,
    uid:'synthetic-uid',etag:'synthetic-etag',displayName:`Signmons P08 ${op}`,
    restrictions:{apiTargets:[{service:'identitytoolkit.googleapis.com'}]},
    keyStringSha256:hash('synthetic-key'),createdInOperation:true,deleted:false,ownedAt:iso(base)};
  const runtime = {origin:bridgePlan.origin,jobId:plan.jobId,tenantId:plan.tenantId,
    revocationRequired:true,devAuthEnabled:false,identityQualified:true,
    restorationApproved:true,serviceAccount:plan.runtimeIdentity};
  const root = `/private/tmp/p08-coordinator-${op}`;mkdirSync(root,{mode:0o700});chmodSync(root,0o700);
  const journalPath = root+'/journal.json';
  writeFileSync(journalPath,JSON.stringify({operationId:op,planSha256:planHash(plan),
    phase:'PREFLIGHT',authAttempted:true,keyCreateAttempted:true,keyUidSha256:hash(receipt.uid),
    keyDeleteAttempted:false,authProofAccepted:false}),{mode:0o600,flag:'wx'});
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const cap = authorize(plan,approval,{target:TARGET,receipt,runtime,journalPath,now:()=>clock.value});
  t.after(()=>close(cap));
  const binding = {operationId:op,planSha256:planHash(plan),project:plan.project,
    tenantId:plan.tenantId,jobId:plan.jobId,targetId:TARGET.id,
    database:{host:'fixture.invalid',port:5432,database:'fixture_child',user:'fixture_admin'}};
  return {cap,plan,approval,receipt,runtime,journalPath,clock,binding};
}

// Owned disposable cluster only; never a native credential/provider entry.
import {createRequire} from 'node:module';
import {realpathSync, lstatSync} from 'node:fs';
const require = createRequire(new URL('../../../../package.json', import.meta.url));
const {Client} = require('pg');
const input = JSON.parse(readFileSync(0, 'utf8'));
assert.deepEqual(Object.keys(input).sort(), ['cert', 'port', 'root', 'scenario']);
assert.match(input.root, /^\/private\/tmp\/p08-pg-[A-Za-z0-9_-]+$/);
assert.equal(realpathSync(input.root), input.root);
assert.equal(lstatSync(input.root).mode & 0o777, 0o700);
assert.equal(input.cert, input.root + '/server.crt');
assert.equal(realpathSync(input.cert), input.cert);
assert.ok(Number.isInteger(input.port) && input.port >= 55000 && input.port < 56000);
assert.ok(['positive','cleartext','untrusted','tenant','residual'].includes(input.scenario));
for (const key of Object.keys(process.env)) {
  if (key === 'DATABASE_URL' || key.startsWith('PG')) delete process.env[key];
}
globalThis.fetch = () => {throw Error('NO_EXTERNAL_TRANSPORT');};
const cleanup = [];
const f = fixture({after: fn => cleanup.push(fn)});
const ca = readFileSync(input.cert, 'utf8');
const binding = {...f.binding, database: {host:'127.0.0.1', port:input.port,
  database:'neondb', user:'neondb_owner'}};
const config = name => ({...binding.database, application_name:name,
  connectionTimeoutMillis:3000, query_timeout:3000,
  ssl:{ca, rejectUnauthorized:true}});
const sessionName = 'p08-auth-' + f.plan.operationId;
const created = [];
let probes = 0, observedEncrypted = false, clients, extra;
const secret = {password:'SYNTHETIC_LOCAL_ONLY'};
async function sessionProbe(name, target) {
  assert.deepEqual(target, binding.database);
  assert.equal(name, sessionName);
  probes++;
  const probe = new Client(config('p08-local-session-probe'));
  try {
    await probe.connect();
    const r = await probe.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name=$1', [name]);
    return r.rows[0].count;
  } finally {await probe.end();}
}
try {
  const dbFactory = async (target, password, name) => {
    assert.deepEqual(target, binding.database);
    assert.equal(password, 'SYNTHETIC_LOCAL_ONLY');
    assert.equal(name, sessionName);
    const c = config(name);
    if (input.scenario === 'cleartext') c.ssl = false;
    if (input.scenario === 'untrusted') c.ssl = {rejectUnauthorized:true};
    const db = new Client(c);
    created.push(db);
    return db;
  };
  const run = () => boundClients(f.cap, {binding, secret, dbFactory, sessionProbe,
    ownerAuth:async()=>({principal:f.plan.ownerPrincipal,impersonationOverride:false,
      credentialOverride:false,accessToken:'SYNTHETIC_OWNER_OAUTH_TOKEN'}),
    fetcher:async()=>{throw Error('NO_EXTERNAL_TRANSPORT');}, now:()=>f.clock.value});
  if (input.scenario === 'cleartext') await assert.rejects(run, {code:'TLS_REQUIRED'});
  else if (input.scenario === 'untrusted') await assert.rejects(run, e =>
    ['DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN'].includes(e.code));
  else if (input.scenario === 'tenant') await assert.rejects(run, {code:'DATABASE_PREFLIGHT'});
  else {
    clients = await run();
    observedEncrypted = created[0].connection.stream.encrypted === true &&
      created[0].connection.stream.authorized === true;
    assert.equal(observedEncrypted, true);
    const before = await clients.db.get();
    assert.equal(before.status, 'DISABLED');
    if (input.scenario === 'positive') {
      const active = await clients.db.activate(before.updatedAt);
      assert.equal(active.status, 'ACTIVE');
      await assert.rejects(()=>clients.db.disable(before.updatedAt), {code:'DISABLE_CONFLICT'});
      assert.equal((await clients.db.disable(active.updatedAt)).status, 'DISABLED');
      assert.equal(await clients.close(), true);
    } else {
      extra = new Client(config(sessionName));
      await extra.connect();
      await assert.rejects(()=>clients.close(), {code:'SESSIONS_REMAIN'});
      await extra.end(); extra = undefined;
    }
  }
  assert.equal(secret.password, '');
  assert.ok(probes >= 1);
  assert.equal(await sessionProbe(sessionName, binding.database), 0);
  console.log(JSON.stringify({status:'PASS', scenario:input.scenario,
    observedEncrypted, sessionsRemaining:0, providerCalls:0}));
} finally {
  if (clients) clients.clear();
  if (extra) await extra.end();
  for (const db of created) await db.end();
  for (const fn of cleanup.reverse()) fn();
}
