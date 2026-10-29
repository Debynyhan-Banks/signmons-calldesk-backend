"use strict";
// Disabled local authority bridge. It never reads a credential or calls a provider.
import {hash, need, authorize} from './auth-authority-owned.mjs';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
function verifyBundle() {
  const manifest = JSON.parse(readFileSync(root + 'source-manifest.json', 'utf8'));
  need(manifest.status === 'DISABLED_LOCAL_ONLY' &&
    Object.keys(manifest.files ?? {}).sort().join(',') ===
    'auth-authority-owned.mjs,bridge.py,owned-key-authority.mjs,owned-key-authority.test.mjs,test_bridge.py',
    'SOURCE_MANIFEST');
  for (const [name, expected] of Object.entries(manifest.files)) {
    need(hash(readFileSync(root + name)) === expected, 'SOURCE_DRIFT');
  }
  const external = manifest.lockedExternal ?? {};
  need(Object.keys(external).sort().join(',') ===
    '../../p08-authentication-local-20261026/source/auth-authority.mjs,../../p08-authentication-local-20261026/source/reuse/operator-bridge.mjs,../../p08-authentication-local-20261026/source/reuse/plan.json',
    'EXTERNAL_SOURCE_SCOPE');
  for (const [relative, expected] of Object.entries(external)) {
    need(hash(readFileSync(new URL(relative, import.meta.url))) === expected, 'EXTERNAL_SOURCE_DRIFT');
  }
}

const hex64 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid4 = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const restrictions = {apiTargets: [{service: 'identitytoolkit.googleapis.com'}]};

export function deriveOwnedKeyAuthority(basePlan, ownerApproval, receipt, context) {
  verifyBundle();
  need(basePlan?.mode === 'LOCAL_NATIVE_BRIDGE_ONLY' && basePlan?.externalActionAuthorized === false,
    'LOCAL_ONLY');
  need(ownerApproval?.owner === 'Debynyhan Banks' && ownerApproval?.decision === 'APPROVE_LOCAL_OWNED_KEY_DERIVATION' &&
    ownerApproval?.externalActionAuthorized === false && ownerApproval?.operationId === basePlan.operationId &&
    ownerApproval?.basePlanSha256 === hash(basePlan), 'DERIVATION_APPROVAL');
  need(basePlan.automaticRetryAllowed === false && basePlan.serviceRetention === 'UNDECIDED_REFUSE_LIVE' &&
    basePlan.allowanceUsd === 0, 'LOCAL_BOUNDARY');
  need(uuid4(basePlan.operationId) && /^[0-9]{6,20}$/.test(basePlan.projectNumber ?? '') &&
    hex64(basePlan.projectNumberSha256) && hash(basePlan.projectNumber) === basePlan.projectNumberSha256,
    'PROJECT_BINDING');
  const expectedKey = `projects/${basePlan.projectNumber}/locations/global/keys/signmons-p08-${basePlan.operationId.replaceAll('-', '')}`;
  need(basePlan.exchange?.keyResource === expectedKey && basePlan.exchange?.keySha256 === null,
    'UNBOUND_KEY_PLAN');
  need(receipt && Object.keys(receipt).sort().join(',') ===
    'createdInOperation,deleted,displayName,etag,keyResource,keyStringSha256,operationId,ownedAt,restrictions,uid',
    'RECEIPT_SHAPE');
  need(receipt.operationId === basePlan.operationId && receipt.keyResource === expectedKey &&
    receipt.createdInOperation === true && receipt.deleted === false &&
    receipt.displayName === `Signmons P08 ${basePlan.operationId}` &&
    uuid4(receipt.uid) && typeof receipt.etag === 'string' && receipt.etag.length > 0 && receipt.etag.length <= 256 &&
    JSON.stringify(receipt.restrictions) === JSON.stringify(restrictions) && hex64(receipt.keyStringSha256),
    'KEY_OWNERSHIP');
  const owned = Date.parse(receipt.ownedAt), start = Date.parse(basePlan.window?.start), end = Date.parse(basePlan.window?.workEnd);
  need(Number.isFinite(owned) && Number.isFinite(start) && Number.isFinite(end) && start <= owned && owned < end,
    'KEY_TIME_BINDING');
  need(context?.localOnly === true && context?.ownership?.operationId && context?.proposal && context?.sources &&
    typeof context.now === 'function', 'AUTH_CONTEXT');
  const derived = structuredClone(basePlan);
  delete derived.mode;
  delete derived.externalActionAuthorized;
  delete derived.allowanceUsd;
  delete derived.serviceRetention;
  delete derived.projectNumber;
  delete derived.projectNumberSha256;
  derived.exchange.keySha256 = receipt.keyStringSha256;
  // The exact local derivation rule is owner-approved against the base plan.
  // The historical authority's other guards run unchanged on the derived plan.
  const innerApproval = {...ownerApproval, decision: 'APPROVE_EXACT_OPERATOR_AUTHENTICATION',
    externalActionAuthorized: true, planSha256: hash(derived)};
  // Exercise the unchanged authentication gates, but do not export a live capability.
  authorize(derived, innerApproval, context);
  return {derivedPlanSha256: hash(derived), keyResource: expectedKey,
    receiptSha256: hash(receipt), liveAuthorization: false};
}

export function native() {
  process.stdout.write('P08_OWNED_KEY_AUTHORITY_REFUSED_UNBOUND\n');
  return 2;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exitCode = native();
}
