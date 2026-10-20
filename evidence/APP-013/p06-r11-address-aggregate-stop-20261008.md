# APP-013 / P06-R11 address-aggregate stop — 2026-10-08

Owner approved one replacement qualification for 7:25–8:00 a.m. Eastern. Plan `6c2d3098-0a93-46b2-b71e-d8f39b776167`, operation `11d2f708-7f7e-4b03-81b8-809e5ee4242c`, was installed at `/private/tmp/r11-post-cutover-qualification-20261008-0725-v2`. Its no-action check, syntax, formatting, 11 focused tests and whitespace passed.

The owner invoked it once. Attempt reservation was saved at `2026-10-08T11:25:22.535Z`; the terminal stop at `2026-10-08T11:25:38.289Z` names `ADDRESS_AGGREGATE`. Connection, identity, read-only transaction, read-only-mode validation and phone aggregation had completed. The runner rolled back and closed. No result exists; never rerun it.

The saved stage cannot distinguish address query execution from response parsing. Approval, runtime role/session and Phase B were not read. The result proves neither current address totals nor runtime drift/headroom. No external state changed.

Local source now separates address totals from invalid-row counting and gives query/parse stages for both. Signed invalid totals are classifiable without loss. Fourteen focused tests pass, including full-reader progression and negative-invalid data. Governance `APP013_P06_R11_ADDRESS_AGGREGATE_STOP_DECISION_20261008.md` presents one final fresh qualification or pause. No new operation/package/read is authorized yet.

P06 remains 12/14; R11/full R12 remain open; accepted milestones remain 3/8. No scope deviation.
