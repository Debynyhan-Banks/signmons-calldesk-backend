import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readFileSync,rmSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runChild} from './native_child.mjs';
import {authorizeChild,gate} from './authority_bridge.mjs';
import {createPorts} from './transports.mjs';
import {fixturePorts} from './fixture_ports.mjs';
const require=createRequire(new URL('../../../../package.json',import.meta.url));
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

test('native clients scope UTC timestamp parsing and delegate other OIDs/formats',async t=>{
  const r=fixture(t),cap=authorizeChild(r.envelopePath,'--run'),base=fixturePorts(r);
  const defaults=require('pg').types,before=defaults.getTypeParser(1114,'text');
  let config;
  class Capture extends base.ClientClass {constructor(value){super(value);config=value;}}
  const ports=createPorts(cap,r.credentials,{...base,ClientClass:Capture});
  const e=JSON.parse(readFileSync(r.envelopePath));
  await ports.dbFactory(e.database,r.credentials.password,'p08-auth-'+e.plan.operationId);
  assert.equal(config.options,'-c statement_timeout=4000 -c lock_timeout=2000 -c timezone=UTC');
  const parser=config.types.getTypeParser(1114);
  for(const [raw,expected] of [
    ['2024-02-29 23:59:59','2024-02-29T23:59:59.000Z'],
    ['2026-03-08 02:30:00.1','2026-03-08T02:30:00.100Z'],
    ['2026-11-01 01:30:00.12','2026-11-01T01:30:00.120Z'],
    ['0001-01-01 00:00:00.123','0001-01-01T00:00:00.123Z']]) {
    assert.equal(parser(raw).toISOString(),expected);
  }
  for(const [oid,format] of [[1114,'binary'],[1184,'text'],[23,'text'],[25,'text']])
    assert.equal(config.types.getTypeParser(oid,format),defaults.getTypeParser(oid,format));
  assert.equal(defaults.getTypeParser(1114,'text'),before);
  assert.notEqual(parser,before);
});

test('native timestamp versions reject malformed calendars and excess precision without rounding',async t=>{
  const r=fixture(t),cap=authorizeChild(r.envelopePath,'--run'),base=fixturePorts(r);let config;
  class Capture extends base.ClientClass {constructor(value){super(value);config=value;}}
  const ports=createPorts(cap,r.credentials,{...base,ClientClass:Capture});
  const e=JSON.parse(readFileSync(r.envelopePath));
  await ports.dbFactory(e.database,r.credentials.password,'p08-auth-'+e.plan.operationId);
  const parser=config.types.getTypeParser(1114,'text');
  for(const raw of [null,0,'infinity','-infinity','0000-01-01 00:00:00','10000-01-01 00:00:00',
    '2026-02-29 00:00:00','2026-04-31 00:00:00','2026-13-01 00:00:00','2026-01-00 00:00:00',
    '2026-01-01 24:00:00','2026-01-01 00:60:00','2026-01-01 00:00:60',
    '2026-01-01 00:00:00.0000','2026-01-01 00:00:00.1234','2026-01-01 00:00:00.',
    '2026-01-01T00:00:00Z','2026-01-01 00:00:00+00','2026-01-01 00:00:00 BC',' 2026-01-01 00:00:00',
    '2026-01-01 00:00:00\n','2026-01-01 00:00:00\r'])
    assert.throws(()=>parser(raw),{code:'TIMESTAMP_VERSION_SHAPE'},String(raw));
});

test('actual native child retains bounded HTTP failure status without response body',async t=>{
  const r=fixture(t),base=fixturePorts(r);let signingCalls=0;
  const result=await runChild('--run',structuredClone(r),{...base,fetcher:async(url,options)=>{
    if(url.includes(':signBlob')){signingCalls++;return {ok:false,status:403,text:async()=>'{"error":"PRIVATE_SENTINEL"}'};}
    return base.fetcher(url,options);
  }});
  const raw=readFileSync(r.envelopePath.replace(/envelope\.json$/,'journal.json'),'utf8');
  const auth=JSON.parse(raw).authClient;
  assert.equal(auth.authStage,'SIGN');assert.equal(auth.failureCategory,'HTTP');assert.equal(auth.httpStatus,403);
  assert.equal(signingCalls,1);assert.equal(result.authenticated,false);
  assert.equal(result.sessionClosed,true);assert.deepEqual(result.residuals,[]);
  assert.ok(!raw.includes('PRIVATE_SENTINEL'));
});
