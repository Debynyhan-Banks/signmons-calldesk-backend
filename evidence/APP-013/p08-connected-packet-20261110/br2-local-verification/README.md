# BR2 local verification

Section APP-013 / 3A / P08. Authority: governance initial approval 8c56d0f and budget-amendment approval 3779a95, proposals fb8bdc5 and 2bf3d77. Baseline backend fabd4561a2a25f4618aa7d2395fbba1eff1c3795. This evidence is synthetic local proof, not provider qualification or payment acceptance.

The connected coordinator now permits at most three observations after a successfully acknowledged exact identity enable/disable. Additional observations require a strict eligible state mismatch or missing disabled field; transport errors and foreign/malformed responses stop immediately. Delays are 5 then 10 seconds, within 45 seconds per transition and existing phase deadlines. Every read uses existing accounting. There is no mutation or transport retry and no restart-based renewal of the allowance.

The prospective CLI limit is exactly 196; the other limits remain HTTPS 100, SQL 60, child 6 and childRequests 200. The assembled immediate/one-extra-per-phase/two-extra-per-phase cases close with 191/193/195 CLI calls, respectively, one enable and one disable each. The old 192 budget test stops at its cap and retains the unresolved cleanup flag. This demonstrates accounting rather than bypassing it. Existing 420/960-second work reserves, 660-second cleanup and 120-second purge reserves remain; initial version2 admission includes 45 additional seconds.

At most six fixed safe decoded-output observations join the existing journal, without raw response values or new diagnostic writes. The marker is process-local and consumed once. Optional observation failure cannot suppress cleanup. Final retirement and independent old-transition verification remain single reads.

## Selected checks

Pinned interpreter: /opt/homebrew/Cellar/python@3.14/3.14.2/Frameworks/Python.framework/Versions/3.14/bin/python3.14, flags -I -B. Insert the stated module directory into sys.path and use unittest.defaultTestLoader.loadTestsFromNames with TextTestRunner; exit nonzero unless wasSuccessful().

- Native directory: evidence/APP-013/p08-native-entry-local-20261101/source. Full module test_entry; see native.txt.
- Connected directory: evidence/APP-013/p08-connected-packet-20261110. Explicit modules test_packet, test_launcher, test_bootstrap_open, test_attended_approval, test_approval_wait; see connected.txt. The intentional nonrepository negative case prints a git error while its test passes.
- Focused new and existing identity classes: ConnectedIdentityReconciliationTests and IdentityReadbackDiagnosticTests, 25 passed before the full run.
- Current model.verify_local_manifest(), model.verify_locked_sources(), authority.verify_sources(); committed qualification-source and renewal-tree checks are recorded in the governance completion after committing source.
- Backend governance wrapper, architecture, governance frozen baseline/complete consistency, 25 governance regression tests and both whitespace checks.

Only explicit synthetic/process suites were selected. Local loopback fixture permission was required for the simulated child payment bridge. No PostgreSQL fixtures, actual provider calls, credential reads, sign-in, browser opening or payment occurred. The first full native run exposed missing version/transition fields in older manually constructed timing test controllers; only the fixture initialization was completed, preserving those original timing assertions. The final log supersedes that failed intermediate run.

Historical R64 receipts remain unchanged (12 hashes reverified). Provider cause, current state/access and future convergence remain UNKNOWN. Rollback is the four changed sources plus eight derived manifests together to baseline; no running operation exists to roll back. All old consumed packets remain immutable and cannot authorize the changed source/cap. No scope deviation beyond the explicitly approved BR2 integration and budget amendment. Accepted milestones remain 4/8; 3A OPEN; R1 newly closed 0/27.
