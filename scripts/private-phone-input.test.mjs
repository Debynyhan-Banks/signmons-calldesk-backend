import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {normalizeUsPhone, privateDialog, collectApprovedPhone} from './private-phone-input.mjs';
for(const value of ['2025550123','12025550123','+12025550123','(202) 555-0123','+1 (202) 555-0123',' 202.555.0123 ']) test('normalizes '+value,()=>assert.equal(normalizeUsPhone(value),'+12025550123'));
for(const value of ['',null,'+442025550123','++12025550123','2025550123x9','1025550123','2021550123','202555012','22025550123'])test('rejects '+value,()=>assert.equal(normalizeUsPhone(value),null));
test('normalizes and privately confirms before returning',()=>{
  const replies=[{status:'VALUE',value:'2025550123'},{status:'VALUE',value:'YES'}];
  assert.equal(collectApprovedPhone(()=>replies.shift(),'0123'),'+12025550123');
});
test('invalid entry can retry without external access',()=>{
  const replies=[{status:'VALUE',value:'bad'},{status:'VALUE',value:'2025550123'},{status:'VALUE',value:'yes'}];
  assert.equal(collectApprovedPhone(()=>replies.shift(),'0123'),'+12025550123');
});
for(const status of ['CANCELLED','TIMEOUT','UNAVAILABLE'])test(status+' is explicit',()=>assert.throws(()=>collectApprovedPhone(()=>({status})),new RegExp(status)));
test('wrong destination rejected with bounded attempts',()=>{let calls=0;assert.throws(()=>collectApprovedPhone(()=>{calls++;return {status:'VALUE',value:'2025550123'};}),/INVALID_FORMAT/);assert.equal(calls,3);});
test('confirmation required',()=>{let calls=0;assert.throws(()=>collectApprovedPhone(()=>({status:'VALUE',value:calls++?'NO':'2025550123'}),'0123'),/NOT_CONFIRMED/);});
test('dialog distinguishes empty, cancellation and timeout',()=>{
  assert.deepEqual(privateDialog('test',()=> 'VALUE:\n'),{status:'VALUE',value:''});
  assert.deepEqual(privateDialog('test',()=> 'TIMEOUT\n'),{status:'TIMEOUT'});
  assert.deepEqual(privateDialog('test',()=> 'CANCELLED\n'),{status:'CANCELLED'});
  assert.deepEqual(privateDialog('test',()=>{throw Error('sensitive');}),{status:'UNAVAILABLE'});
});
test('input runs before credential access and IAM work',()=>{
  const source=readFileSync(new URL('./rehearse-phone-auth.mjs',import.meta.url),'utf8');
  assert(source.indexOf('const approvedPhone = collectApprovedPhone()')<source.indexOf("const accessToken=gc("));
  assert(source.includes('runApprovedPhoneTest(idToken, approvedPhone)'));
});
