# APP-013 / 2B / P06 runtime configuration and ingress

2026-09-14. Approved runtime-wiring card items 1 and 3; source backend e2fa320 / governance 01fd777. No scope deviation. Locally tested implementation only, not live demonstration or package acceptance.

## Changes

- Pure strict runtime envelope parser copies/freezes activation, phone, browser/address policies and numeric same-project secret references. Exact project/service/configuration/revision/origin, finite shared packet window and six explicitly disabled safety flags required. Missing/false leaves runtime absent; malformed enabled input throws sanitized startup error.
- Reuses existing activation and phone-policy validators; no environment reads, secret access, provider clients or activation.
- Process-local opaque managed-HTTPS seal expires with the packet and cannot be reconstructed from JSON. HTTP mount refuses invalid seal or mismatched Host before invoking transport. Existing transport keeps its Origin/Host/header/session checks; forwarded headers do not grant authority. Direct TLS/fixture behavior remains unchanged.
- Main remains unbound. The future reviewed loader must supply authentic server facts and current approval readers; this parser is not deployment approval or proof of actual cloud configuration.

## Validation

- Build and lint passed. Full Jest: 125 suites passed, one skipped; 2,331 tests passed, three skipped.
- Five new configuration/HTTP tests cover missing/unknown/malformed settings, runtime mismatch, all six safety flags, packet/tenant/budget/window/secret-reference mismatch, immutability, seal copying/expiry and actual HTTP ingress qualification/refusal. Existing HTTP tests preserve direct-HTTP refusal and webhook raw bytes.
- Architecture check and Prisma schema validation passed. Both npm audits: zero vulnerabilities.
- Full guarded disposable PostgreSQL/Playwright gate passed, including four-process shared-budget crash/restart proof, phone-liability concurrency/revocation/rollback and existing connected 390/1440 journey cases. Only synthetic provider ports; no live calls. Existing connected browser still pre-provisions phone proof: this is regression evidence, not completed browser START/CHECK evidence.
- Initial checks exposed an Object.hasOwn target-library incompatibility and structuredClone realm-sensitive plain-object validation; corrected using compatible own-property and strict recursive copy. HTTP test uses node:http to explicitly send its synthetic Host (fetch did not preserve it). All gates above rerun after correction.
- Logs: /private/tmp/signmons-p06-runtime-{build,lint,tests,db}.log; browser/database artifacts: /private/tmp/signmons-p06-runtime-evidence. Temporary artifacts are local, not deployment evidence.

## Review and remaining work

Review controlled-intake-runtime-config.ts/spec, customer-session-http.ts and the reused validatedPolicy accessor; verify main still calls customerSessionHttp() without a binding. Run the full commands in APP013_P06_RUNTIME_WIRING_CARD.md. No schema, IAM, secrets, provider configuration, billing, production data, deployment or main merge changed.

Remaining under the same P06 item 2: server composition loader/current readers and actual same-page browser START/CHECK/close-to-job flow. Then separately approved immutable disabled release packet and capped live run/owner closeout. No new package added.

Accepted packages remain 5/60 (8.3%); walkthrough 3/8 (37.5%). P06 not accepted. Provisional estimate remains 4–8 weeks at 25–30 collaborative hours/week plus external waits, low confidence; next timing review after ten accepted packages.
