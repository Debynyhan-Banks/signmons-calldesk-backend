import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateDialog } from './private-phone-input.mjs';

export const operator = 'debynyhan@signmons.com';
// Stable across worktrees/restarts; never create a per-attempt temporary directory.
export function protectedClaimDirectory(base = homedir()) {
  const path = join(realpathSync(base), '.signmons-address-inspection');
  try { mkdirSync(path, { mode: 0o700 }); }
  catch (e) { if (e.code !== 'EEXIST') throw Error('Claim directory unavailable'); }
  const s = lstatSync(path);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid() ||
      (s.mode & 0o777) !== 0o700 || realpathSync(path) !== resolve(path))
    throw Error('Claim directory is not private and canonical');
  if (readdirSync(path).length !== 0)
    throw Error('Existing inspection evidence requires review; do not reset');
  return path;
}

export function collectAddress(ask = privateDialog) {
  const take = (label, max, optional = false) => {
    const r = ask('Signmons preparation only: ' + label + '. No address is sent.');
    if (r.status !== 'VALUE') throw Error('Private address input cancelled or unavailable');
    const v = r.value.trim();
    if ((!optional && !v) || v.length > max || /[\p{Cc}\p{Cf}]/u.test(v))
      throw Error('Private address format invalid');
    return v;
  };
  const street = take('enter your legitimate Ohio service street address', 150);
  const unit = take('enter the apartment/unit, or leave blank if none', 30, true);
  const city = take('enter the city', 60);
  const zip = take('enter ZIP or ZIP+4', 10);
  if (!/^\d{5}(-\d{4})?$/.test(zip) ||
      street.length + unit.length + city.length + zip.length + 4 > 280)
    throw Error('Private address format invalid');
  const confirmation = ask('Preparation only. Confirm this is a legitimate service address you may use, not a fictional fixture: ' +
    [street, unit, city, 'OH', zip, 'US'].filter(Boolean).join(', ') +
    '. Type YES. This does not authorize Google/USPS submission.');
  if (confirmation.status !== 'VALUE' || confirmation.value.trim().toUpperCase() !== 'YES')
    throw Error('Private address not confirmed');
  return { address: { regionCode: 'US', administrativeArea: 'OH', locality: city,
    postalCode: zip, addressLines: [street, ...(unit ? [unit] : [])] }, enableUspsCass: true };
}

export function prepare({ base, ask, run = execFileSync } = {}) {
  const account = run('gcloud', ['auth', 'list', '--filter=status:ACTIVE', '--format=value(account)'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 }).trim();
  if (account !== operator) throw Error('Approved Google login is not active');
  protectedClaimDirectory(base);
  collectAddress(ask); // Validate privately, then discard. No serialization or token request.
  return { status: 'PREPARED_ONLY', addressRetained: false, dispatchAuthorized: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2] !== '--prepare-only') {
    console.error('Only --prepare-only is supported. Live execution disabled.');
    process.exitCode = 1;
  } else {
    try { console.log(JSON.stringify(prepare())); }
    catch { console.error('Preparation refused; no address sent or retained.'); process.exitCode = 1; }
  }
}
