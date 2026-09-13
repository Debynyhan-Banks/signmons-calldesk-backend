import { execFileSync } from 'node:child_process';

export function normalizeUsPhone(value) {
  if (typeof value !== 'string' || value.length > 40) return null;
  const raw = value.trim();
  if (!/^[+0-9().\s-]+$/.test(raw)) return null;
  let digits = raw.replace(/[().\s-]/g, '');
  if (digits.startsWith('+')) {
    if (!/^\+1\d{10}$/.test(digits)) return null;
    digits = digits.slice(2);
  } else if (/^1\d{10}$/.test(digits)) digits = digits.slice(1);
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(digits)) return null;
  return '+1' + digits;
}

// Only private dialog content uses the returned value. Never log raw responses.
export function privateDialog(prompt, run = execFileSync) {
  const literal = JSON.stringify(prompt);
  const script = `try
set reply to display dialog ${literal} default answer "" with hidden answer buttons {"Cancel", "Continue"} default button "Continue" giving up after 120
if gave up of reply then return "TIMEOUT"
return "VALUE:" & text returned of reply
on error number -128
return "CANCELLED"
end try`;
  try {
    const result = run('osascript', ['-e', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 125000 }).trim();
    if (result === 'TIMEOUT' || result === 'CANCELLED') return { status: result };
    if (result.startsWith('VALUE:')) return { status: 'VALUE', value: result.slice(6) };
    return { status: 'UNAVAILABLE' };
  } catch { return { status: 'UNAVAILABLE' }; }
}

export function collectApprovedPhone(ask = privateDialog, suffix = '3183') {
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = ask(`${attempt ? 'Please try again. ' : ''}Signmons: enter your approved US mobile ending ${suffix}. Ten digits, 1 plus ten digits, or +1 format are accepted. Spaces, parentheses and dashes are OK. No text is sent by this dialog.`);
    if (result.status !== 'VALUE') throw Error(`Private phone input: ${result.status}`);
    const phone = normalizeUsPhone(result.value);
    if (!phone || !phone.endsWith(suffix)) continue;
    const confirmation = ask(`Confirm ${phone} is the phone you approved for one verification text. Type YES to confirm, or Cancel to stop. No text is sent yet.`);
    if (confirmation.status !== 'VALUE') throw Error(`Private phone input: ${confirmation.status}`);
    if (confirmation.value.trim().toUpperCase() === 'YES') return phone;
    throw Error('Private phone input: NOT_CONFIRMED');
  }
  throw Error('Private phone input: INVALID_FORMAT_OR_DESTINATION');
}
