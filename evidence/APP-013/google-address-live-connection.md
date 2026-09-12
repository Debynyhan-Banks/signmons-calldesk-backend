# Supervised address connection — not executed

Owner approved connecting preparation and one-shot runner, not spending/sending. scripts/run-google-address-inspection.mjs accepts only --approved-single-request plus two UTC timestamps, maximum 15 minutes. It checks exact approved account, protected stable empty directory, privately collects/validates address, then separately requires SEND consent explicitly naming Google/USPS, one request and USD 0.10 application allowance.

Only after confirmation does it load existing compiled runner/transport. Runner persists claim before the transport obtains a short-lived token for the explicit approved account. No IAM or API-key change, token logging, new deployment, DB write or fixture-ledger promotion. Packet ID is fixed google-address-inspection-001; any existing directory evidence refuses. Rebuild reviewed source before execution; dist is not a release artifact assertion.

Nineteen script tests (ten connection, nine preparation), syntax and whitespace pass. Tests inject all private dialogs/account/provider seams; no real input or request this turn. Prior native preparation passed PREPARED_ONLY/addressRetained=false/dispatchAuthorized=false after the owner corrected and confirmed their address. Prior runner runtime suite is historical.

Output remains stripped OBSERVED/REFUSED/UNCERTAIN and false downstream authority. OBSERVED proves only a timely transport response; this command discards the body and does not establish county wire format or semantic eligibility. Do not call it county-field acceptance. A separately reviewed in-process inspection would be needed for that purpose; do not add durable response capture implicitly.

Before actual execution, owner must approve ONE legitimate-address request with USD 0.10 application liability allowance, no retry and a current window. Public rate/taxes and effective quotas must be rechecked as appropriate. This is not an account-wide invoice cap or release permission. Address must be re-entered because rehearsal retained none.

No request performed, no provider charge or live acceptance. APP-013/2B Now; 3/8 (37.5%) unchanged.
