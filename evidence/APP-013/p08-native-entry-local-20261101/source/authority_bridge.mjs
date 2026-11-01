import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const caps = new WeakSet();
export const need = (value, code) => {if (!value) throw Object.assign(Error(code), {code});};
const canonical = x => Array.isArray(x) ? x.map(canonical) : x && typeof x === 'object'
  ? Object.fromEntries(Object.keys(x).sort().map(k => [k, canonical(x[k])])) : x;
export const hash = x => createHash('sha256').update(typeof x === 'string' || Buffer.isBuffer(x)
  ? x : JSON.stringify(canonical(x))).digest('hex');

export function authorizeChild(path, mode) {
  need(['--run','--closeout','--readback'].includes(mode), 'CHILD_MODE');
  const raw = readFileSync(path); need(raw.length <= 65536, 'ENVELOPE_BOUNDS');
  const e = JSON.parse(raw);
  // Same validator and immutable decision/source checks as parent, before any native port.
  const result = execFileSync('/opt/homebrew/bin/python3', ['-B',
    fileURLToPath(new URL('./entry.py', import.meta.url)), '--check-child', path, mode.slice(2)],
    {encoding:'utf8',timeout:10000,maxBuffer:4096,stdio:['ignore','pipe','pipe'],
     env:{PATH:'/usr/bin:/bin:/opt/homebrew/bin',LANG:'C'}});
  const proof = JSON.parse(result);
  need(proof.envelopeSha256 === hash(e) && proof.operationId === e.plan.operationId &&
    proof.external === (e.execution === 'EXTERNAL') && proof.mode === mode.slice(2), 'CHILD_OUTER_BINDING');
  need(hash(readFileSync(path)) === hash(raw), 'ENVELOPE_CHANGED');
  const cap = {e, external:proof.external, mode, last:Date.now(), requests:0};
  caps.add(cap); return cap;
}

export function gate(cap, cleanup = false, spend = false) {
  need(caps.has(cap), 'OUTER_CAPABILITY_REQUIRED');
  const now = Date.now(); need(now >= cap.last, 'CLOCK_ROLLBACK'); cap.last = now;
  need(now >= Date.parse(cap.e.plan.window.start) &&
    now < Date.parse(cap.e.plan.window[cleanup ? 'cleanupEnd' : 'workEnd']), 'OUTER_DEADLINE');
  need(cleanup || cap.mode === '--run', 'CLOSEOUT_ONLY');
  if (spend) {need(cap.requests < cap.e.limits.childRequests, 'CHILD_CALL_LIMIT'); cap.requests++;}
  return cap;
}
