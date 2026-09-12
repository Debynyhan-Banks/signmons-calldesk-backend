# Default-disabled single-address runner

Owner approved one bounded implementation, not execution. GoogleAddressOneShot reuses the existing transport interface; no route, CLI, credential loading, provider configuration or live invocation added.

Explicit trusted internal approval binds project signmons, packet ID, rate version, one request, positive liability at most USD 0.10, and a maximum 15-minute window. The caller must qualify actual rate and authorization; a string is not rate evidence. A private durable local directory is required. Exclusive mode-0600 claim creation, file sync and directory sync precede dispatch. Never remove/release the claim automatically. It contains only operator-generated packet/rate/cost/time metadata, no address or provider output. Failed storage refuses dispatch. Timeout/error/late response retains liability and no retry occurs. All downstream authority stays false.

This is a distinct local operational claim, NOT promotion or reuse of the FIXTURE_ONLY database ledger. Scope is one approved packet on one machine using one stable trusted directory. Choosing another directory/packet, deleting the claim, hostile local filesystem changes or using multiple machines is outside enforcement; operational qualification must prohibit those actions. No aggregate account/tenant budget claim. Do not expose this internal class to untrusted caller-supplied approval/path/transport.

Response bodies are discarded, not returned or logged. OBSERVED only means a timely transport RESPONSE, not valid address/county/retention or job acceptance. Private input collection, exact credential qualification and any permitted transient field-inspection mechanism are still not wired. The runner is not yet an executable owner test.

Review: npm test -- --runInBand google-address-one-shot. Seventeen tests cover default refusal, approval fields, exclusive concurrent/restarted use, pre-dispatch claim, no content leakage, errors, timeout abort, missing storage and backwards clock. No UI or route changed, so browser QA is not applicable.

Next: qualify exact credential and connect this runner to reviewed private input/stable claim-directory handling without a live call. No new evaluator or county dependency. APP-013/2B remains Now; walkthrough 3/8 (37.5%) unchanged; phone test remains closed.

Final validation: 112 suites / 2,135 tests passed; three existing skips. Lint, build/Prisma generation, architecture and whitespace passed. Cross-repository governance consistency and all eight governance regressions passed. Initial new-test lint/format findings were fixed before the final run. No runtime release, provider request or browser acceptance.
