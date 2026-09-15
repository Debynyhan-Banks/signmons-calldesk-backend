# R02 ownership-enabled mounted private-input proof — 2026-09-15

Entry e097f5a/backend and9f84205/governance; focused remotes fetched and clean. Owner expressly approved administrator authorization targeting only UUID A0020084-32EC-412A-B96B-1AA68A2CE61F, completed macOS prompt, and proceeded with qualification. No password was read/captured. Initial unprivileged enableOwnership refused; approved administrator command succeeded, fresh diskutil readback Owners Enabled.

## Actual result

- Exact image: /Users/debynyhanbanks/Library/Application Support/Signmons/P06/signmons-p06.dmg.sparsebundle; hdiutil image-encrypted TRUE. Mounted at /Volumes/Signmons-P06, expected UUID and GlobalPermissionsEnabled true independently asserted from diskutil plist. Free container space1,915,957,248bytes at ownership readback. Outer image encryption, not APFS FileVault; do not misreport APFS Encryption false as unencrypted outer storage.
- Time Machine exclusion remained Excluded for this exact image. No new backup policy change or historical-copy search/deletion.
- Reused scripts/test_p06_private_input.py unchanged; an in-memory unittest subclass changed only setUp to use TemporaryDirectory under the verified mounted volume. Current UID and0700 test directory asserted. All4 tests passed in0.389s: hidden/escaped0600 passfile, cancel/EOF/empty/invalid/oversize/timeout/SIGTERM cleanup, existing-file/symlink preservation, insecure-parent and nonterminal refusal. Dummy values only; no real credential generated or read.
- All generated test directories removed by test teardown; before/after directory-entry sets equal. Existing qualification-rE6P5X and synthetic-storage-check.txt preserved.
- hdiutil detached exact image device disk4 successfully; /Volumes/Signmons-P06 absent and hdiutil info shows no attached image. Image locked again. No new remount or unlock test claimed.

## Meaning and limits

This closes current ownership-enabled mounted input/directory qualification. It does not prove another-user attack resistance, administrator protection, independent password/key custody or absence of other backup copies. Root mount directory remains0755; only test directories0700 and passfiles0600 were used. Future exact run directory must be exclusively created and rechecked at actual execution; ownership must be re-read after mounting.

No Neon connection, role/password/grant, actual handoff, real data export, cloud deployment, migration or charge. No runtime code edited. Next existing gate: bind the tested components to the exact real-run invocation/window/cleanup packet and request specific new-role/private handoff/backup authority. Never invoke the fixture-creating migration harness against Neon. Do not repeat this completed storage test absent drift.

Validation: four mounted-volume tests plus documentation/architecture/baseline/consistency/21 governance regressions and whitespace checks. No lint/build/browser or app test rerun claimed for unchanged runtime.

R02 remains open; R01 closed,R02-R12 open11,added0; accepted5/60 packages,3/8 walkthrough unchanged; ETA unvalidated. No scope deviation. Review this evidence and governance APP013_P06_R02_MOUNT_CHECK.md; accepting local qualification is not permission to create credentials or export data.
