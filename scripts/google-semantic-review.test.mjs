import {test} from 'node:test';
import assert from 'node:assert/strict';
import {semanticReview} from './google-semantic-review.mjs';
const request={address:{addressLines:['fictional','Unit 2'],locality:'Example',postalCode:'44101'}};
test('only review enums escape; local bindings grant no live authority',async()=>{
  let seen;
  const text=await semanticReview(request,{secret:'raw'},{
    address:()=>({status:'REVIEW',candidate:{secret:'private'}}),
    county:async(...args)=>{seen=args;return {coverage:'IN_AREA'};},
  },100);
  assert.match(text,/REVIEW/);assert.match(text,/IN_AREA/);
  assert.ok(!text.includes('private'));assert.ok(!text.includes('raw'));
  assert.equal(seen[3],'REVIEW_ONLY');
  assert.equal(seen[2].current.tenantId,'local-owner-inspection');
});
test('unrecognized provider-like strings never appear',async()=>{
  const text=await semanticReview(request,{},{
    address:()=>({status:'RAW SECRET'}),county:async()=>({coverage:'RAW SECRET'}),
  },100);
  assert.ok(!text.includes('RAW SECRET'));assert.match(text,/UNKNOWN/);
});
