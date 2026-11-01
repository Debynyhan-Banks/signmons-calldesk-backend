import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {rmSync} from 'node:fs';
import {runChild} from './native_child.mjs';
import {authorizeChild,gate} from './authority_bridge.mjs';
import {createPorts} from './transports.mjs';
import {fixturePorts} from './fixture_ports.mjs';
function fixture(t){
  const f=JSON.parse(execFileSync('/opt/homebrew/bin/python3',['-B',fileURLToPath(new URL('./fixture_envelope.py',import.meta.url))],{encoding:'utf8'}));
  t.after(()=>{for(const root of f.cleanup){assert.match(root,/^\/private\/tmp\/p08-coordinator-(?:private-)?[0-9a-f-]{36}$/);rmSync(root,{recursive:true,force:true});}});
  return f.request;
}

test('native defaults reject a local proof capability before any owner/DB/fetch',async t=>{
  const r=fixture(t);
  await assert.rejects(()=>runChild('--run',r),{code:'NATIVE_REQUIRES_EXTERNAL_AUTHORITY'});
});
test('actual child entry runs with injected ports and rejects reuse of one reserved call',async t=>{
  const r=fixture(t),ports=fixturePorts(r);
  const result=await runChild('--run',structuredClone(r),ports);
  assert.equal(result.status,'P08_COORDINATOR_AUTHENTICATED_AND_CLOSED');
  assert.equal(result.liveAuthorization,false);assert.equal(result.authProofReady,false);
  await assert.rejects(()=>runChild('--run',structuredClone(r),ports),{code:'EEXIST'});
});
test('outer capability cannot be forged for native ports',t=>{
  assert.throws(()=>createPorts({external:true},{password:'synthetic',accessToken:'synthetic-token'}),{code:'OUTER_CAPABILITY_REQUIRED'});
});
test('serialized oversized provider body fails before authentication',async t=>{
  const r=fixture(t),cap=authorizeChild(r.envelopePath,'--run');
  const ports=createPorts(cap,r.credentials,{...fixturePorts(r),fetcher:async()=>({ok:true,text:async()=>'x'.repeat(65537)})});
  await assert.rejects(()=>ports.fetcher('https://identitytoolkit.googleapis.com/v1/projects/signmons/accounts:lookup',{}),{code:'AUTH_OUTPUT_LIMIT'});
});
test('unapproved HTTPS host refuses before injected transport',async t=>{
  const r=fixture(t),cap=authorizeChild(r.envelopePath,'--run');let calls=0;
  const ports=createPorts(cap,r.credentials,{...fixturePorts(r),fetcher:async()=>{calls++;throw Error('MUST_NOT_CALL');}});
  await assert.rejects(()=>ports.fetcher('https://foreign.invalid/',{}),{code:'AUTH_HOST_SCOPE'});assert.equal(calls,0);
});
test('child budget is finite and cleanup capability cannot run activation path',t=>{
  const r=fixture(t),cap=authorizeChild(r.envelopePath,'--closeout');
  assert.throws(()=>gate(cap,false),{code:'CLOSEOUT_ONLY'});
  for(let n=0;n<cap.e.limits.childRequests;n++)gate(cap,true,true);
  assert.throws(()=>gate(cap,true,true),{code:'CHILD_CALL_LIMIT'});
});
