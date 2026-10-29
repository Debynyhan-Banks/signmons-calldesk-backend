# P08 composed authentication local preparation

Owner approved governance commit `8082d44` after reviewing proposal commit `d7f0ed2` and proposal SHA256 `5009670c7a7bb3284a8c2a99c79eeebf1381fb131f874cc3271aa5564aa9c43f`.

This directory contains a disabled local composition model only. `source/composed_auth.py` has no credential resolver or live provider transport and returns `P08_COMPOSED_AUTH_REFUSED_UNBOUND` from its native entry. It verifies the locked restoration, access-resolution and authentication sources; models one exact parent authority, provider-owned dynamic key receipt, strict child derivation, exact role/key request contracts, ordered authentication and reverse cleanup. Tests use synthetic identities, an injected fake adapter and local private files only.

No provider, database, Firebase, IAM, API-key, runtime, Stripe, payment, deployment or billing action is authorized or performed. Local success is not P08 or 3A acceptance.

Final local verification: 17 composed tests, 31 unchanged restoration tests, 40 unchanged access-resolution tests and 60 unchanged authentication tests passed. The authentication test's use of URL pathname text cannot resolve a checkout path containing spaces, so the exact locked snapshot was run from `/private/tmp/p08-auth-reuse-8082d44/source`; no source was changed. `local-result.json` records the initial failures, corrections, limitations and zero-action boundaries.

The composition review corrected two meaningful safety gaps before any live work: key deletion now requires acknowledged exact ownership, and the wrapper binds the provider's canonical numeric project resource instead of inventing the older project-alias form. Locked sources remain byte-for-byte unchanged. Native launch remains disabled and unbound.
