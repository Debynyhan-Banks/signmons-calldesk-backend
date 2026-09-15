# R02 private administrator procedure — documentation only

Owner explicitly approved PREPARING the alternative password-setting procedure, not retrieving a credential or executing it. Entry backend42f0af9/governance25538b0; both focused remotes refreshed and clean. Backend PR21 open at42f0af97e920d29841f911f17b164248e825e0fc. Saved unrelated checkout changes preserved.

Canonical proposal: governance APP013_P06_R02_PRIVATE_ADMIN_PROCEDURE.md. Inspected existing private TTY capture (which currently persists only a runner passfile), fixed one-shot executor and live handoff-stop evidence. The old helper must NOT be given the administrator password unchanged. No application/data contract or runtime file changed.

Proposed exception: owner privately supplies existing administrator credential only to a fixed child-bound local process, memory only; one existing runner password assignment while NOLOGIN, no inherited password reset/parent connection. That inherited credential itself is not child-scoped. Generated runner secret alone goes to private encrypted passfile; executor never receives admin material. New fixed v2 directory proposed to preserve cancelled v1 evidence, not yet implemented/created. Proposal includes bounded input/connection/total window, logging and privilege qualification, uncertain-commit no-retry, cleanup and unchanged7day retention.

Official Neon role docs support SQL passwords and restricted SQL-created roles but say pre-hashed input is unsupported. PostgreSQL18 psql password command encrypts client-side; ordinary ALTER ROLE can expose plaintext in client/server logging. Thus neither Console reset nor psql password is assumed a working private route. Source links and exact qualifications are in the proposal. Actual Console nonvisibility cause remains unproven; no further live browser/SQL/account action this turn. Logging/provider behavior is explicitly unresolved, not zero-log proof.

Finite local adapter/transport/refusal/recovery/executor-binding tests proposed inside existing R02 area1. Helper implementation is not claimed. Next owner review is for local implementation/qualification only; fresh explicit live authority follows actual results. No new R02 acceptance area or repeated independent backup rehearsal.

Documentation validation: pre/post frozen/full consistency, cross-repository check,21governance regressions, architecture and whitespace. No new application lint/build/Jest, live credential or backup result claimed. Procedure preparation complete; recovery/access acceptance incomplete.

No scope deviation implemented; credential-mechanism exception proposed only. R01closed,R02-R12open11,added0; accepted5/60(8.3%)packages and3/8(37.5%)walkthrough unchanged; not whole-MVP percent. ETAunvalidated.
