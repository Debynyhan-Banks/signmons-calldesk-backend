"""Disabled closeout-only seam for the source-locked P08 packet.

This module has no credential resolver or native transport. It reuses the
historical packet's closeout implementation after validating a cleanup-only
window; it never enters the work path or repeats a mutation automatically.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import stat
import types
from pathlib import Path

HERE = Path(__file__).resolve().parent
EVIDENCE = HERE.parent.parent
BRIDGE = EVIDENCE / "p08-native-bridge-local-20261029/source/bridge.py"
BRIDGE_SHA256 = "58835555ea5d062bd84af91ace67c71762b9332a2f6fd9bf31ecec08c7a7dfce"


def _load_bridge():
    if not BRIDGE.is_file() or BRIDGE.is_symlink() or hashlib.sha256(BRIDGE.read_bytes()).hexdigest() != BRIDGE_SHA256:
        raise RuntimeError("BRIDGE_SOURCE_DRIFT")
    spec = importlib.util.spec_from_file_location("p08_closeout_bridge", BRIDGE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.verify_bundle()
    return module


bridge = _load_bridge()
packet = bridge.packet


def verify_bundle():
    path = HERE / "source-manifest.json"
    if not path.is_file() or path.is_symlink():
        raise RuntimeError("CLOSEOUT_MANIFEST_ABSENT")
    manifest = json.loads(path.read_text())
    if manifest.get("status") != "DISABLED_LOCAL_ONLY" or manifest.get("bridgeSha256") != BRIDGE_SHA256:
        raise RuntimeError("CLOSEOUT_MANIFEST_DRIFT")
    if set(manifest.get("files", {})) != {"closeout.py", "test_closeout.py"}:
        raise RuntimeError("CLOSEOUT_MANIFEST_FILES")
    for name, expected in manifest["files"].items():
        file = HERE / name
        if not file.is_file() or file.is_symlink() or hashlib.sha256(file.read_bytes()).hexdigest() != expected:
            raise RuntimeError("CLOSEOUT_SOURCE_DRIFT")
    return True


def closeout_only(plan, ports, directory, clock):
    """One independent cleanup attempt against the exact prior journal.

    Caller supplies only local injected ports. This cannot create a key,
    enable a service, or authenticate. Existing journal ownership and one-use
    reservation are enforced by Packet.closeout(independent=True).
    """
    verify_bundle()
    packet.verify_sources()
    packet.need(plan.get("operationId") == ports.plan.get("operationId") and
                plan.get("projectNumber") == ports.plan.get("projectNumber"), "PLAN_PORT_DRIFT")
    start = packet.timestamp(plan.get("window", {}).get("start"))
    times = packet.authorize(plan, start)
    now = clock()
    packet.need(start <= now < times["cleanupEnd"], "CLOSEOUT_CUTOFF")
    path = Path(directory)
    packet.need(path.is_dir() and not path.is_symlink() and stat.S_IMODE(path.stat().st_mode) == 0o700,
                "PRIVATE_DIRECTORY")
    journal = path / "journal.json"
    packet.need(journal.is_file() and not journal.is_symlink() and
                stat.S_IMODE(journal.stat().st_mode) == 0o600, "PRIVATE_JOURNAL")
    obj = object.__new__(bridge.BoundPacket)
    obj.roles, obj.restore, obj.stage_a, obj.key = packet.verify_sources()
    obj.plan, obj.ports, obj.directory, obj.clock = plan, ports, path, clock
    obj.times, obj.last, obj.abort = times, now, False
    obj.key = types.SimpleNamespace(KEY_PREFIX=f"projects/{plan['projectNumber']}/locations/global/keys/",
                                    RESTRICTIONS=ports.key.RESTRICTIONS)
    return obj.closeout(independent=True)


def native():
    print("P08_CLOSEOUT_REFUSED_UNBOUND")
    return 2


if __name__ == "__main__":
    raise SystemExit(native())
