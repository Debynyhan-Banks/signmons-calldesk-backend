import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeInspection } from './run-google-address-inspection.mjs';
import { operator } from './prepare-google-address.mjs';
const args = ['--approved-single-request','2026-09-12T22:00:00Z','2026-09-12T22:10:00Z'];
function fixture() {
  const calls = [];
  return { calls, ports: {
    now: () => Date.parse('2026-09-12T22:01:00Z'),
    account: () => operator,
    directory: () => '/fictional/private',
    collect: () => ({ fictional: true }),
    confirm: () => ({ status:'VALUE',value:'SEND' }),
    run: async (policy,input) => { calls.push({policy,input});return {status:'OBSERVED'}; },
  }};
}
test('connects one fixed packet only after confirmation',async()=>{
  const {ports,calls}=fixture();await executeInspection(args,ports);
  assert.equal(calls.length,1);
  assert.equal(calls[0].policy.approval.packetId,'google-address-inspection-001');
  assert.equal(calls[0].policy.approval.requestLimit,1);
  assert.equal(calls[0].policy.approval.liabilityMicros,100000);
});
for(const input of [[],['--prepare-only'],['--approved-single-request','bad','bad'],
  ['--approved-single-request',args[1],'2026-09-12T23:00:00Z']])
test('invalid invocation never reaches runner '+JSON.stringify(input),async()=>{
  const {ports,calls}=fixture();await assert.rejects(executeInspection(input,ports));
  assert.equal(calls.length,0);
});
for(const reply of [{status:'CANCELLED'},{status:'VALUE',value:'YES'},{status:'VALUE',value:'NO'}])
test('requires SEND '+JSON.stringify(reply),async()=>{
  const {ports,calls}=fixture();ports.confirm=()=>reply;
  await assert.rejects(executeInspection(args,ports));assert.equal(calls.length,0);
});
test('wrong account refuses before input',async()=>{
  const {ports}=fixture();ports.account=()=> 'wrong';ports.collect=()=>assert.fail();
  await assert.rejects(executeInspection(args,ports));
});
test('expiry while entering address refuses',async()=>{
  const {ports,calls}=fixture();ports.confirm=()=>{ports.now=()=>Date.parse(args[2]);return {status:'VALUE',value:'SEND'};};
  await assert.rejects(executeInspection(args,ports));assert.equal(calls.length,0);
});
