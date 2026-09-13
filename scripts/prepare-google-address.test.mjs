import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, chmodSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectAddress, prepare, protectedClaimDirectory, operator } from './prepare-google-address.mjs';
const ask = (values) => () => ({ status: 'VALUE', value: values.shift() ?? '' });
test('private structured address confirmation', () => {
  assert.deepEqual(collectAddress(ask(['123 Fictional Street','Unit 2','Example','44101','YES'])),
    { address: { regionCode:'US', administrativeArea:'OH', locality:'Example', postalCode:'44101',
      addressLines:['123 Fictional Street','Unit 2'] }, enableUspsCass:true });
});
for (const values of [
  ['', '', 'Example','44101','YES'],
  ['123 Fictional Street','','Example','bad','YES'],
  ['123 Fictional Street','','Example','44101','NO'],
  ['123\nStreet','','Example','44101','YES'],
]) test('refuses invalid or unconfirmed input '+JSON.stringify(values), () =>
  assert.throws(() => collectAddress(ask([...values]))));
test('cancellation stops collection', () => assert.throws(() =>
  collectAddress(() => ({status:'CANCELLED'}))));
test('private stable directory refuses altered permissions and retained evidence', () => {
  const base = mkdtempSync(join(tmpdir(),'signmons-prep-test-'));
  try {
    const dir = protectedClaimDirectory(base);
    assert.equal(protectedClaimDirectory(base),dir);
    chmodSync(dir,0o755); assert.throws(() => protectedClaimDirectory(base));
    chmodSync(dir,0o700); writeFileSync(join(dir,'existing.held'),'{}');
    assert.throws(() => protectedClaimDirectory(base));
  } finally { rmSync(base,{recursive:true}); }
});
test('preparation performs account read only and strips address', () => {
  const base = mkdtempSync(join(tmpdir(),'signmons-prep-test-'));
  try {
    const calls=[];
    const result=prepare({base,ask:ask(['123 Fictional Street','','Example','44101','YES']),
      run:(cmd,args)=>{calls.push([cmd,args]);return operator;}});
    assert.equal(calls.length,1); assert.equal(calls[0][1][0],'auth');
    assert.deepEqual(result,{status:'PREPARED_ONLY',addressRetained:false,dispatchAuthorized:false});
  } finally { rmSync(base,{recursive:true}); }
});
test('wrong login refuses before private input', () =>
  assert.throws(() => prepare({run:()=> 'other',ask:()=>assert.fail('must not prompt')})));
