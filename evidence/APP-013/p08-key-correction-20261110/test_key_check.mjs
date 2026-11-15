import test from 'node:test';import assert from 'node:assert/strict';
import {checkKey,endpointInputStatus,endpointOnce,ENDPOINT,ENDPOINT_CODES,ENDPOINT_PHASES} from './key_check.mjs';
import {hash} from '../p08-native-entry-local-20261101/source/authority_bridge.mjs';
import {EVENTS,stripeSecretName} from '../p08-native-entry-local-20261101/source/connected_payment.mjs';
import {readFileSync} from 'node:fs';
const origin=JSON.parse(readFileSync(new URL('../p08-local-preparation-20261022/plan.json',import.meta.url))).origin;
const pins={account:hash('acct_owned'),endpoint:hash('we_owned')};
function fixture(change=()=>{}){
 const input={key:'sk_test_'+'a'.repeat(24),endpointId:'we_owned',deadline:Date.now()+50000};const calls=[];
 const rows=[{object:'list',has_more:false,data:[{id:'acct_owned',object:'account',charges_enabled:true}]},
  {object:'balance',livemode:false},{id:'we_owned',object:'webhook_endpoint',livemode:false,url:origin+'/webhooks/stripe',api_version:'2026-03-25.dahlia',enabled_events:EVENTS,status:'disabled'}];
 change(rows,input);
 return {input,calls,send:async(url,opts)=>{calls.push({url,opts});return new Response(JSON.stringify(rows[calls.length-1]));}};
}
test('actual shared decoder/response/endpoint boundary; platform key binds connected account',async()=>{
 const f=fixture();assert.equal((await checkKey(f.input,f.send,pins)).requests,3);
 assert.match(f.calls[0].url,/accounts\?limit=100$/);assert.equal(f.calls.every(x=>x.opts.method==='GET'),true);
 assert.equal(f.input.key,'');assert.equal(f.input.endpointId,'');
});
for(const [name,change] of Object.entries({liveKey:(r,i)=>i.key='sk_live_'+'b'.repeat(24),newline:(r,i)=>i.key+='\n',wrongEndpoint:(r,i)=>i.endpointId='we_foreign',
 foreignAccount:r=>r[0].data[0].id='acct_foreign',platformAccountIsNotConnectedAccount:r=>r[0]={object:'account',id:'acct_owned'},
 moreAccounts:r=>r[0].has_more=true,missingCharges:r=>delete r[0].data[0].charges_enabled,nullAccounts:r=>r[0].data=null,
 liveMode:r=>r[1].livemode=true,missingMode:r=>delete r[1].livemode,enabledEndpoint:r=>r[2].status='enabled',foreignURL:r=>r[2].url='https://wrong.invalid',expired:(r,i)=>i.deadline=Date.now()-1
}))test('key qualification rejects '+name+' without mutation',async()=>{
 const f=fixture(change);await assert.rejects(()=>checkKey(f.input,f.send,pins));assert.ok(f.calls.length<=3);assert.equal(f.input.key,'');assert.equal(f.input.endpointId,'');
});
test('provider failure does not retry',async()=>{let calls=0;const f=fixture();await assert.rejects(()=>checkKey(f.input,async()=>{calls++;return new Response('private',{status:403});},pins));assert.equal(calls,1);});

test('actual payment secret resource follows corrected numeric pin and rejects omission',()=>{
 const e={plan:{projectNumber:'123456'},resources:{candidate:'signmons-calldesk-staging-p07key0123456789ab',secretVersions:{'signmons-staging-stripe-secret-key':'7'}}};
 assert.equal(stripeSecretName(e),'projects/123456/secrets/signmons-staging-stripe-secret-key/versions/7');
 delete e.resources.secretVersions['signmons-staging-stripe-secret-key'];assert.throws(()=>stripeSecretName(e));
 e.resources.candidate='signmons-calldesk-staging-app013p07atomic1';assert.match(stripeSecretName(e),/versions\/1$/);
});

test('shared endpoint predicate diagnoses input without normalizing acceptance',()=>{
 const pin=hash('we_fixture');
 assert.equal(endpointInputStatus('we_fixture',pin).exactMatch,true);
 for(const value of [' we_fixture','we_fixture ','\twe_fixture\n']){
  const v=endpointInputStatus(value,pin);assert.equal(v.exactMatch,false);assert.equal(v.trimmedMatch,true);assert.equal(v.surroundingWhitespace,true);
 }
 assert.equal(endpointInputStatus('https://stripe.invalid/we_fixture',pin).looksLikeUrl,true);
 assert.equal(endpointInputStatus('we_foreign',pin).formatValid,true);assert.equal(endpointInputStatus('we_foreign',pin).exactMatch,false);
 assert.equal(endpointInputStatus('we_fixture\u200b',pin).controlOrNonAscii,true);
 assert.equal(endpointInputStatus(null,pin).isString,false);
});
test('actual local CLI has no provider request and emits no supplied input',async()=>{
 const {execFileSync}=await import('node:child_process');
 const value='https://fixture.invalid/PRIVATE_SENTINEL';
 const raw=execFileSync(process.execPath,[(await import('node:url')).fileURLToPath(new URL('./key_check.mjs',import.meta.url)),'--inspect-endpoint-local'],{input:JSON.stringify({endpointId:value}),encoding:'utf8',timeout:5000});
 const v=JSON.parse(raw);assert.equal(v.providerCalls,0);assert.equal(v.looksLikeUrl,true);assert.equal(v.exactMatch,false);assert.doesNotMatch(raw,/PRIVATE_SENTINEL|fixture.invalid/);
});
test('actual refusal CLI returns only input-shape flags with no fetch or raw value',async()=>{
 const {spawnSync}=await import('node:child_process');const {fileURLToPath}=await import('node:url');
 for(const value of ['https://fixture.invalid/PRIVATE_SENTINEL','we_PRIVATE_SENTINEL',' we_PRIVATE_SENTINEL ']){
  const r=spawnSync(process.execPath,[fileURLToPath(new URL('./key_check.mjs',import.meta.url))],{input:JSON.stringify({key:'PRIVATE_SECRET_SENTINEL',endpointId:value,deadline:Date.now()+50000}),encoding:'utf8',timeout:5000});
  assert.equal(r.status,2);const v=JSON.parse(r.stdout);assert.equal(v.code,'KEY_ENDPOINT_PIN');assert.equal(v.endpointInput.providerCalls,0);assert.equal(v.endpointInput.exactMatch,false);assert.doesNotMatch(r.stdout,/PRIVATE_SENTINEL|PRIVATE_SECRET_SENTINEL/);
 }
});

const endpointKeys=['code','httpStatus','phase','requests','scope','state','status'];
function endpointFixture(phase='OBSERVE',change=()=>{}){
 const input={phase,key:'sk_test_'+'a'.repeat(24),endpointId:'we_owned',deadline:Date.now()+50000};
 const row={id:'we_owned',object:'webhook_endpoint',livemode:false,url:origin+'/webhooks/stripe',
  api_version:'2026-03-25.dahlia',enabled_events:[...EVENTS],status:'disabled'};
 change(row,input);const calls=[];
 return {input,row,calls,send:async(url,opts)=>{calls.push({url,opts:{...opts,headers:{...opts.headers}}});return new Response(JSON.stringify(row));}};
}
function safeEndpoint(result,input){
 assert.deepEqual(Object.keys(result).sort(),endpointKeys);
 assert.ok(ENDPOINT_CODES.includes(result.code));assert.ok([...ENDPOINT_PHASES,'UNKNOWN'].includes(result.phase));
 assert.ok([0,1].includes(result.requests));assert.ok(result.httpStatus===null||Number.isInteger(result.httpStatus));
 assert.equal(input.key,'');assert.equal(input.endpointId,'');
 assert.doesNotMatch(JSON.stringify(result),/sk_test_|we_owned|PRIVATE_SENTINEL|webhooks\/stripe/);
}
for(const phase of ENDPOINT_PHASES)test('endpoint '+phase+' uses exactly one pinned request and safe result',async()=>{
 const f=endpointFixture(phase);const r=await endpointOnce(f.input,f.send,pins.endpoint);safeEndpoint(r,f.input);
 assert.deepEqual(r,{status:'ENDPOINT_OBSERVED',phase,code:'NONE',requests:1,httpStatus:200,scope:'MATCH',state:'DISABLED'});
 assert.equal(f.calls.length,1);const call=f.calls[0];
 assert.equal(call.url,'https://api.stripe.com/v1/webhook_endpoints/we_owned');
 assert.equal(call.opts.method,phase==='DISABLE'?'POST':'GET');assert.equal(call.opts.redirect,'error');
 assert.equal(call.opts.headers['Stripe-Version'],'2026-03-25.dahlia');
 assert.match(call.opts.headers.Authorization,/^Bearer sk_test_/);assert.equal('Stripe-Account' in call.opts.headers,false);
 assert.equal(call.opts.body,phase==='DISABLE'?'disabled=true':undefined);assert.ok(call.opts.signal instanceof AbortSignal);
});
for(const phase of ['OBSERVE','VERIFY'])test('endpoint '+phase+' preserves enabled observation',async()=>{
 const f=endpointFixture(phase,row=>row.status='enabled');const r=await endpointOnce(f.input,f.send,pins.endpoint);
 safeEndpoint(r,f.input);assert.equal(r.status,'ENDPOINT_OBSERVED');assert.equal(r.scope,'MATCH');assert.equal(r.state,'ENABLED');
});
test('endpoint disable acknowledgement cannot substitute an enabled state',async()=>{
 const f=endpointFixture('DISABLE',row=>row.status='enabled');const r=await endpointOnce(f.input,f.send,pins.endpoint);
 safeEndpoint(r,f.input);assert.equal(r.status,'ENDPOINT_REFUSED');assert.equal(r.code,'ENDPOINT_NOT_DISABLED');
 assert.equal(r.scope,'MATCH');assert.equal(r.state,'ENABLED');assert.equal(f.calls.length,1);
});
for(const [name,change,code] of [
 ['unknown phase',(_r,i)=>i.phase='ENABLE','ENDPOINT_PHASE'],
 ['extra URL',(_r,i)=>i.url='https://PRIVATE_SENTINEL.invalid','ENDPOINT_INPUT'],
 ['extra pins',(_r,i)=>i.endpointSha256=pins.endpoint,'ENDPOINT_INPUT'],
 ['missing deadline',(_r,i)=>delete i.deadline,'ENDPOINT_INPUT'],
 ['deadline string',(_r,i)=>i.deadline=String(i.deadline),'KEY_CHECK_DEADLINE'],
 ['deadline fraction',(_r,i)=>i.deadline+=.5,'KEY_CHECK_DEADLINE'],
 ['expired',(_r,i)=>i.deadline=Date.now()-1,'KEY_CHECK_DEADLINE'],
 ['excess horizon',(_r,i)=>i.deadline=Date.now()+61000,'KEY_CHECK_DEADLINE'],
 ['wrong endpoint',(_r,i)=>i.endpointId='we_PRIVATE_SENTINEL','KEY_ENDPOINT_PIN'],
 ['endpoint whitespace',(_r,i)=>i.endpointId+=' ','KEY_ENDPOINT_PIN'],
 ['endpoint path',(_r,i)=>i.endpointId='../we_owned','KEY_ENDPOINT_PIN'],
 ['endpoint null',(_r,i)=>i.endpointId=null,'KEY_ENDPOINT_PIN'],
 ['live key',(_r,i)=>i.key='sk_live_'+'a'.repeat(24),'PAYMENT_TEST_KEY_REQUIRED'],
 ['key newline',(_r,i)=>i.key+='\n','PAYMENT_TEST_KEY_REQUIRED'],
 ['key object',(_r,i)=>i.key={private:'PRIVATE_SENTINEL'},'PAYMENT_TEST_KEY_REQUIRED'],
 ['key null',(_r,i)=>i.key=null,'PAYMENT_TEST_KEY_REQUIRED'],
 ['oversized key',(_r,i)=>i.key='sk_test_'+'a'.repeat(257),'PAYMENT_TEST_KEY_REQUIRED'],
])test('endpoint refuses '+name+' before any provider request',async()=>{
 const f=endpointFixture('DISABLE',change);const r=await endpointOnce(f.input,f.send,pins.endpoint);safeEndpoint(r,f.input);
 assert.equal(r.status,'ENDPOINT_REFUSED');assert.equal(r.code,code);assert.equal(r.requests,0);assert.equal(f.calls.length,0);
 assert.equal(r.scope,'UNKNOWN');assert.equal(r.state,'UNKNOWN');
});
for(const [name,change] of Object.entries({foreignId:r=>r.id='we_foreign',wrongObject:r=>r.object='account',
 live:r=>r.livemode=true,missingMode:r=>delete r.livemode,foreignUrl:r=>r.url='https://PRIVATE_SENTINEL.invalid',
 apiVersion:r=>r.api_version='2026-10-28.endive',nullVersion:r=>r.api_version=null,missingEvents:r=>delete r.enabled_events,
 extraEvent:r=>r.enabled_events.push('*'),duplicateEvent:r=>r.enabled_events.push(EVENTS[0]),
 missingStatus:r=>delete r.status,foreignStatus:r=>r.status='active'}))test('endpoint scope drift '+name+' cannot authorize disable',async()=>{
 const f=endpointFixture('OBSERVE',change);const r=await endpointOnce(f.input,f.send,pins.endpoint);safeEndpoint(r,f.input);
 assert.equal(r.status,'ENDPOINT_REFUSED');assert.equal(r.scope,'DRIFT');assert.equal(r.state,'UNKNOWN');
 assert.equal(r.code,'PAYMENT_ENDPOINT_DRIFT');assert.equal(f.calls.length,1);
});
for(const status of [201,202,206,299,403,404,429,500,503])test('endpoint HTTP '+status+' is safe and never retries',async()=>{
 const f=endpointFixture('DISABLE');let calls=0;
 const r=await endpointOnce(f.input,async()=>{calls++;return new Response('PRIVATE_SENTINEL',{status});},pins.endpoint);
 safeEndpoint(r,f.input);assert.equal(r.code,'KEY_CHECK_HTTP');assert.equal(r.httpStatus,status);assert.equal(calls,1);
 assert.equal(r.scope,'UNKNOWN');assert.equal(r.state,'UNKNOWN');
});
test('endpoint lost mutation response is unconfirmed without replay or forged provider error category',async()=>{
 const f=endpointFixture('DISABLE');let calls=0;
 const r=await endpointOnce(f.input,async()=>{calls++;throw Object.assign(new Error('PRIVATE_SENTINEL'),{code:'KEY_ENDPOINT_PIN'});},pins.endpoint);
 safeEndpoint(r,f.input);assert.equal(r.code,'ENDPOINT_TRANSPORT_OR_OUTPUT_UNKNOWN');assert.equal(r.requests,1);
 assert.equal(r.httpStatus,null);assert.equal(calls,1);
});
test('endpoint redirect response cannot produce a follow-up request',async()=>{
 const f=endpointFixture('DISABLE');let calls=0;
 const r=await endpointOnce(f.input,async(_url,options)=>{
  calls++;assert.equal(options.redirect,'error');
  return new Response('',{status:302,headers:{Location:'https://PRIVATE_SENTINEL.invalid'}});
 },pins.endpoint);
 safeEndpoint(r,f.input);assert.equal(r.code,'KEY_CHECK_HTTP');assert.equal(r.httpStatus,302);assert.equal(calls,1);
});
test('endpoint abort deadline produces one unconfirmed request and no retry',async()=>{
 const f=endpointFixture('DISABLE');f.input.deadline=Date.now()+80;let calls=0;
 const r=await endpointOnce(f.input,async(_url,{signal})=>{
  calls++;await new Promise((_resolve,reject)=>{
   // Keep this inert test alive until the production AbortSignal fires; no socket.
   const timer=setTimeout(()=>reject(new Error('test deadline did not abort')),1000);
   signal.addEventListener('abort',()=>{clearTimeout(timer);reject(new Error('PRIVATE_SENTINEL'));},{once:true});
  });
 },pins.endpoint);
 safeEndpoint(r,f.input);assert.equal(r.status,'ENDPOINT_REFUSED');assert.equal(r.requests,1);
 assert.equal(r.httpStatus,null);assert.equal(r.scope,'UNKNOWN');assert.equal(calls,1);
});
test('endpoint rejects an inconsistent HTTP response contract',async()=>{
 const f=endpointFixture();
 const r=await endpointOnce(f.input,async()=>({ok:true,status:'200',text:async()=>JSON.stringify(f.row)}),pins.endpoint);
 safeEndpoint(r,f.input);assert.equal(r.status,'ENDPOINT_REFUSED');assert.equal(r.httpStatus,null);
 assert.equal(r.code,'ENDPOINT_TRANSPORT_OR_OUTPUT_UNKNOWN');assert.equal(r.requests,1);
});
for(const [name,body,code] of [
 ['invalid JSON','{"PRIVATE_SENTINEL":','ENDPOINT_JSON'],
 ['null JSON','null','PAYMENT_ENDPOINT_DRIFT'],
 ['invalid UTF8',new Uint8Array([0xc3,0x28]),'ENDPOINT_TRANSPORT_OR_OUTPUT_UNKNOWN'],
 ['oversized body','x'.repeat(65537),'PAYMENT_OUTPUT_LIMIT'],
])test('endpoint bounded response rejects '+name,async()=>{
 const f=endpointFixture();const r=await endpointOnce(f.input,async()=>new Response(body),pins.endpoint);
 safeEndpoint(r,f.input);assert.equal(r.status,'ENDPOINT_REFUSED');assert.equal(r.code,code);assert.equal(r.requests,1);
});
test('provider duplicate member behavior remains explicitly JSON.parse last member wins',async()=>{
 const f=endpointFixture();const body=JSON.stringify(f.row).replace('"status":"disabled"','"status":"enabled","status":"disabled"');
 const r=await endpointOnce(f.input,async()=>new Response(body),pins.endpoint);
 safeEndpoint(r,f.input);assert.equal(r.status,'ENDPOINT_OBSERVED');assert.equal(r.state,'DISABLED');
});
test('endpoint wall-clock rollback refuses before request',async()=>{
 const f=endpointFixture();const start=Date.now();let tick=0;
 const r=await endpointOnce(f.input,f.send,pins.endpoint,()=>tick++?start-1:start);
 safeEndpoint(r,f.input);assert.equal(r.code,'KEY_CHECK_DEADLINE');assert.equal(f.calls.length,0);
});
test('endpoint deadline reached after a response remains unconfirmed',async()=>{
 const f=endpointFixture();let expired=false;const initial=Date.now();
 const r=await endpointOnce(f.input,async()=>{expired=true;return new Response(JSON.stringify(f.row));},pins.endpoint,()=>expired?initial+60000:initial);
 safeEndpoint(r,f.input);assert.equal(r.code,'KEY_CHECK_DEADLINE');assert.equal(r.status,'ENDPOINT_REFUSED');assert.equal(r.requests,1);
});
test('actual endpoint CLI rejects invalid inputs with bounded safe stdout and empty stderr',async()=>{
 const {spawnSync}=await import('node:child_process');const {fileURLToPath}=await import('node:url');
 const path=fileURLToPath(new URL('./key_check.mjs',import.meta.url));
 const valid={phase:'OBSERVE',key:'PRIVATE_SECRET_SENTINEL',endpointId:'we_PRIVATE_SENTINEL',deadline:Date.now()+50000};
 for(const [input,code] of [[JSON.stringify(valid),'KEY_ENDPOINT_PIN'],['{','ENDPOINT_INPUT'],['null','ENDPOINT_INPUT'],
  ['x'.repeat(8193),'KEY_INPUT_LIMIT'],[Buffer.from([0xc3,0x28]),'ENDPOINT_INPUT']]){
  const child=spawnSync(process.execPath,[path,'--endpoint-once'],{input,encoding:'utf8',timeout:5000});
  assert.equal(child.status,2);assert.equal(child.stderr,'');const r=JSON.parse(child.stdout);
  assert.deepEqual(Object.keys(r).sort(),endpointKeys);assert.equal(r.code,code);assert.equal(r.requests,0);
  assert.doesNotMatch(child.stdout,/PRIVATE_SENTINEL|PRIVATE_SECRET_SENTINEL/);
 }
});
test('actual stdin worker interface performs each injected one-request phase and emits no raw response',async()=>{
 const {spawnSync}=await import('node:child_process');
 const moduleUrl=new URL('./key_check.mjs',import.meta.url).href;
 // The production CLI calls this exact function. Only this inert harness injects
 // a synthetic pin and fetch; the production argv accepts neither replacement.
 const script=`import {endpointCli} from ${JSON.stringify(moduleUrl)};
 import {EVENTS} from ${JSON.stringify(new URL('../p08-native-entry-local-20261101/source/connected_payment.mjs',import.meta.url).href)};
 let calls=0;
 process.exitCode=await endpointCli({pin:${JSON.stringify(pins.endpoint)},send:async(url,options)=>{
  if(++calls!==1)throw Error('unexpected second call');
  return new Response(JSON.stringify({id:'we_owned',object:'webhook_endpoint',livemode:false,
   url:${JSON.stringify(origin+'/webhooks/stripe')},api_version:'2026-03-25.dahlia',enabled_events:EVENTS,status:'disabled',private:'PRIVATE_RESPONSE_SENTINEL'}));
 }});`;
 for(const phase of ENDPOINT_PHASES){
  const f=endpointFixture(phase);const child=spawnSync(process.execPath,['--input-type=module','-e',script],
   {input:JSON.stringify(f.input),encoding:'utf8',timeout:5000});
  assert.equal(child.status,0,child.stderr);assert.equal(child.stderr,'');const r=JSON.parse(child.stdout);
  assert.equal(r.phase,phase);assert.equal(r.requests,1);assert.equal(r.status,'ENDPOINT_OBSERVED');
  assert.doesNotMatch(child.stdout,/sk_test_|we_owned|PRIVATE_RESPONSE_SENTINEL/);
 }
});
test('endpoint protocol lists are immutable and production pin cannot be supplied through stdin',async()=>{
 assert.equal(Object.isFrozen(ENDPOINT_PHASES),true);assert.equal(Object.isFrozen(ENDPOINT_CODES),true);
 assert.equal(ENDPOINT,'dbaae6448069a186dc4b9e2fc6182707dda7b61218376e9e97cd21b20b4bfeae');
 const f=endpointFixture();f.input.pin=pins.endpoint;const r=await endpointOnce(f.input,f.send);
 safeEndpoint(r,f.input);assert.equal(r.code,'ENDPOINT_INPUT');assert.equal(f.calls.length,0);
});
