"use strict";
// Injected-only owned-key handoff into the existing authentication controller.
// No credential resolver, network client, or live entry is exported here.
import {readFileSync, lstatSync, realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {deriveOwnedKeyAuthority} from '../../../p08-native-bridge-local-20261029/source/owned-key-authority.mjs';
import {hash, need, authorize} from './auth-authority-owned.mjs';
import {AuthController} from './auth-controller.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const expectedFiles = ['auth-authority-owned.mjs', 'auth-controller.mjs', 'auth-handoff.mjs', 'auth-handoff.test.mjs'];
const expectedExternal = {
  '../../../p08-native-bridge-local-20261029/source/owned-key-authority.mjs': '0a5c902a963c035010d00b9b98d52ec40f27bd1350d0891d7baf62260d5f613f',
  '../../../p08-authentication-local-20261026/source/auth-controller.mjs': '57ab0853630112145e81e10143b05099b2a446f7f450d0eff4598540528ef0c4',
};

export function verifyBundle() {
  const manifest = JSON.parse(readFileSync(root + 'source-manifest.json', 'utf8'));
  need(manifest.status === 'DISABLED_LOCAL_ONLY' &&
    Object.keys(manifest.files ?? {}).sort().join(',') === expectedFiles.sort().join(',') &&
    JSON.stringify(manifest.lockedExternal) === JSON.stringify(expectedExternal), 'AUTH_HANDOFF_MANIFEST');
  for (const [name, digest] of Object.entries(manifest.files)) {
    need(hash(readFileSync(root + name)) === digest, 'AUTH_HANDOFF_SOURCE_DRIFT');
  }
  for (const [name, digest] of Object.entries(expectedExternal)) {
    need(hash(readFileSync(new URL(name, import.meta.url))) === digest, 'AUTH_HANDOFF_EXTERNAL_DRIFT');
  }
  return true;
}

export async function runLocalOwnedAuth({basePlan, ownerApproval, receipt, context, clientsFactory, directory, stepTimeout = 10000}) {
  verifyBundle();
  need(context?.localOnly === true && typeof clientsFactory === 'function', 'INJECTED_CLIENTS_REQUIRED');
  const derivation = deriveOwnedKeyAuthority(basePlan, ownerApproval, receipt, context);
  need(derivation.liveAuthorization === false, 'LIVE_AUTHORITY_REFUSED');
  const derived = structuredClone(basePlan);
  for (const name of ['mode', 'externalActionAuthorized', 'allowanceUsd', 'serviceRetention',
                      'projectNumber', 'projectNumberSha256']) delete derived[name];
  derived.exchange.keySha256 = receipt.keyStringSha256;
  need(hash(derived) === derivation.derivedPlanSha256, 'DERIVED_PLAN_DRIFT');
  const approval = {...ownerApproval, decision: 'APPROVE_EXACT_OPERATOR_AUTHENTICATION',
    externalActionAuthorized: true, planSha256: hash(derived)};
  const cap = authorize(derived, approval, {now: context.now, proposal: context.proposal,
    sources: context.sources, ownership: context.ownership});
  need(/^\/private\/tmp\/p08-auth-proof-[A-Za-z0-9_-]+$/.test(directory) &&
    realpathSync(directory) === directory && (lstatSync(directory).mode & 0o777) === 0o700,
    'PRIVATE_DIRECTORY');
  const clients = await clientsFactory();
  let result, sessionsAbsent = false;
  try {
    need(typeof clients?.close === 'function' && typeof clients?.db?.get === 'function' &&
      typeof clients?.fb?.get === 'function' && typeof clients?.issue === 'function' &&
      typeof clients?.authenticate === 'function', 'INJECTED_CLIENTS_REQUIRED');
    result = await new AuthController({cap, clients, directory, now: context.now,
      stepTimeout}).authenticate();
  } finally {
    try { sessionsAbsent = await clients?.close?.() === true; }
    catch { sessionsAbsent = false; }
    clients?.clear?.();
  }
  const residuals = [...(result.residuals ?? [])];
  if (!sessionsAbsent) residuals.push('DATABASE_SESSION_READBACK');
  return {status: residuals.length ? 'P08_AUTH_HANDOFF_CLOSEOUT_UNCONFIRMED' : result.status,
    authenticated: result.authenticated,
    residuals, sessionsAbsent, liveAuthorization: false,
    authProofReady: false};
}

export function native() {
  process.stdout.write('P08_AUTH_HANDOFF_REFUSED_UNBOUND\n');
  return 2;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exitCode = native();
}
