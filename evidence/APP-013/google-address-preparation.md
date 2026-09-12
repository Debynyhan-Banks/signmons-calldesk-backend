# Private local address preparation

Owner approved existing debynyhan@signmons.com login for local preparation, not a live send. scripts/prepare-google-address.mjs supports only --prepare-only. It reads active gcloud account metadata, requires that exact login, and establishes the stable .signmons-address-inspection directory under the canonical home directory with mode 0700/current-user ownership. Symlinks, unsafe permissions and existing entries refuse; no automatic deletion/reset.

Private native dialogs collect street/unit/city/ZIP and explicit legitimate-address confirmation. Fields are bounded and control characters refused. Input is returned in the same existing transport request shape inside the helper, then discarded by preparation. Only PREPARED_ONLY, addressRetained=false and dispatchAuthorized=false are output. No token lookup, provider client, response, live-send option or address persistence.

Nine local injected-dialog/filesystem tests pass, plus syntax and whitespace checks. Initial tests found macOS temporary-path aliasing; canonicalizing the base before checking the child resolved it. Real dialogs have NOT been exercised in this checkpoint. No claim directory was created in the real home during tests. No runtime source/schema/dependency/UI change; prior 2,135 runtime tests remain historical, not rerun.

This command prepares but does not invoke GoogleAddressOneShot. Live execution still needs an explicit approved packet/window/allowance and narrow connection to the existing transport using the approved login. Do not silently turn preparation into send. Current directory policy prevents continuing past any existing hold without review. Operator IAM permission check previously passed serviceusage.services.use; this is not proof that the deployed backend identity is ready.

Review: node --test scripts/prepare-google-address.test.mjs. User-ready native rehearsal: node scripts/prepare-google-address.mjs --prepare-only. No live Google validation in either command. APP-013/2B Now; 3/8 (37.5%) unchanged.
