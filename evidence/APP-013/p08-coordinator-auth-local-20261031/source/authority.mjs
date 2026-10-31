import {createHash} from 'node:crypto';
import {readFileSync, lstatSync, realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve, dirname} from 'node:path';
import {plan as bridgePlan} from '../../p08-authentication-local-20261026/source/reuse/operator-bridge.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const LOCKS = Object.freeze({
  authAdapters: ['p08-authentication-local-20261026/source/auth-adapters.mjs', 'ee4906f969ae40e40b4c4a066829afc63257c62a8e9e60fcdbc1ea376b91855a'],
  authAuthority: ['p08-authentication-local-20261026/source/auth-authority.mjs', '51c5250ace4ff095a7cc2e5b6f4e099a863389fa095c2bfe26151c832480d965'],
  authController: ['p08-authentication-local-20261026/source/auth-controller.mjs', '57ab0853630112145e81e10143b05099b2a446f7f450d0eff4598540528ef0c4'],
  operatorBridge: ['p08-authentication-local-20261026/source/reuse/operator-bridge.mjs', 'ab76b595592ea1e5a3c73ebe7ce0320faf2e388db40d4354216d9892a8120e71'],
  coordinator: ['p08-live-binder-local-20261029/source/coordinator.py', '1eecc5241794cfed6d892db4385039274539e47b183f1d934899549eb5560f70'],
  readbacks: ['p08-native-closeout-local-20261031/source/adapter.py', 'c463671302f8d858d51063e94d7baaa6c0c72a395f505f5fa0a502674d8e532c'],
});
const caps = new WeakMap();
const uuid = v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const hex = v => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
export const hash = v => createHash('sha256').update(typeof v === 'string' || Buffer.isBuffer(v) ? v : JSON.stringify(v)).digest('hex');
const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
export const planHash = v => hash(JSON.stringify(canonical(v)));
export const need = (v, code) => { if (!v) throw Object.assign(Error(code), {code}); };

export function verifySources() {
  for (const [relative, expected] of Object.values(LOCKS)) {
    const path = resolve(ROOT, relative);
    const mode = lstatSync(path);
    need(mode.isFile() && !mode.isSymbolicLink() && hash(readFileSync(path)) === expected, 'SOURCE_DRIFT');
  }
  const original = readFileSync(resolve(ROOT, LOCKS.authAdapters[0]), 'utf8');
  const prefix = original.split('// Socket-only actual SQL proof entry; never accepts a network database target.')[0];
  need(prefix !== original, 'SOURCE_CONTRACT');
  const extracted = prefix
    .replace("from './auth-authority.mjs'", "from './authority.mjs'")
    .replace("from './reuse/operator-bridge.mjs'", "from '../../p08-authentication-local-20261026/source/reuse/operator-bridge.mjs'")
    .replace('fetcher=fetch,now=Date.now', 'fetcher,now=Date.now')
    .replace('const {p}=gate(cap,true),s=p.target;let idToken=', "const {p}=gate(cap,true),s=p.target;need(typeof fetcher==='function','INJECTED_TRANSPORT_REQUIRED');let idToken=");
  need(readFileSync(resolve(HERE, 'client.mjs'), 'utf8') === extracted, 'EXTRACTION_DRIFT');
  return true;
}

function readCoordinatorJournal(path, plan, receipt, cleanup = false) {
  need(typeof path === 'string' && path === `/private/tmp/p08-coordinator-${plan.operationId}/journal.json`, 'JOURNAL_PATH');
  const parent = dirname(path);
  const dir = lstatSync(parent), file = lstatSync(path);
  need(dir.isDirectory() && !dir.isSymbolicLink() && (dir.mode & 0o777) === 0o700 &&
    file.isFile() && !file.isSymbolicLink() && (file.mode & 0o777) === 0o600 &&
    realpathSync(parent) === parent && realpathSync(path) === path, 'JOURNAL_PRIVATE');
  const j = JSON.parse(readFileSync(path, 'utf8'));
  need(j.operationId === plan.operationId && j.planSha256 === planHash(plan) &&
    j.authAttempted === true && j.keyCreateAttempted === true &&
    j.keyUidSha256 === hash(receipt.uid) && (cleanup || j.keyDeleteAttempted === false) &&
    (cleanup || (j.authProofAccepted === false && j.phase !== 'CLOSED')), 'JOURNAL_OWNERSHIP');
  return j;
}

export function authorize(plan, approval, {target, receipt, runtime, journalPath, now = Date.now, signal, mode = 'run'} = {}) {
  verifySources();
  need(plan?.mode === 'LOCAL_INTEGRATED_PACKET_ONLY' && plan.externalActionAuthorized === false &&
    plan.automaticRetryAllowed === false && plan.allowanceUsd === 0 &&
    plan.serviceRetention === 'RETAIN_ENABLED_AFTER_KEY_DELETE', 'LOCAL_ONLY');
  need(uuid(plan.operationId) && uuid(plan.tenantId) && uuid(plan.jobId) &&
    plan.tenantId === 'a1adcfd4-15be-404b-9ac3-5edb1fda20f0' &&
    plan.jobId === '9180bef4-561d-47a0-869f-925e6a3dfd96' &&
    plan.project === 'signmons' && /^[0-9]{6,20}$/.test(plan.projectNumber ?? '') &&
    plan.projectNumberSha256 === hash(plan.projectNumber) &&
    plan.ownerPrincipal === 'debynyhan@signmons.com' &&
    plan.runtimeIdentity === 'signmons-calldesk-p07-runtime@signmons.iam.gserviceaccount.com' &&
    plan.keyId === 'signmons-p08-' + plan.operationId.replaceAll('-', ''), 'BUSINESS_SCOPE');
  need(approval?.decision === 'APPROVE_LOCAL_SINGLE_COORDINATOR' && approval.externalActionAuthorized === false &&
    approval.operationId === plan.operationId && approval.planSha256 === planHash(plan), 'LOCAL_APPROVAL');
  need(target && Object.keys(target).sort().join(',') === 'email,fullName,id,role,tenantId' &&
    uuid(target.id) && target.tenantId === plan.tenantId && target.role === 'ADMIN' &&
    target.fullName === 'Signmons Test Administrator' && typeof target.email === 'string' &&
    target.email.length > 0 && target.email === plan.ownerPrincipal, 'TARGET_SCOPE');
  const keyResource = `projects/${plan.projectNumber}/locations/global/keys/${plan.keyId}`;
  need(receipt && Object.keys(receipt).sort().join(',') ===
    'createdInOperation,deleted,displayName,etag,keyResource,keyStringSha256,operationId,ownedAt,restrictions,uid' &&
    receipt.operationId === plan.operationId && receipt.keyResource === keyResource &&
    receipt.displayName === `Signmons P08 ${plan.operationId}` && receipt.createdInOperation === true &&
    receipt.deleted === false && JSON.stringify(receipt.restrictions) ===
    JSON.stringify({apiTargets: [{service: 'identitytoolkit.googleapis.com'}]}) &&
    typeof receipt.uid === 'string' && receipt.uid &&
    typeof receipt.etag === 'string' && receipt.etag && hex(receipt.keyStringSha256), 'OWNED_KEY_SCOPE');
  need(mode === 'run' || mode === 'closeout', 'MODE');
  readCoordinatorJournal(journalPath, plan, receipt, mode === 'closeout');
  need(runtime && runtime.origin === bridgePlan.origin &&
    runtime.jobId === plan.jobId && runtime.tenantId === plan.tenantId &&
    runtime.revocationRequired === true && runtime.devAuthEnabled === false &&
    runtime.identityQualified === true && runtime.restorationApproved === true &&
    runtime.serviceAccount === plan.runtimeIdentity, 'RUNTIME_SCOPE');
  const w = plan.window;
  need(w && Object.keys(w).sort().join(',') === 'cleanupEnd,cutoff,purgeEnd,start,workEnd' &&
    Object.values(w).every(v => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(v)), 'WINDOW_FORMAT');
  const times = Object.fromEntries(Object.entries(w).map(([k, v]) => [k, Date.parse(v)]));
  need(times.start < times.cutoff && times.cutoff < times.workEnd && times.workEnd < times.cleanupEnd &&
    times.cleanupEnd < times.purgeEnd && times.purgeEnd - times.start <= 3600000, 'WINDOW_ORDER');
  need(typeof now === 'function' && (!signal || typeof signal.aborted === 'boolean'), 'CLOCK_OR_SIGNAL');
  const t = now();
  need(t >= times.start && t < times[mode === 'run' ? 'cutoff' : 'cleanupEnd'], 'START_CUTOFF');
  const p = Object.freeze({operationId: plan.operationId, target: Object.freeze({...target}),
    jobId: plan.jobId, window: Object.freeze({...w}),
    signing: Object.freeze({serviceAccount: plan.runtimeIdentity}),
    exchange: Object.freeze({keyResource, keySha256: receipt.keyStringSha256}),
    runtime: Object.freeze({...runtime})});
  const cap = Object.freeze({});
  caps.set(cap, {p, plan, receipt, journalPath, times, now, signal, mode, last: t, closed: false});
  return cap;
}

export function gate(cap, cleanup = false) {
  const c = caps.get(cap);
  need(c && !c.closed, 'CAPABILITY_REQUIRED');
  const t = c.now();
  need(t >= c.last, 'CLOCK_ROLLBACK');
  c.last = t;
  need(t >= c.times.start && t < c.times[cleanup ? 'cleanupEnd' : 'workEnd'], 'OPERATION_DEADLINE');
  need(cleanup || c.mode === 'run', 'CLOSEOUT_ONLY');
  need(cleanup || !c.signal?.aborted, 'INTERRUPTED');
  readCoordinatorJournal(c.journalPath, c.plan, c.receipt, cleanup);
  return c;
}

export function close(cap) {
  const c = caps.get(cap);
  need(c && !c.closed, 'CAPABILITY_REQUIRED');
  c.closed = true;
}

export function exactIdentity(f, s, disabled) {
  need(f?.uid === s.id && f.email === s.email && f.displayName === s.fullName &&
    f.disabled === disabled && f.emailVerified === false, 'IDENTITY_DRIFT');
  need(JSON.stringify(Object.keys(f.customClaims ?? {}).sort()) === JSON.stringify(['role', 'tenantId', 'testOnly']) &&
    f.customClaims.tenantId === s.tenantId && f.customClaims.role === 'admin' &&
    f.customClaims.testOnly === true, 'CLAIMS_DRIFT');
  return f;
}

export function exactApp(u, s, status) {
  need(u?.id === s.id && u.tenantId === s.tenantId && u.email === s.email &&
    u.fullName === s.fullName && u.role === 'ADMIN' && u.status === status, 'APPLICATION_DRIFT');
  return u;
}

export function native() { throw Object.assign(Error('P08_COORDINATOR_AUTH_NATIVE_DISABLED'), {code: 'P08_COORDINATOR_AUTH_NATIVE_DISABLED'}); }
