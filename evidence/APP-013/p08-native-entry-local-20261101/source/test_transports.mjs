import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readFileSync,writeFileSync,rmSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runChild,CHILD_FAILURE_STAGES,CHILD_FAILURE_CODES,childRefusal,serializeChildResult} from './native_child.mjs';
import {PREFLIGHT_SQL} from '../../p08-real-client-binding-local-20261031/source/bound-clients.mjs';
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

test('refusal contract is finite and ignores provider stage, messages and accessors',()=>{
  for(const values of [CHILD_FAILURE_STAGES,CHILD_FAILURE_CODES]){
    assert.ok(Object.isFrozen(values));assert.equal(new Set(values).size,values.length);
  }
  for(const error of [null,undefined,'PRIVATE_SENTINEL',new Error('PRIVATE_SENTINEL'),
    {stage:'AUTHORITY',code:'PRIVATE_SENTINEL'},
    Object.defineProperty({stage:'AUTHORITY'},'code',{get(){throw Error('PRIVATE_SENTINEL');}})]){
    assert.deepEqual(childRefusal(error),{status:'NATIVE_CHILD_REFUSED_OR_UNCONFIRMED',stage:'UNKNOWN',code:'UNCLASSIFIED'});
  }
  assert.deepEqual(childRefusal({code:'OWNER_DRIFT',stage:'AUTHORITY'}),
    {status:'NATIVE_CHILD_REFUSED_OR_UNCONFIRMED',stage:'UNKNOWN',code:'OWNER_DRIFT'});
});

test('shared result serializer fixes the RESULT boundary without exposing thrown contents',()=>{
  const result={toJSON(){throw Object.assign(Error('PRIVATE_SENTINEL'),{stage:'AUTHORITY'});}};
  assert.throws(()=>serializeChildResult(result),error=>{
    assert.deepEqual(childRefusal(error),{status:'NATIVE_CHILD_REFUSED_OR_UNCONFIRMED',stage:'RESULT',code:'UNCLASSIFIED'});
    return true;
  });
  assert.throws(()=>serializeChildResult(undefined),error=>childRefusal(error).code==='CHILD_RESULT');
});

test('real process and fixture share bounded INPUT refusal serialization',()=>{
  for(const filename of ['native_child.mjs','fixture_child.mjs'])for(const input of ['', '{PRIVATE_SENTINEL', 'x'.repeat(131073)]){
    const result=spawnSync(process.execPath,[fileURLToPath(new URL('./'+filename,import.meta.url)),'--run'],
      {input,encoding:'utf8',timeout:10000,maxBuffer:8192});
    assert.equal(result.status,2);assert.equal(result.stderr,'');
    const frame=JSON.parse(result.stdout);
    assert.deepEqual(frame,{status:'NATIVE_CHILD_REFUSED_OR_UNCONFIRMED',stage:'INPUT',
      code:input.length===0||input.length>131072?'CHILD_INPUT_BOUNDS':'UNCLASSIFIED'});
    assert.ok(!result.stdout.includes('PRIVATE_SENTINEL'));
  }
});

test('actual child labels input, authority and reservation independently',async t=>{
  await assert.rejects(()=>runChild('--run',null),error=>{
    assert.deepEqual(childRefusal(error),{status:'NATIVE_CHILD_REFUSED_OR_UNCONFIRMED',stage:'INPUT',code:'CHILD_INPUT'});return true;
  });
  const authority=fixture(t);authority.receipt.deleted=true;
  await assert.rejects(()=>runChild('--run',authority,fixturePorts(authority)),error=>{
    assert.deepEqual(childRefusal(error),{status:'NATIVE_CHILD_REFUSED_OR_UNCONFIRMED',stage:'AUTHORITY',code:'OWNED_KEY_SCOPE'});return true;
  });
  const reservation=fixture(t);reservation.childCall++;
  await assert.rejects(()=>runChild('--run',reservation,fixturePorts(reservation)),error=>{
    assert.deepEqual(childRefusal(error),{status:'NATIVE_CHILD_REFUSED_OR_UNCONFIRMED',stage:'RESERVATION',code:'CHILD_RESERVATION'});return true;
  });
});

for(const scenario of ['owner','connect','tls','preflight'])test('actual child startup failure retains CLIENT_BINDING: '+scenario,async t=>{
  const r=fixture(t),ports=fixturePorts(r),Parent=ports.ClientClass;
  if(scenario==='owner')ports.owner=async()=>{throw Object.assign(Error('PRIVATE_SENTINEL'),{code:'OWNER_DRIFT',stage:'RESULT'});};
  else ports.ClientClass=class extends Parent {
    constructor(config){super(config);this.auth=config.application_name.startsWith('p08-auth-');
      if(this.auth&&scenario==='tls')this.connection.stream.authorized=false;}
    async connect(){if(this.auth&&scenario==='connect')throw Error('PRIVATE_SENTINEL');return super.connect();}
    async query(sql,args){return scenario==='preflight'&&sql===PREFLIGHT_SQL?{rows:[]}:super.query(sql,args);}
  };
  await assert.rejects(()=>runChild('--run',r,ports),error=>{
    assert.deepEqual(childRefusal(error),{status:'NATIVE_CHILD_REFUSED_OR_UNCONFIRMED',stage:'CLIENT_BINDING',
      code:{owner:'OWNER_DRIFT',connect:'UNCLASSIFIED',tls:'TLS_REQUIRED',preflight:'DATABASE_PREFLIGHT'}[scenario]});return true;
  });
  const raw=readFileSync(r.envelopePath.replace(/envelope\.json$/,'journal.json'),'utf8');
  assert.equal(JSON.parse(raw).authClient,undefined);assert.ok(!raw.includes('PRIVATE_SENTINEL'));
});

test('sequence initialization refusal retains its boundary',async t=>{
  const r=fixture(t),path=r.envelopePath.replace(/envelope\.json$/,'journal.json'),j=JSON.parse(readFileSync(path));
  j.authClient={operationId:j.operationId,version:1};writeFileSync(path,JSON.stringify(j));
  await assert.rejects(()=>runChild('--run',r,fixturePorts(r)),error=>{
    assert.deepEqual(childRefusal(error),{status:'NATIVE_CHILD_REFUSED_OR_UNCONFIRMED',stage:'AUTH_SEQUENCE',code:'JOURNAL_CONCURRENT_DRIFT'});return true;
  });
});

test('primary readback refusal survives a failing independent session close',async t=>{
  const r=fixture(t),ports=fixturePorts(r),Parent=ports.ClientClass;let closes=0;
  ports.ClientClass=class extends Parent {
    constructor(config){super(config);this.auth=config.application_name.startsWith('p08-auth-');}
    async end(){await super.end();if(this.auth){closes++;throw Error('PRIVATE_SENTINEL');}}
  };
  await assert.rejects(()=>runChild('--readback',r,ports),error=>{
    assert.deepEqual(childRefusal(error),{status:'NATIVE_CHILD_REFUSED_OR_UNCONFIRMED',stage:'READBACK',code:'REVOCATION_READBACK'});return true;
  });
  assert.equal(closes,1);
});

for(const failure of ['end','probe'])test('session '+failure+' failure still refuses successful containment',async t=>{
  const r=fixture(t),ports=fixturePorts(r),Parent=ports.ClientClass;
  ports.ClientClass=class extends Parent {
    constructor(config){super(config);this.auth=config.application_name.startsWith('p08-auth-');}
    async end(){await super.end();if(this.auth&&failure==='end')throw Error('PRIVATE_SENTINEL');}
    async query(sql,args){return failure==='probe'&&sql.includes('pg_stat_activity')?{rows:[{count:1}]}:super.query(sql,args);}
  };
  const result=await runChild('--run',r,ports);
  assert.equal(result.sessionClosed,false);assert.ok(result.residuals.includes('SESSION_CLOSEOUT'));
});

test('AP2 native transport classifies its own boundaries without trusting exception metadata',async t=>{
 for(const kind of ['request','read','bytes','decode','forged'])await t.test(kind,async t=>{
  const r=fixture(t),cap=authorizeChild(r.envelopePath,'--run');let calls=0;
  const privateError=Object.assign(Error('PRIVATE_SENTINEL'),{code:'NATIVE_IO_TIMEOUT',failureCategory:'HTTP',httpStatus:418});
  const fetcher=async()=>{calls++;
   if(['request','forged'].includes(kind))throw privateError;
   if(kind==='read')return {body:{getReader:()=>({read:async()=>{throw privateError;},cancel:async()=>{}})}};
   if(kind==='bytes')return {ok:true,status:200,text:async()=>'x'.repeat(65537)};
   let delivered=false;return {ok:true,status:200,body:{getReader:()=>({read:async()=>delivered?{done:true}:(delivered=true,{done:false,value:new Uint8Array([255])}),cancel:async()=>{}})}};
  };
  const ports=createPorts(cap,r.credentials,{...fixturePorts(r),fetcher});let error;
  await assert.rejects(()=>ports.fetcher('https://identitytoolkit.googleapis.com/v1/projects/signmons/accounts:lookup',{}),e=>{error=e;return true;});
  const detail=ports.fetcher.failureDiagnostic(error);
  assert.equal(calls,1);assert.equal(detail.category,['bytes','decode'].includes(kind)?'RESPONSE_VALIDATION':'TRANSPORT');
  assert.equal(detail.phase,kind==='read'?'RESPONSE_READ':kind==='decode'?'TEXT_DECODE':kind==='bytes'?'RESPONSE_READ':'REQUEST');
  assert.equal(detail.validation,kind==='bytes'?'BODY_BOUND':kind==='decode'?'TEXT_DECODE':null);
  assert.equal(ports.fetcher.failureDiagnostic({...error}),null);assert.ok(!JSON.stringify(detail).includes('PRIVATE_SENTINEL'));
 });
});
test('AP2 native bounded timeout remains one request and cannot become HTTP evidence',async t=>{
 const r=fixture(t),cap=authorizeChild(r.envelopePath,'--run');let calls=0;
 const ports=createPorts(cap,r.credentials,{...fixturePorts(r),fetcher:()=>{calls++;return new Promise(()=>{});}});
 let error;await assert.rejects(()=>ports.fetcher('https://identitytoolkit.googleapis.com/v1/projects/signmons/accounts:lookup',{}),e=>{error=e;return true;});
 assert.deepEqual(ports.fetcher.failureDiagnostic(error),{phase:'REQUEST',category:'TIMEOUT',validation:null});
 assert.equal(calls,1);
});
