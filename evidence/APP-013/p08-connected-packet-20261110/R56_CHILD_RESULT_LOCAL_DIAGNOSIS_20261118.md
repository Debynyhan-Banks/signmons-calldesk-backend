# R56 child-result local diagnosis

Status: **complete local diagnosis; no correction or live authority**.

## Bound scope

- Active acceptance section: APP-013 3A, Sandbox payment on the admitted job.
- R56 execution source: `ce9bccfd71a989b20a0323e0d047dbd81332a59e`.
- Inspected checkpoint: `a72c5a6c4681dc65468aed98359cd886f9d030fb`.
- Directed work: trace the local child-result handoff and exact failure after R56. No replay, provider read, credential action, payment attempt or code correction was authorized.
- Connected-workflow effect: diagnosis only. Accepted remains 4/8; the same-job authentication, Sandbox payment, authentic event and gate evidence remain incomplete.

## Objective evidence

| Artifact | SHA-256 | Relevant observation |
| --- | --- | --- |
| `r56-stop-20261117/journal.json` | `b4fda98764fa570eb46e76fd917777ea1dce4a737745108b4e964f8394a0438d` | The child journal was accepted and closed with `authStage=EXCHANGE`, `failureCategory=RESPONSE_VALIDATION`, `httpStatus=null`, `failureCode=SIGN_EXCHANGE_REFUSED`, `authenticated=false`, `sessionClosed=true`, and no child residuals. |
| `r56-stop-20261117/result.json` | `54dbc72a0e634674c9666e50b440a1efd3aae5f4103291dcdf90878c954b9e01` | Parent result remains `ENTRY_CONTAINMENT_UNCONFIRMED`, `childResultSha256=null`, and sole residual `AUTH_OUTCOME_UNKNOWN`. |
| `p08-native-entry-local-20261101/source/handoff.py` | `7e90e1a8b801412de66f8fc27d04ee3e48a2b81cd0f3011d36f14ccce1b2ca19` | The bounded child result and journal are validated, then the success-only predicate rejects any stopped result before returning to the parent. |
| `p08-live-binder-local-20261029/source/coordinator.py` | source-pinned by the R56 manifest | `childResultSha256` is recorded only after `authenticate()` returns a proof; an exception before return leaves it null and is conservatively classified as `LOCAL_ADAPTER_OR_SOURCE_STOP` unless it is the coordinator's exact `Stop` type. |
| `p08-coordinator-auth-local-20261031/source/client.mjs` | `4dd54eb7caaea2d334c3a4c82ef49a6d914dc0feb58a7e089a280656f53d4dec` | At `EXCHANGE`, `RESPONSE_VALIDATION` with no HTTP status means the HTTP transport was not classified as refused, but the response body, parsed provider envelope, post-response gate, or exact local ID/token predicate did not validate. The current safe schema intentionally does not retain which predicate failed. |

All six R56 child calls returned and all six journal merges were accepted. The safe child result is therefore not absent from the operation history: the `authClient` journal and parent-owned child observations preserve it. `childResultSha256` is specifically the returned authentication-proof digest, not a digest of every stopped child output.

The observed stopped-and-closed result does not prove that Identity Toolkit created no authentication event before response validation failed. Cleanup proves the account/session was closed and current containment was restored; it does not retrospectively prove the external authentication outcome. Clearing `AUTH_OUTCOME_UNKNOWN` or populating the proof digest from this result would weaken the evidence contract. No code defect or safe residual removal is demonstrated by the current evidence.

## Fresh local validation

- `node --test test_client.mjs`: 22/22 passed, including SIGN, KEY_READ and EXCHANGE across TRANSPORT, HTTP and RESPONSE_VALIDATION; cleanup and no-retry assertions passed.
- `python3.14 -B -m unittest test_entry.JournalContractIntegrationTests`: 9/9 passed; accepted child-journal merge, conservative unknown outcome and independent cleanup remain reproducible.
- `python3.14 -B -m unittest test_bound`: 17/17 passed.
- `npm run arch:check`: passed.
- Governance frozen baseline, cross-repository consistency and 25 governance tests passed before this documentation change.

These tests use injected local transports and synthetic data. They made zero credential, cache, provider, database, browser or payment calls.

## Smallest next decision

The remaining local fact is the exact response-validation predicate. `APP013_P08_RV1_RESPONSE_VALIDATION_OBSERVABILITY_PROPOSAL_20261118.md` proposes a bounded, local-only safe-code addition that would distinguish the allowlisted predicate without retaining a body, token, key, URL or exception text. It is not approved or implemented. Even if approved, it would improve a future separately authorized attempt only; it cannot resolve R56 retrospectively and would not authorize replay.

No scope deviation.
