# APP-013/P06 R11 enabled27 startup stop and verified closeout

Owner reported R10_DATABASE_LOGIN_OPEN, R12_RUNTIME_CLOSEOUT_VERIFIED and R11_ATTENDED_COORDINATOR_CLOSED_CHILD_STOP. Plan `22db1c2a-c9ab-4025-891a-91dc7118e971` is consumed. Source: backend edd2b7a/governance 3865ec2. All private files and markers remain unchanged; no command was rerun.

## Saved sequence, September 25 UTC

| Event | Time/result |
| --- | --- |
| Coordinator reservation | 12:59:54.862Z |
| LOGIN reservation/readback | 13:00:01.522Z / LOGIN_OPEN at 13:00:01.622Z |
| Activation reservation | 13:00:05.157Z |
| Activation/readback | ACTIVE at 13:00:05.790Z; COMPLETE stage; one matching audit |
| Deployment reservation | 13:00:06.072Z |
| Revocation reservation | 13:00:32.223Z |
| Revocation/readback | REVOKED at 13:00:32.522Z; one matching audit |
| Stop record | 13:00:36.748Z; DEPLOY_NO_TRAFFIC; closeout CLOSED; retry prohibited |
| Coordinator closeout | Reserved 13:00:42.681Z; CLOSED with no failures |

No deployment-readback or run-ready result exists. The coordinator never returned a URL or entered the browser stage.

## Target and startup evidence

Approved read-only target/closeout readback shows desired/latest created enabled27, latest Ready enabled25, normal traffic 100% on app013bounds, and no enabled tag. The exact b241 image imported at 13:00:09.184Z. ContainerHealthy became False with HealthCheckContainerError at 13:00:31.644784Z: the container failed to start/listen on port 8080. The revision was retired during cleanup; Ready=True with reason Retired does not establish successful startup.

Existing local CLI log `09.00.06.339986.log` independently yielded only CONTAINER_FAILED_TO_START_AND_LISTEN at 09:00:31.959–32.059 Eastern. No raw logs, environment values, HMACs or participant input were copied. The approximately 26-second failure was not the configured 180-second deployment timeout or 300-second coordinator child timeout.

Further approved metadata readback at 13:05:04.457Z returned IMAGE_ENVELOPE_SECRET_REFERENCES_FLAGS_AND_PURE_CONFIG_MATCH. The image, runtime envelope, database secret reference version2, controlled material reference version1 and disabled flags match the packet. The existing compiled pure parser accepts the envelope at 13:00:20Z using reviewed facts. This cannot establish injected secret contents or live database startup authorization. The startup cause remains unresolved. No Cloud Logging query, new database connection, provider request, credential read, repair, build or deployment retry occurred during investigation.

## Closeout and next gate

Source review confirms cleanup revokes the exact matching approval, removes the enabled tag, sets only the runtime role to NOLOGIN/limit0/past expiry, and terminates that role's sessions. The final predicate verifies inactive approvals, tag absent, LOGIN false, limit0, sessions0 and baseline100%. Saved CLOSED/no failures and REVOKED/one audit confirm these guarded checks. Past expiry was set by successful cleanup SQL but is not separately compared by the final predicate. The failed revision remains retired, not deleted. No post-run hold count query or full R12 acceptance is claimed.

`APP013_P06_R11_ENABLED27_STARTUP_DIAGNOSTIC.md` proposes one read-only startup-log query for exact enabled27 and historical 13:00:06–13:00:32.999999Z, retaining only allowlisted failure classes, timestamps and counts. Operation `6b086d07-9dee-422f-8c77-3492b8f63acc` requires separate owner approval and must execute before 9:30 AM Eastern. No password, browser action or new live packet. Implementer diagnoses; owner approves the new scope. P06 remains12/14; R11/full R12 open; accepted1A/1B/2A unchanged. No scope deviation.

Documentation-only checks passed: backend/governance baselines, full consistency,21 governance tests, architecture and both whitespace checks. No application/runtime tests are claimed as newly executed.
