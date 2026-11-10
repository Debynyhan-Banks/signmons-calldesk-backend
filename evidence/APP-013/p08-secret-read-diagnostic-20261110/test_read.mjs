import test from 'node:test';import assert from 'node:assert/strict';import {diagnose} from './read.mjs';
for(const kind of ['valid','denied','foreign_reason','invalid_json','missing','foreign','live','newline','overflow','transport','expired'])test('one secret read: '+kind,async()=>{
 const input={projectNumber:'123456789012',token:'PRIVATE_SENTINEL_TOKEN_123456',deadline:Date.now()+(kind==='expired'?-1:10000)};let calls=0;
 const out=await diagnose(input,async(url,options)=>{calls++;assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert.ok(!url.includes('PRIVATE_SENTINEL'));assert.equal(options.headers.Authorization,'Bearer PRIVATE_SENTINEL_TOKEN_123456');
  if(kind==='transport')throw new TypeError('PRIVATE_SENTINEL');
  if(kind==='denied'||kind==='foreign_reason')return new Response(JSON.stringify({error:{message:'PRIVATE_SENTINEL',details:[{reason:kind==='denied'?'IAM_PERMISSION_DENIED':'PRIVATE_SENTINEL'}]}}),{status:403});
  if(kind==='invalid_json')return new Response('PRIVATE_SENTINEL');
  if(kind==='overflow')return new Response('x'.repeat(65537));
  let name='projects/123456789012/secrets/signmons-staging-stripe-secret-key/versions/1';if(kind==='foreign')name+='2';
  const key=kind==='live'?'sk_live_12345678901234567890':kind==='newline'?'sk_test_12345678901234567890\n':'sk_test_12345678901234567890';
  return new Response(JSON.stringify({name,payload:kind==='missing'?null:{data:Buffer.from(key).toString('base64')}}));
 });
 const expected={valid:'TEST_KEY_VALID',denied:'PAYMENT_SECRET_REFUSED',foreign_reason:'PAYMENT_SECRET_REFUSED',invalid_json:'SECRET_JSON_INVALID',missing:'PAYMENT_SECRET_SHAPE',foreign:'PAYMENT_SECRET_SHAPE',live:'PAYMENT_TEST_KEY_REQUIRED',newline:'PAYMENT_TEST_KEY_REQUIRED',overflow:'PAYMENT_OUTPUT_LIMIT',transport:'SECRET_TRANSPORT_OR_ENCODING',expired:'PAYMENT_DEADLINE'};
 assert.equal(out.code,expected[kind]);assert.equal(calls,kind==='expired'?0:1);assert.equal(input.token,'');assert.equal(input.projectNumber,'');assert.doesNotMatch(JSON.stringify(out),/PRIVATE_SENTINEL|sk_test|sk_live/);
 if(kind==='denied')assert.equal(out.providerReason,'IAM_PERMISSION_DENIED');
 if(kind==='foreign_reason')assert.equal(out.providerReason,'UNCLASSIFIED');
});
