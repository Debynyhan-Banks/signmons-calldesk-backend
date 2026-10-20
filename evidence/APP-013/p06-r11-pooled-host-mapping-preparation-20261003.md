# APP-013 / 2B / P06-R11 pooled-host mapping preparation — 2026-10-03

## Authority and scope

The owner approved Alternative 1 in governance `APP013_P06_R11_POOLED_HOST_MAPPING_CORRECTION_DECISION_20261003.md`. Plan `78800c38-11fd-4b5b-89a7-865e4a9f7b2c`; proposed operation `e13000fe-7d13-4e9c-9e39-a164873c98ce`.

The successor local helper generates exactly direct and documented `-pooler` candidates for each of the two fixed current endpoint rows and returns only branch ID, endpoint ID and `DIRECT`/`POOLED` mode on a unique match. It remains deliberately non-runnable with a PENDING root, zero inventory hash and 2099 window until the owner provides a fresh 30-minute Eastern window.

Ten focused fictional tests pass, including unique direct/pooled mapping, no-match/ambiguity, endpoint-ID/hostname binding, identity/payload refusal, exact approval/window/inventory/mode guards, stale/duplicate/malformed inventory, redacted consumed failure and concurrent exclusive reservation. Python compilation, architecture, governance and whitespace checks pass. Prepared helper SHA-256 is `271b812d980e00f80937d0a8934b9ade07861ee0a9c410e0948e1bd215fe74b1`.

The consumed installed direct-only package remains untouched and must never be rerun. No Neon/Secret Manager read, database access or external mutation occurred in this preparation. P06 remains 12/14; R11/full R12 remain open; accepted milestones remain 3/8. No scope deviation.

## Installed package and terminal result

The owner supplied October 3, 2026, 7:00–7:30 a.m. Eastern. Fresh authenticated Neon UI readback at 6:55 verified the same one project, two branches and two suspended primary endpoints without opening Connect. Inventory SHA-256 `0d926e6e6123133125f1cb6ca66f48d507ee41a10e0c699b0f9a22bda85983c4`; final helper SHA-256 `0b213174d44bbe1368c1ff2372bfd48e1973f539789b171be2498ad9c52de68a`; approval SHA-256 `5da2aa3f71f4141323b3a3dc339757d2d492fdb023e8c9e72c777be1a00f7ae6`. Installed 0700/0600 package at `/Volumes/Signmons-P06/r11-pooled-host-map-20261003-0700` passed no-action check with no markers before execution.

The single invocation reserved at 7:02:27 a.m. Eastern and completed at 7:02:28 with `R11_POOLED_HOST_MAP_NO_MATCH`. Sanitized readback verifies plan/operation IDs, shared secret version 2, fresh inventory time, endpoint count 2 and terminal `NO_MATCH`; attempt/result records exist, no stop record exists, and package hashes/modes match. Never rerun.

This proves the secret hostname matches neither direct nor pooled canonical hostname for either current endpoint in the only project visible in the authenticated Neon account. It does not reveal or prove the old hostname's project, region, lifecycle or reachability. Shared secret version 2 is therefore unmapped to current Neon inventory and cannot be used as the basis for a credential rotation. No external mutation occurred. A separately reviewed replacement/containment decision is required.
