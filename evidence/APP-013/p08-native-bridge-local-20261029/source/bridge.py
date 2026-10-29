"""Disabled P08 bridge over the existing serialized CLI/HTTPS contracts.

All transports and lifecycle closeouts are injected. No credential resolver,
network client, database client, or live command launcher exists in this file.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import importlib.util
import json
import re
import types
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PACKET_PATH = ROOT.parent.parent / "p08-integrated-local-packet-20261029/source/packet.py"
PACKET_HASH = "ce507681ef2d1a3ce8a2315921b067ba5dfe677165b1c7adbc4c1e37ba4075e3"


def verify_bundle():
    manifest_path = ROOT / "source-manifest.json"
    if not manifest_path.is_file() or manifest_path.is_symlink():
        raise RuntimeError("BRIDGE_MANIFEST_ABSENT")
    manifest = json.loads(manifest_path.read_text())
    if manifest.get("status") != "DISABLED_LOCAL_ONLY" or manifest.get("packetSha256") != PACKET_HASH:
        raise RuntimeError("BRIDGE_MANIFEST_DRIFT")
    expected = {"bridge.py", "test_bridge.py", "auth-authority-owned.mjs",
                "owned-key-authority.mjs", "owned-key-authority.test.mjs"}
    if set(manifest.get("files", {})) != expected:
        raise RuntimeError("BRIDGE_MANIFEST_FILES")
    for name, digest in manifest["files"].items():
        path = ROOT / name
        if not path.is_file() or path.is_symlink() or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise RuntimeError("BRIDGE_SOURCE_DRIFT")
    for relative, digest in manifest.get("lockedExternal", {}).items():
        if relative not in (
            "../../p08-authentication-local-20261026/source/reuse/operator-bridge.mjs",
            "../../p08-authentication-local-20261026/source/reuse/plan.json",
            "../../p08-authentication-local-20261026/source/auth-authority.mjs",
        ):
            raise RuntimeError("BRIDGE_EXTERNAL_SCOPE")
        path = ROOT / relative
        if not path.is_file() or path.is_symlink() or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise RuntimeError("BRIDGE_EXTERNAL_DRIFT")
    if len(manifest.get("lockedExternal", {})) != 3:
        raise RuntimeError("BRIDGE_EXTERNAL_FILES")
    return True


def load_packet():
    if not PACKET_PATH.is_file() or PACKET_PATH.is_symlink() or hashlib.sha256(PACKET_PATH.read_bytes()).hexdigest() != PACKET_HASH:
        raise RuntimeError("PACKET_SOURCE_DRIFT")
    spec = importlib.util.spec_from_file_location("p08_bridge_packet", PACKET_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.verify_sources()
    return module


packet = load_packet()


def need(value, code):
    if not value:
        raise packet.Stop(code)


def decoded(value):
    need(isinstance(value, str) and len(value.encode()) <= 65536, "CLI_OUTPUT_SHAPE")
    try:
        return json.loads(value)
    except (ValueError, TypeError):
        raise packet.Stop("CLI_OUTPUT_SHAPE") from None


class Ports:
    """A caller-supplied transport must produce serialized, bounded responses."""
    def __init__(self, plan, cli, https, auth, account_closeout, runtime_closeout, clock):
        need(all(callable(x) for x in (cli, https, auth, account_closeout, runtime_closeout, clock)), "TRANSPORT_UNBOUND")
        need(plan.get("mode") == "LOCAL_INTEGRATED_PACKET_ONLY" and plan.get("externalActionAuthorized") is False,
             "LIVE_REFUSED")
        number = plan.get("projectNumber")
        need(isinstance(number, str) and re.fullmatch(r"[0-9]{6,20}", number), "PROJECT_NUMBER")
        need(plan.get("projectNumberSha256") == hashlib.sha256(number.encode()).hexdigest(), "PROJECT_NUMBER_BINDING")
        self.plan, self.cli, self.https, self.auth = plan, cli, https, auth
        self._account_readback, self._runtime_readback, self.clock = account_closeout, runtime_closeout, clock
        self.roles, self.restore, self.stage, self.key = (packet.module(n) for n in ("roles", "restore", "stage_a", "key"))
        self.key_adapter = self.key.RequestAdapter(plan, transport=https)
        self.stage_adapter = self.stage.RequestAdapter(plan, transport=https)
        self.key_service = f"projects/{number}/services/apikeys.googleapis.com"
        self.key_resource = f"projects/{number}/locations/global/keys/{plan['keyId']}"
        need(self.key_adapter.key == self.key_resource, "KEY_RESOURCE_SCOPE")
        self.iam = []
        for role in self.roles.ROLES:
            kind = role["kind"]
            self.iam.append({"kind": kind, "roleId": role["name"], "permissions": [role["permission"]],
                             "preexisting": True,
                             "condition": f"expression=request.time >= timestamp('{plan['window']['start']}') && request.time < timestamp('{plan['window']['workEnd']}'),title=p08_{plan['operationId']}_{kind}"})
        self.restore_plan = {**plan, "iam": self.iam}
        self.owned_uid = None
        self.owned_etag = None

    def cloud(self, vector):
        need(isinstance(vector, list) and all(isinstance(x, str) for x in vector), "CLI_VECTOR")
        return decoded(self.cli(vector))

    def policy(self, kind):
        if kind == "lookup":
            raw = self.cloud(["projects", "get-iam-policy", "signmons", "--format=json"])
            member = "serviceAccount:" + packet.IDENTITY
        elif kind == "signing":
            raw = self.cloud(["iam", "service-accounts", "get-iam-policy", packet.IDENTITY,
                              "--project=signmons", "--format=json"])
            member = "user:" + packet.OWNER
        else:
            raise packet.Stop("IAM_KIND")
        need(self.roles.policy_shape(raw) != "INVALID", "POLICY_SHAPE")
        bindings = [] if raw is None else raw.get("bindings") or []
        role = next(x for x in self.iam if x["kind"] == kind)
        matching = [b for b in bindings if b.get("role") == role["roleId"]]
        if not matching:
            return "ABSENT"
        need(len(matching) == 1 and matching[0].get("members") == [member], "POLICY_OWNERSHIP")
        condition = {"expression": role["condition"].split(",title=")[0].removeprefix("expression="),
                     "title": role["condition"].split(",title=")[1]}
        need(matching[0].get("condition") == condition, "POLICY_CONDITION")
        return "OWNED"

    def preflight(self):
        project = self.cloud(["projects", "describe", "signmons", "--format=json(projectId,projectNumber,lifecycleState)"])
        need(isinstance(project, dict) and project.get("projectId") == "signmons" and
             project.get("projectNumber") == self.plan["projectNumber"] and
             project.get("lifecycleState") == "ACTIVE", "PROJECT_DRIFT")
        roles = []
        for role in self.roles.ROLES:
            value = self.cloud(["iam", "roles", "describe", role["id"], "--project=signmons",
                                "--format=json(name,title,description,includedPermissions,stage,deleted,etag)"])
            roles.append(value)
        need(all(self.policy(kind) == "ABSENT" for kind in ("lookup", "signing")), "BINDING_PRESENT")
        service = self.key_service_get()
        need(service.get("name") == self.key_service and service.get("state") in ("ENABLED", "DISABLED"),
             "SERVICE_SHAPE")
        return {"roles": roles, "bindingsAbsent": True, "apiKeysService": service["state"]}

    def bind(self, kind, name):
        role = next((x for x in self.iam if x["kind"] == kind), None)
        need(role is not None and role["roleId"] == name, "IAM_ROLE_SCOPE")
        self.cloud(self.restore.command(self.restore_plan, "iam", kind, True))
        return True

    def binding_state(self, kind):
        return self.policy(kind)

    def unbind(self, kind):
        need(kind in ("lookup", "signing"), "IAM_KIND")
        self.cloud(self.restore.command(self.restore_plan, "iam", kind, False))
        return True

    def stage_a(self, tuples):
        need(tuples == [list(x) for x in self.stage.TUPLES], "DIAGNOSTIC_SCOPE")
        when = dt.datetime.fromtimestamp(self.clock(), dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        out = []
        for principal, resource, permission in tuples:
            result = self.stage_adapter.diagnostic(principal, resource, permission, when)
            state = result.get("overallAccessState")
            need(state in self.stage.STATES, "DIAGNOSTIC_SHAPE")
            out.append(state)
        return out

    def operation(self, initial, kind):
        need(isinstance(initial, dict) and re.fullmatch(r"operations/[A-Za-z0-9_.-]{1,200}", initial.get("name", "")),
             "OPERATION_SCOPE")
        name = initial["name"]
        value = initial
        for _ in range(6):
            need(isinstance(value, dict) and value.get("name") == name and type(value.get("done")) is bool and
                 "error" not in value, "OPERATION_SHAPE")
            if value["done"]:
                need(isinstance(value.get("response"), dict), "OPERATION_RESPONSE")
                return value["response"]
            value = self.key_adapter.operation(name, kind)
        raise packet.Stop("OPERATION_POLL_LIMIT")

    def key_service_get(self):
        return self.key_adapter.call("GET", "https://serviceusage.googleapis.com/v1/" + self.key_service)

    def enable_api_keys(self):
        initial = self.key_adapter.call("POST", "https://serviceusage.googleapis.com/v1/" + self.key_service + ":enable", {})
        response = self.operation(initial, "service")
        need(response.get("service", {}).get("name") == self.key_service and
             response["service"].get("state") == "ENABLED", "SERVICE_ENABLE_RESPONSE")
        return True

    def api_keys_state(self):
        value = self.key_service_get()
        need(value.get("name") == self.key_service and value.get("state") in ("ENABLED", "DISABLED"),
             "SERVICE_SHAPE")
        return value["state"]

    def normalized_key(self, value):
        need(isinstance(value, dict), "KEY_SHAPE")
        probe = types.SimpleNamespace(a=types.SimpleNamespace(key=self.key_resource), p=self.plan)
        self.key.Controller.key_metadata(probe, value, bool(value.get("deleteTime")))
        normalized = {"name": value["name"], "uid": value["uid"], "etag": value["etag"],
                      "displayName": value["displayName"], "restrictions": value["restrictions"],
                      "deleted": bool(value.get("deleteTime"))}
        return normalized

    def key_get(self):
        value = self.key_adapter.key_get()
        return "NOT_FOUND" if value == {"status": "NOT_FOUND"} else self.normalized_key(value)

    def key_create(self, resource, restrictions):
        need(resource == self.key_resource and restrictions == self.key.RESTRICTIONS, "KEY_CREATE_SCOPE")
        value = self.operation(self.key_adapter.key_create(), "key")
        result = self.normalized_key(value)
        need(result["deleted"] is False, "KEY_DELETED")
        self.owned_uid, self.owned_etag = result["uid"], result["etag"]
        return result

    def key_delete(self, etag):
        need(self.owned_uid and etag == self.owned_etag, "KEY_DELETE_OWNERSHIP")
        self.operation(self.key_adapter.key_delete(etag), "key")
        return True

    def authenticate(self, resource):
        need(resource == self.key_resource and self.owned_uid and self.owned_etag, "AUTH_KEY_SCOPE")
        current = self.key_get()
        need(isinstance(current, dict) and current["uid"] == self.owned_uid and
             current["etag"] == self.owned_etag and current["deleted"] is False,
             "AUTH_KEY_OWNERSHIP_DRIFT")
        value = self.key_adapter.call("GET", "https://apikeys.googleapis.com/v2/" + resource + "/keyString")
        need(set(value) == {"keyString"} and isinstance(value["keyString"], str) and value["keyString"], "KEY_STRING_SHAPE")
        key_hash = hashlib.sha256(value["keyString"].encode()).hexdigest()
        value = None
        receipt = {"operationId": self.plan["operationId"], "keyResource": resource,
                   "uid": self.owned_uid, "etag": self.owned_etag,
                   "displayName": "Signmons P08 " + self.plan["operationId"],
                   "restrictions": self.key.RESTRICTIONS, "keyStringSha256": key_hash,
                   "createdInOperation": True, "deleted": False,
                   "ownedAt": dt.datetime.fromtimestamp(self.clock(), dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
        return self.auth(receipt)

    def account_closeout(self):
        state = self._account_readback()
        need(state == {"appDisabled": True, "firebaseDisabled": True, "tokensRevoked": True,
                       "sessionsAbsent": True}, "ACCOUNT_CLOSEOUT_READBACK")
        return True

    def runtime_closeout(self):
        state = self._runtime_readback()
        need(state == {"retired": True, "normalTraffic100": True,
                       "sessionsAbsent": True, "privatePlansAbsent": True}, "RUNTIME_CLOSEOUT_READBACK")
        return True


class BoundPacket(packet.Packet):
    def __init__(self, plan, ports, directory, clock):
        verify_bundle()
        need(plan.get("projectNumber") == ports.plan.get("projectNumber") and
             plan.get("operationId") == ports.plan.get("operationId"), "PLAN_PORT_DRIFT")
        super().__init__(plan, ports, directory, clock=clock)
        self.key = types.SimpleNamespace(KEY_PREFIX=f"projects/{plan['projectNumber']}/locations/global/keys/",
                                         RESTRICTIONS=ports.key.RESTRICTIONS)


def native():
    print("P08_NATIVE_BRIDGE_REFUSED_UNBOUND")
    return 2


if __name__ == "__main__":
    raise SystemExit(native())
