# APP-013 / 3A / P08 — installed SDK retry diagnosis

November 1, 2026. Owner directed “proceed” with the SDK blocker investigation. This is local source inspection and four diagnostic tests added to the existing test module. Runtime source, runtime manifest, installed SDK and external authority are unchanged. Backend base d5f1f876e8f17f8236d2262d1856a6fa323a86a4; governance base 996cc7fb5be906ddf64d1d337c7fa6dc24a3a001; work remains uncommitted.

## Demonstrated result

| Actual installed library boundary, synthetic 503 response | Transport invocations |
| --- | --- |
| Generated IAM V1 organizations_roles.Get, default client | 5 |
| Generated Resource Manager V1 projects.Get, default client | 5 |
| Same generated clients with explicit client.num_retries=0 | 1 each |
| google.oauth2.credentials.Credentials.refresh | 3 |
| Lower-level google.oauth2._client.refresh_grant with can_retry=False | 1 |

These are synthetic transport invocations, not observed provider attempts. Separate interpreter, get_credentials=False for generated clients, temporary SDK configuration, synthetic OAuth values, blocked socket connect/connect_ex and test-only suppressed backoff sleeps were used. No real credentials/configuration were read and no provider request occurred. The lower-level controls prove library options, not their exposure through the approved CLI interface.

`python3 -B evidence/APP-013/p08-narrow-access-check-local-20261101/source/test_access_check.py SDKRetryTests -v`: 4 PASS. Full module `-v`: 33 PASS (29 existing adapter cases plus four diagnostic cases). `source/test-manifest.json` records current test hash and 21 inspected SDK source hashes separately from the unchanged runtime manifest. Initial provenance generation used an incorrect surface-file prefix and failed before writing; corrected to the inspected `lib/surface/` paths. Runtime manifest remains 2bc1858ec57385d2b9c6f9867cf77783995b77ea1722a786fa311fa299d2697b; runtime source remains 40b4e2921e752236a2b77c6e3a7bc8d9eb739cc8262d3e7ad461471432957729.

## Inspected call chains and limitations

Installed root `/opt/homebrew/Caskroom/gcloud-cli/583.0.0/google-cloud-sdk`:

- `lib/surface/projects/describe.py` calls projects_api.Get, through projects_util.GetClient and apis.GetClientInstance. The generated Resource Manager constructor inherits BaseApiClient's default num_retries=5. `http_wrapper.MakeRequest` repeats the synthetic retriable response five times.
- `lib/surface/iam/roles/describe.py` uses iam.util.GetClientAndMessages and organizations_roles.Get, the same service method exercised by the diagnostic. Its generated constructor also inherits that default.
- `lib/surface/auth/print_access_token.py` loads credentials through auth_util; ordinary Google OAuth refresh calls reauth.refresh_grant and the token endpoint helper with retries enabled. The actual Credentials class diagnostic repeats three times.
- `core/properties.py` max_retries found by inspection is in storage configuration. No supported global override for these exact CLI paths was established. No environment variable or private SDK patch is treated as a solution.
- `surface/auth/list.py` reaches store.AllAccountsWithUniverseDomains, including static credential providers. It cannot be called guaranteed local solely because its name says list. It has not been executed here.
- `core/credentials/store.py` Load(prevent_refresh=True) still has override/static-provider paths. `creds.GetCredentialStore().Load` avoids that broader resolver but its SqliteCredentialStore/AccessTokenCache constructors can create/migrate stores. Neither is automatically a read-only solution.
- `creds.py` documents the cached token schema and account formatter: default-universe account IDs are plain principal strings; other universes append a suffix. AccessTokenCache.Load reads the account's token and expiry. `config.py` defines access_tokens.db and active_config paths. Only SDK source was inspected; actual user cache/schema/expiry remain UNKNOWN.

The runtime gate remains `SDK_INTERNAL_RETRIES_UNQUALIFIED`. Existing invocation counters cannot bound internal SDK requests. A changed transport/credential contract is a material prerequisite change; it has not been implemented. The proposed next local section is recorded in governance `APP013_P08_NO_RETRY_TRANSPORT_CHANGE_REQUEST_20261101.md`.

## Handoff

Final verification at 2026-11-01 14:26:36 UTC: current test/runtime/21 SDK hashes and changed untracked-file whitespace PASS. Test manifest SHA256 4b9a867633f4c9ecfb467e1b162601c8ae881a3657491dbd79a6300f3e8dd2dc. Actual `access_check.py --check-source` integrity PASS and readiness remains false / SDK_INTERNAL_RETRIES_UNQUALIFIED. Backend `check-governance-baseline.mjs` with resolved governance, architecture check and git diff --check PASS. Governance frozen-baseline-check, docs-consistency-check with resolved backend, all 25 safeguard tests and git diff --check PASS. No browser/application/SQL gate was run or claimed for this diagnostic-only change. Proposed cache tests have not been implemented.

Completed: installed call-chain inspection, reproducible default/control diagnostics, provenance and review. Remaining: owner decision on the concrete contract amendment or administrator-evidence alternative; implementer then proves the selected bounded path. Current access, roles, API availability, billing and full qualification remain UNKNOWN. No external operation/window is prepared. Accepted 1A/1B/2A/2B remain 4/8; R1 newly closed 0/27; 3A open; R10 consumed/no retry. No merge/deployment/provider action/payment/spending. **Explicit change proposal; no deviation implemented.**
