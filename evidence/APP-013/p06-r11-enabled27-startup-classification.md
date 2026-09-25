# APP-013/P06 R11 enabled27 startup diagnostic complete

## Approved execution

Owner approved operation `a087c5c8-8162-4d95-96ef-4739de9e0198` with “i approve” at 2026-09-25T13:43:07.884Z, as verified from this session's user-message record. Exact authorization:13:43:07.884–14:13:07.884Z (9:43:07.884–10:13:07.884 AM Eastern September25). Source: backend4cd5392eef5f5b040578d1579ffa52ee22ced3ce/governance041893dcce07d05d5937d86e35875c8e0a4ac696. Scope was the reviewed one-query startup diagnostic with corrected parent-field projection; no database/runtime/provider/browser action.

Fresh four-file private installation at `/Volumes/Signmons-P06/r11-enabled27-startup-diagnostic-fields-20260925-0943` passed binding/source/filter/authority/window, byte/mode and no-query checks. It reserved once at 2026-09-25T13:45:16.035706Z and returned COMPLETE at 2026-09-25T13:45:17.109276Z. Fourteen records, no page continuation or limit saturation. No retry. Input hashes remain unchanged; no stop.json exists. Raw messages and unrelated JSON were never printed or retained.

## Sanitized historical result

| Classification | Severity | Count | First timestamp UTC | Last timestamp UTC |
| --- | --- | --- | --- | --- |
| CONTROLLED_INTAKE_STARTUP_UNAVAILABLE | DEFAULT | 2 | 2026-09-25T13:00:20.116994Z | 2026-09-25T13:00:20.117029Z |
| BOOTSTRAP_INITIALIZATION_FAILED | DEFAULT | 1 | 2026-09-25T13:00:20.116994Z | 2026-09-25T13:00:20.116994Z |
| UNCLASSIFIED_STARTUP_ERROR | DEFAULT | 1 | 2026-09-25T13:00:20.117032Z | 2026-09-25T13:00:20.117032Z |
| CONTAINER_FAILED_TO_START_OR_LISTEN | ERROR | 1 | 2026-09-25T13:00:31.643278Z | 2026-09-25T13:00:31.643278Z |

Counts are matching log records, not user attempts. The two controlled-startup records do not establish two startup attempts. The single UNCLASSIFIED_STARTUP_ERROR remains unclassified; no underlying message is inferred.

## Source interpretation and limits

Runtime source6d8ba541ca4cab8ef2d905defb1edcc9bacac046 is unchanged in current main/startup/runtime files and their existing test seams. `src/main.ts:24–31` awaits controlled startup and closes the application on failure before `app.listen` at105. The bootstrap handler logs at110. `src/communications/controlled-intake-startup.ts:101–106` discards every underlying cause and throws the generic controlled-startup exception. `controlled-intake-runtime.ts:278–280` also replaces inner errors.

This establishes a controlled-intake startup failure before HTTP listener readiness. It does not identify envelope, injected-material, packaged-asset, runtime-approval/database, current-authority or later construction failure. Missing database-specific classes cannot exclude a database failure because causes are deliberately discarded. No port/timeout, credential, policy or capacity change is justified from these logs. Another read of the same generic errors would not identify the hidden stage.

## Handoff

APP-013/2B P06-R11: diagnostic preparation, one scoped read, sanitized evidence and source trace are complete. Application startup diagnosis and connected browser acceptance remain open. Implementer owns the next bounded local startup-stage observability change; owner decision is in `APP013_P06_R11_STARTUP_STAGE_OBSERVABILITY_CHANGE_REQUEST.md`. No implementation or live execution authority is inferred from this read-only approval.

Runtime access was not reopened; the earlier verified closeout remains the last runtime state evidence. No holds, secrets, IAM, image, deployment, provider or customer action changed. P06 remains12/14; R11/fullR12 open; accepted1A/1B/2A unchanged. No scope deviation.

Final checks: backend governance-baseline/architecture, governance frozen-baseline/docs consistency, all21 governance safeguard tests and both whitespace checks passed. The reviewed private diagnostic self-test and installed no-query checks passed before the one live read. No new application implementation, runtime test or browser acceptance is claimed.
