import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectAddress, operator, protectedClaimDirectory } from './prepare-google-address.mjs';
import { privateDialog } from './private-phone-input.mjs';

// No execution on import. The fixed packet cannot be rotated automatically.
export async function executeInspection(args, ports) {
  if (args.length !== 3 || args[0] !== '--approved-single-request')
    throw Error('Explicit execution approval and UTC window required');
  const start = Date.parse(args[1]), end = Date.parse(args[2]);
  const now = ports.now();
  if (!args[1].endsWith('Z') || !args[2].endsWith('Z') ||
      !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
      now < start || now >= end || end - start > 900000 || end <= start)
    throw Error('Invalid execution window');
  if (ports.account() !== operator) throw Error('Wrong operator');
  const directory = ports.directory();
  const request = ports.collect();
  const confirmation = ports.confirm(
    'LIVE GOOGLE TEST: Submit this just-confirmed address to Google Address Validation and USPS now? ' +
    'One request, USD 0.10 application allowance, no retries. Address/provider response will not be saved. ' +
    'No job, payment or booking. Type SEND to authorize this request, or Cancel.');
  if (confirmation.status !== 'VALUE' || confirmation.value.trim() !== 'SEND')
    throw Error('Submission not confirmed');
  if (ports.now() >= end || ports.now() < start) throw Error('Window expired');
  return ports.run({
    approval: { approved: true, project: 'signmons', packetId: 'google-address-inspection-001',
      rateVersion: 'public-pro-20260912', startsAt: start, expiresAt: end,
      liabilityMicros: 100000, requestLimit: 1 },
    claimDirectory: directory,
  }, request);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const gc = (args) => execFileSync('gcloud', args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000,
  }).trim();
  try {
    const result = await executeInspection(process.argv.slice(2), {
      now: Date.now,
      account: () => gc(['auth','list','--filter=status:ACTIVE','--format=value(account)']),
      directory: protectedClaimDirectory,
      collect: collectAddress,
      confirm: privateDialog,
      run: async (options, request) => {
        const require = createRequire(import.meta.url);
        const { GoogleAddressOneShot } = require('../dist/communications/google-address-one-shot.js');
        const { GoogleAddressOAuthTransport } = require('../dist/communications/google-address-oauth.transport.js');
        const transport = new GoogleAddressOAuthTransport(true, {
          token: () => Promise.resolve(gc(['auth','print-access-token','--account='+operator])),
          fetch: (...args) => fetch(...args),
        });
        return new GoogleAddressOneShot({ ...options, transport }).run(request);
      },
    });
    console.log(JSON.stringify(result)); // Only stripped runner outcome/false authority.
    if (result.status !== 'OBSERVED') process.exitCode = 1;
  } catch {
    console.error('Inspection refused or uncertain. Do not retry or remove any held claim.');
    process.exitCode = 1;
  }
}
