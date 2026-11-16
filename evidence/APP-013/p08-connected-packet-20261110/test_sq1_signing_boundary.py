"""SQ1 contract tests: synthetic credentials and injected/local transports only.

Provider/cache/authority adapters are synthetic. Process tests use native owned
subprocess supervision and the inert SDK watchdog without consulting SDK stores.
"""
import copy
import base64
import datetime
import hashlib
import http.server
import io
import json
import os
from pathlib import Path
import selectors
import signal
import shutil
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from urllib.parse import urlsplit, parse_qs
import uuid
from types import SimpleNamespace
from unittest.mock import patch

import sq1_signing_boundary as s


NUMBER = "123456789012"
UID = "123456789012345678901"
CONFIG = "a" * 64
TOKEN = "PRIVATE_TOKEN_SENTINEL_" * 3
PRIVATE = "PRIVATE_RESPONSE_SENTINEL"
SIGNATURE = "U1lOVEhFVElDX1NJR05BVFVSRV9TRU5USU5FTA=="
ERROR_TYPE = "type.googleapis.com/google.rpc.ErrorInfo"


def wire(value):
    return json.dumps(value, separators=(",", ":")).encode()


def denial(reason="IAM_PERMISSION_DENIED", domain="iam.googleapis.com", **extra):
    return {"error": {"code": 403, "status": "PERMISSION_DENIED",
                      "message": PRIVATE,
                      "details": [{"@type": ERROR_TYPE, "reason": reason,
                                   "domain": domain,
                                   "metadata": {"permission": "iam.serviceAccounts.signBlob",
                                                "service": "iamcredentials.googleapis.com",
                                                "private": PRIVATE}, **extra}]}}


def scope(now):
    def iso(delta):
        return datetime.datetime.fromtimestamp(now + delta, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {"version": 1, "action": s.ACTION, "operationId": str(uuid.uuid4()),
            "sourceCommit": "b" * 40, "manifestSha256": "c" * 64,
            "iq1ManifestSha256": "d" * 64, "configSha256": CONFIG,
            "uidSha256": hashlib.sha256(UID.encode()).hexdigest(),
            "projectNumberSha256": s.m.digest(NUMBER),
            "window": {k: iso(v) for k, v in (("start", -1), ("cutoff", 60),
                        ("workEnd", 420), ("cleanupEnd", 1100), ("purgeEnd", 1230))},
            "limits": dict(s.LIMITS), "sdkException": s.SDK_EXCEPTION,
            "commands": s.commands(), "allowanceUsd": 0, "automaticRetryAllowed": False}


def strings(value):
    if isinstance(value, dict):
        for key, item in value.items():
            yield key
            yield from strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from strings(item)
    elif isinstance(value, str):
        yield value


class ScopeContract(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.scope = scope(self.clock())
        self.patches = [patch.object(s, "UID_SHA256", self.scope["uidSha256"]),
                        patch.object(s, "PROJECT_HASH", self.scope["projectNumberSha256"])]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)

    def test_exact_scope_accepts_only_declared_limits(self):
        s.validate_scope(self.scope, self.clock())
        self.assertEqual(self.scope["limits"], {
            "mainCli": 13, "cleanupCli": 12, "mainHttps": 10, "cleanupHttps": 4,
            "cache": 2, "enable": 1, "disable": 1, "policyAdd": 1,
            "policyRemove": 1, "sign": 1})
        for name in self.scope["limits"]:
            for value in (True, -1, self.scope["limits"][name] + 1):
                with self.subTest(name=name, value=value):
                    changed = copy.deepcopy(self.scope)
                    changed["limits"][name] = value
                    with self.assertRaises(Exception):
                        s.validate_scope(changed, self.clock())

    def test_scope_refuses_unknown_field_mutated_commands_and_authority_shape(self):
        changes = ({"extra": True}, {"version": True}, {"action": "OTHER"},
                   {"operationId": "foreign"}, {"sourceCommit": ""},
                   {"automaticRetryAllowed": True}, {"allowanceUsd": 1},
                   {"uidSha256": "f" * 64}, {"projectNumberSha256": "f" * 64},
                   {"commands": {"enable": ["gcloud", "iam", "service-accounts", "enable"]}})
        for change in changes:
            with self.subTest(change=change):
                with self.assertRaises(Exception):
                    s.validate_scope({**self.scope, **change}, self.clock())

    def test_scope_refuses_expired_launch_and_insufficient_cleanup_reserve(self):
        end = datetime.datetime.fromisoformat(self.scope["window"]["cutoff"].replace("Z", "+00:00")).timestamp()
        with self.assertRaises(Exception):
            s.validate_scope(self.scope, end)
        for key, replacement in (("cleanupEnd", "workEnd"), ("purgeEnd", "cleanupEnd")):
            changed = copy.deepcopy(self.scope)
            changed["window"][key] = changed["window"][replacement]
            with self.subTest(key=key), self.assertRaises(Exception):
                s.validate_scope(changed, self.clock())

    def test_role_cli_projects_every_field_required_by_actual_role_validator(self):
        projection = next(v for v in s.commands()["role"] if v.startswith("--format="))
        for field in ("name", "title", "description", "includedPermissions", "stage", "deleted"):
            self.assertIn(field, projection)


class SafeProjection(unittest.TestCase):
    def project(self, status, body):
        raw = body if isinstance(body, bytes) else wire(body)
        result = s.classify_sign_response(status, raw)
        self.assertIsInstance(result, dict)
        self.assertNotIn(PRIVATE, json.dumps(result))
        self.assertNotIn(TOKEN, json.dumps(result))
        self.assertNotIn(SIGNATURE, json.dumps(result))
        return result

    def test_structured_denial_retains_only_finite_reason(self):
        result = self.project(403, denial())
        self.assertIn("IAM_PERMISSION_DENIED", set(strings(result)))
        self.assertIn("iam.googleapis.com", set(strings(result)))
        self.assertEqual(result["httpStatus"], 403)
        self.assertNotIn("details", result)
        self.assertNotIn("message", result)

    def test_success_discards_signature_key_id_and_payload(self):
        result = self.project(200, {"keyId": PRIVATE, "signedBlob": SIGNATURE})
        self.assertEqual(result["httpStatus"], 200)
        self.assertNotIn("keyId", result)
        self.assertNotIn("signedBlob", result)
        self.assertNotIn(hashlib.sha256(SIGNATURE.encode()).hexdigest(), json.dumps(result))

    def test_unknown_domain_reason_and_metadata_are_not_retained(self):
        for body in [denial(reason=PRIVATE), denial(domain=PRIVATE),
                     denial(**{"@type": PRIVATE}),
                     {"error": {"code": 403, "status": PRIVATE, "message": PRIVATE}},
                     {"error": {"details": [{"@type": "type.googleapis.com/google.rpc.DebugInfo",
                                               "detail": PRIVATE}]}}]:
            with self.subTest(body=body):
                result = self.project(403, body)
                self.assertEqual(result["httpStatus"], 403)
                self.assertEqual(result["outcome"], "UNKNOWN")

    def test_malformed_body_preserves_http_status_and_never_copies_raw_input(self):
        bodies = [b"", b"null", b"[]", b"false", b"42", b"<html>" + PRIVATE.encode(),
                  b"\xff", b'{"error":NaN}', b'{"error":Infinity}',
                  b'{"error":{"code":403,"code":200}}',
                  b'[' * 1100 + b']' * 1100, b"x" * 65537]
        for body in bodies:
            with self.subTest(shape=body[:30]):
                result = self.project(403, body)
                self.assertEqual(result["httpStatus"], 403)
                self.assertNotIn("IAM_PERMISSION_DENIED", set(strings(result)))

    def test_body_error_code_requires_exact_nonboolean_http_consistency(self):
        for code in [True, False, 403.0, "403", 0, 7, 99, 600, 200, 10**100, None]:
            body = denial()
            body["error"]["code"] = code
            with self.subTest(code=code):
                result = self.project(403, body)
                self.assertEqual(result["httpStatus"], 403)
                self.assertNotEqual(result.get("errorCode"), code if code is not None else 403)

    def test_conflicting_error_info_cannot_select_a_convenient_reason(self):
        body = denial()
        body["error"]["details"].append(denial(reason="SERVICE_DISABLED")["error"]["details"][0])
        result = self.project(403, body)
        self.assertEqual(result["httpStatus"], 403)
        self.assertEqual(result["outcome"], "UNKNOWN")
        self.assertNotIn(PRIVATE, json.dumps(result))

    def test_metadata_projects_only_equality_flags_and_never_values(self):
        expected = {"permission": "iam.serviceAccounts.signBlob",
                    "service": "iamcredentials.googleapis.com",
                    "consumer": "projects/" + NUMBER, "target": "projects/signmons/serviceAccounts/" + UID}
        body = denial()
        body["error"]["details"][0]["metadata"] = {**expected, "private": PRIVATE}
        result = s.classify_sign_response(403, wire(body), expected=expected)
        flags = result["errorInfo"][0]["metadataMatches"]
        self.assertEqual(flags, {name: "MATCH" for name in expected})
        for private in (PRIVATE, NUMBER, UID):
            self.assertNotIn(private, json.dumps(result))
        body["error"]["details"][0]["metadata"]["permission"] = PRIVATE
        body["error"]["details"][0]["metadata"].pop("target")
        result = s.classify_sign_response(403, wire(body), expected=expected)
        self.assertEqual(result["errorInfo"][0]["metadataMatches"]["permission"], "MISMATCH")
        self.assertEqual(result["errorInfo"][0]["metadataMatches"]["target"], "UNKNOWN")
        self.assertNotIn(PRIVATE, json.dumps(result))

    def test_error_info_limit_and_nonstring_metadata_are_unknown(self):
        for mutate in (lambda e: e.update(details=e["details"] * 33),
                       lambda e: e["details"][0].update(metadata={"permission": 403}),
                       lambda e: e["details"][0].update(metadata=None)):
            body = denial()
            mutate(body["error"])
            result = self.project(403, body)
            self.assertEqual(result["outcome"], "UNKNOWN")
            self.assertEqual(result["httpStatus"], 403)

    def test_missing_or_invalid_success_signature_never_claims_signed(self):
        for body in ({}, {"keyId": "key"}, {"signedBlob": SIGNATURE},
                     {"keyId": "key", "signedBlob": ""},
                     {"keyId": "key", "signedBlob": "not base64!!!"},
                     {"keyId": "key", "signedBlob": SIGNATURE, "private": PRIVATE}):
            result = self.project(200, body)
            self.assertEqual(result["outcome"], "UNKNOWN")
            self.assertFalse(result["signatureObserved"])



class Clock:
    def __init__(self, now=None):
        self.now = time.time() if now is None else now
        self.mono = 100.0
        self.sleeps = []

    def __call__(self):
        return self.now

    def monotonic(self):
        return self.mono

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds
        self.mono += seconds


class Response(io.BytesIO):
    """Exercise the real urllib-style response reader, including partial reads."""
    def __init__(self, body, status=403, chunk_size=None, failure=None):
        super().__init__(body)
        self.status = status
        self.chunk_size = chunk_size
        self.failure = failure
        self.read_count = 0
        self.close_count = 0

    def read(self, size=-1):
        self.read_count += 1
        if self.failure:
            raise self.failure
        if self.chunk_size is not None:
            size = self.chunk_size if size < 0 else min(size, self.chunk_size)
        return super().read(size)

    def close(self):
        self.close_count += 1
        super().close()


class Opener:
    def __init__(self, response, as_error=False):
        self.response = response
        self.as_error = as_error
        self.calls = []

    def open(self, request, timeout=None):
        self.calls.append((request, timeout))
        if self.as_error:
            raise urllib.error.HTTPError(request.full_url, self.response.status,
                                         PRIVATE, {}, self.response)
        return self.response


class Provider:
    """In-memory cloud state; no network, SDK invocation or credential store."""
    def __init__(self):
        self.disabled = True
        self.uid = UID
        self.token = TOKEN
        self.policy = {"version": 3, "etag": "initial-etag",
                       "bindings": [{"role": "roles/viewer",
                                     "members": ["user:" + PRIVATE + "@example.invalid"]}]}
        self.unrelated = copy.deepcopy(self.policy["bindings"])
        self.commands = []
        self.requests = []
        self.cache_reads = []
        self.closes = []
        self.phase = "main"
        self.command_hook = None
        self.request_hook = None
        self.cache_hook = None
        self.close_hook = None
        self.prediction = "CAN_ACCESS"
        self.sign_status = 403
        self.sign_body = denial()
        self.omit_enabled_false = False
        self.etag_generation = 0

    def command_name(self, argv):
        for name, vector in s.commands().items():
            if list(argv) == list(vector) or list(argv)[-len(vector)+1:] == list(vector)[1:]:
                return name
        raise AssertionError("Unreviewed SDK command reached fake: " + repr(argv))

    def _owned_run(self, argv, env, deadline):
        name = self.command_name(argv)
        self.commands.append((self.phase, name))
        if self.command_hook:
            replacement = self.command_hook(name, self.phase)
            if replacement is not None:
                return replacement
        if name == "owner":
            return wire([{"account": "debynyhan@signmons.com", "status": "ACTIVE"}])
        if name == "project":
            return wire({"projectId": "signmons", "projectNumber": NUMBER, "lifecycleState": "ACTIVE"})
        if name == "token_owner":
            return b"debynyhan@signmons.com\n"
        if name.startswith("config_"):
            return b"(unset)\n"
        if name == "token":
            return self.token.encode()
        if name == "role":
            return wire({"name": "projects/signmons/roles/signmonsP08ServiceAccountSignBlob",
                         "title": "Signmons P08 Service Account Sign Blob",
                         "description": "Exact signBlob permission for bounded Signmons P08 owner access to the dedicated runtime identity.",
                         "includedPermissions": ["iam.serviceAccounts.signBlob"], "stage": "GA"})
        if name in ("identity", "readback"):
            value = {"email": "signmons-calldesk-p07-runtime@signmons.iam.gserviceaccount.com"}
            if name == "identity":
                value["uniqueId"] = self.uid
            if self.disabled or not self.omit_enabled_false:
                value["disabled"] = self.disabled
            return wire(value)
        raise AssertionError(name)

    def cache_reader(self, purge_end):
        self.cache_reads.append((self.phase, purge_end))
        return self.cache_hook(self.phase) if self.cache_hook else self.token

    def close(self, deadline):
        self.closes.append(self.phase)
        return self.close_hook(self.phase) if self.close_hook else True

    def request_name(self, request):
        url = request.full_url
        if url.endswith(":signBlob"):
            return "sign"
        if url.endswith(":enable"):
            return "enable"
        if url.endswith(":disable"):
            return "disable"
        if url.endswith(":setIamPolicy"):
            return "policy_add" if self.phase == "main" else "policy_remove"
        if urlsplit(url).path.endswith(":getIamPolicy"):
            seen = sum(1 for phase, name, _ in self.requests if phase == self.phase and name.startswith("policy_"))
            return ("policy_before" if seen == 0 else "policy_after") if self.phase == "main" else \
                ("policy_cleanup_before" if seen == 0 else "policy_cleanup_after")
        if "/services/iamcredentials.googleapis.com" in url:
            return "service_signing"
        if "/services/policytroubleshooter.googleapis.com" in url:
            return "service_troubleshooter"
        if url.endswith(":testIamPermissions"):
            return "identity_permissions" if "/serviceAccounts/" in url else "project_permissions"
        if "policytroubleshooter.googleapis.com" in url:
            return "prediction"
        raise AssertionError("Unreviewed HTTPS destination reached fake: " + url)

    def open(self, request, timeout=None):
        name = self.request_name(request)
        self.requests.append((self.phase, name, request))
        if self.request_hook:
            replacement = self.request_hook(name, self.phase, request)
            if replacement is not None:
                return replacement
        return self.apply(name, request)

    def apply(self, name, request):
        body = json.loads(request.data) if request.data else {}
        if name.startswith("service_"):
            value = {"name": urlsplit(request.full_url).path.split("/v1/")[-1], "state": "ENABLED"}
        elif name.endswith("permissions"):
            value = {"permissions": body["permissions"]}
        elif name in ("policy_before", "policy_after", "policy_cleanup_before", "policy_cleanup_after"):
            self.assert_policy_request(request, body)
            value = copy.deepcopy(self.policy)
        elif name in ("policy_add", "policy_remove"):
            policy = body["policy"]
            if policy["etag"] != self.policy["etag"]:
                return Response(wire({"error": {"code": 409, "status": "ABORTED", "message": PRIVATE}}), 409)
            self.policy = copy.deepcopy(policy)
            self.etag_generation += 1
            self.policy["etag"] = "fresh-etag-" + str(self.etag_generation)
            value = copy.deepcopy(self.policy)
        elif name in ("enable", "disable"):
            if body != {}:
                raise AssertionError("Identity mutation body is not empty")
            if "/serviceAccounts/" + UID + ":" not in request.full_url:
                raise AssertionError("Identity mutation is not pinned to matched UID")
            self.disabled = name == "disable"
            value = {}
        elif name == "prediction":
            value = {"overallAccessState": self.prediction}
        elif name == "sign":
            return Response(wire(self.sign_body), self.sign_status)
        else:
            raise AssertionError(name)
        return Response(wire(value), 200)

    @staticmethod
    def assert_policy_request(request, body):
        if body != {} or parse_qs(urlsplit(request.full_url).query) != {"options.requestedPolicyVersion": ["3"]}:
            raise AssertionError("Policy read must request conditional-policy version 3")

class PhaseContract(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.scope = scope(self.clock())
        self.provider = Provider()
        self.root = Path(s.root_for(self.scope["operationId"]))
        self.assertFalse(self.root.exists())
        self.addCleanup(lambda: shutil.rmtree(self.root) if self.root.exists() else None)
        self.patches = [patch.object(s, "UID_SHA256", self.scope["uidSha256"]),
                        patch.object(s, "PROJECT_HASH", self.scope["projectNumberSha256"])]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)
        self.guard_hook = lambda _scope: None
        self.configuration_hook = lambda: CONFIG

    def hooks(self):
        return SimpleNamespace(io_factory=lambda: self.provider,
                               cache_reader=self.provider.cache_reader,
                               guard=lambda scope: self.guard_hook(scope),
                               configuration=lambda: self.configuration_hook(),
                               clock=self.clock, monotonic=self.clock.monotonic,
                               sleep=self.clock.sleep, opener=self.provider)

    def phase(self, name):
        self.provider.phase = name
        return s.run_phase(self.scope, name, hooks=self.hooks(), root=self.root)

    def pair(self):
        main = self.phase("main")
        cleanup = self.phase("cleanup")
        self.assert_bounds_and_privacy()
        return main, cleanup

    def assert_bounds_and_privacy(self):
        for phase, limit in (("main", 13), ("cleanup", 12)):
            self.assertLessEqual(sum(p == phase for p, _ in self.provider.commands), limit)
        for phase, limit in (("main", 10), ("cleanup", 4)):
            self.assertLessEqual(sum(p == phase for p, _, _ in self.provider.requests), limit)
        for name in ("enable", "disable", "policy_add", "policy_remove", "sign"):
            self.assertLessEqual(sum(n == name for _, n, _ in self.provider.requests), 1, name)
        self.assertLessEqual(len(self.provider.cache_reads), 2)
        retained = "".join(p.read_text() for p in self.root.rglob("*") if p.is_file()) if self.root.exists() else ""
        for sentinel in (UID, NUMBER, TOKEN, PRIVATE, SIGNATURE):
            self.assertNotIn(sentinel, retained)

    def test_structured_denial_then_independent_restoration(self):
        main, cleanup = self.pair()
        self.assertEqual(main["signResult"]["httpStatus"], 403)
        self.assertIn("IAM_PERMISSION_DENIED", set(strings(main["signResult"])))
        self.assertTrue(cleanup["policyAbsent"])
        self.assertTrue(cleanup["identityDisabled"])
        self.assertTrue(cleanup["processClosed"])
        self.assertTrue(cleanup["privateInputsAbsent"])
        self.assertTrue(self.provider.disabled)
        self.assertEqual(self.provider.policy["bindings"], self.provider.unrelated)

    def test_success_signs_public_nonjwt_challenge_and_never_exchanges(self):
        self.provider.sign_status = 200
        self.provider.sign_body = {"keyId": "a" * 40, "signedBlob": SIGNATURE}
        main, cleanup = self.pair()
        self.assertEqual(main["signResult"]["outcome"], "SIGNED")
        signing = [request for _, name, request in self.provider.requests if name == "sign"]
        self.assertEqual(len(signing), 1)
        request = signing[0]
        self.assertEqual(request.get_method(), "POST")
        body = json.loads(request.data)
        self.assertEqual(set(body), {"payload"})
        payload = base64.b64decode(body["payload"], validate=True).decode()
        self.assertEqual(payload, "Signmons P08 signing diagnostic " + self.scope["operationId"] + " not authentication")
        self.assertNotIn(".", payload)
        self.assertEqual(request.get_header("Authorization"), "Bearer " + TOKEN)
        self.assertEqual(request.get_header("X-goog-user-project"), "signmons")
        self.assertEqual(request.get_header("Content-type"), "application/json")
        self.assertTrue(cleanup["identityDisabled"])

    def test_already_enabled_initial_identity_never_mutates(self):
        self.provider.disabled = False
        main = self.phase("main")
        self.assertIsNotNone(main["mainFailure"])
        self.assertFalse(self.provider.requests)
        self.assert_bounds_and_privacy()

    def test_enabled_false_may_be_omitted_without_inventing_explicit_false(self):
        self.provider.omit_enabled_false = True
        main, cleanup = self.pair()
        self.assertEqual(main["signResult"]["httpStatus"], 403)
        self.assertTrue(cleanup["identityDisabled"])

    def test_token_cache_mismatch_blocks_main_mutations(self):
        self.provider.cache_hook = lambda _phase: "OTHER_PRIVATE_TOKEN_SENTINEL"
        main = self.phase("main")
        self.assertIsNotNone(main["mainFailure"])
        self.assertFalse(self.provider.requests)
        self.assert_bounds_and_privacy()

    def test_consumed_main_and_cleanup_cannot_replay(self):
        self.pair()
        before = (len(self.provider.commands), len(self.provider.requests), len(self.provider.cache_reads))
        for phase in ("main", "cleanup"):
            with self.subTest(phase=phase):
                try:
                    self.phase(phase)
                except Exception:
                    pass
                self.assertEqual(before, (len(self.provider.commands), len(self.provider.requests), len(self.provider.cache_reads)))

    def test_policy_remove_failure_does_not_suppress_identity_disable(self):
        self.phase("main")
        def fail(name, phase, request):
            if phase == "cleanup" and name == "policy_remove":
                return Response(wire(denial()), 403)
        self.provider.request_hook = fail
        cleanup = self.phase("cleanup")
        self.assertTrue(self.provider.disabled)
        self.assertTrue(cleanup["identityDisabled"])
        self.assertFalse(cleanup["policyAbsent"])
        self.assertTrue(cleanup["residuals"])
        self.assertIn("disable", [name for phase, name, _ in self.provider.requests if phase == "cleanup"])
        self.assert_bounds_and_privacy()

    def test_identity_disable_failure_preserves_independent_policy_readback(self):
        self.phase("main")
        def fail(name, phase, request):
            if phase == "cleanup" and name == "disable":
                return Response(wire(denial()), 403)
        self.provider.request_hook = fail
        cleanup = self.phase("cleanup")
        self.assertFalse(self.provider.disabled)
        self.assertFalse(cleanup["identityDisabled"])
        self.assertTrue(cleanup["policyAbsent"])
        self.assertTrue(cleanup["residuals"])
        self.assertEqual(self.provider.policy["bindings"], self.provider.unrelated)
        self.assert_bounds_and_privacy()

    def test_cleanup_uses_current_etag_and_preserves_concurrent_unrelated_binding(self):
        self.phase("main")
        addition = {"role": "roles/logging.viewer", "members": ["group:" + PRIVATE + "@example.invalid"]}
        self.provider.policy["bindings"].append(copy.deepcopy(addition))
        self.provider.policy["etag"] = "concurrent-policy-etag"
        cleanup = self.phase("cleanup")
        removals = [request for phase, name, request in self.provider.requests if phase == "cleanup" and name == "policy_remove"]
        self.assertEqual(len(removals), 1)
        self.assertEqual(json.loads(removals[0].data)["policy"]["etag"], "concurrent-policy-etag")
        self.assertEqual(self.provider.policy["bindings"], self.provider.unrelated + [addition])
        self.assertTrue(cleanup["policyAbsent"])
        self.assertTrue(cleanup["identityDisabled"])
        self.assert_bounds_and_privacy()

    def test_foreign_cleanup_uid_is_never_disabled_or_modified(self):
        self.phase("main")
        self.provider.uid = "999999999999999999999"
        cleanup = self.phase("cleanup")
        self.assertTrue(cleanup["residuals"])
        self.assertFalse(cleanup["identityDisabled"])
        self.assertFalse([name for phase, name, _ in self.provider.requests if phase == "cleanup" and name in ("disable", "policy_remove")])
        self.assert_bounds_and_privacy()

    def test_missing_initial_policy_etag_blocks_enable_and_policy_add(self):
        self.provider.policy.pop("etag")
        main = self.phase("main")
        self.assertIsNotNone(main["mainFailure"])
        self.assertFalse([name for _, name, _ in self.provider.requests if name in ("enable", "policy_add", "sign")])
        self.assert_bounds_and_privacy()

    def test_policy_add_http_conflict_is_not_retried_and_identity_is_restored(self):
        def conflict(name, phase, request):
            if name == "policy_add":
                return Response(wire({"error": {"code": 409, "status": "ABORTED", "message": PRIVATE}}), 409)
        self.provider.request_hook = conflict
        main, cleanup = self.pair()
        self.assertIsNotNone(main["mainFailure"])
        self.assertFalse([1 for _, name, _ in self.provider.requests if name == "sign"])
        self.assertTrue(cleanup["identityDisabled"])
        self.assertEqual(sum(name == "policy_add" for _, name, _ in self.provider.requests), 1)

    def test_uncertain_enable_ack_preserves_unknown_even_after_restored_readback(self):
        def lost_ack(name, phase, request):
            if name == "enable":
                self.provider.apply(name, request)
                raise TimeoutError(PRIVATE)
        self.provider.request_hook = lost_ack
        main, cleanup = self.pair()
        self.assertIsNotNone(main["mainFailure"])
        self.assertTrue(self.provider.disabled)
        self.assertTrue(cleanup["identityDisabled"])
        self.assertNotEqual(cleanup.get("status"), "SQ1_DIAGNOSTIC_CLOSED")
        self.assertTrue(cleanup["residuals"], "Late in-flight mutation uncertainty must survive final readbacks")

    def test_lost_policy_add_ack_is_not_replayed_and_exact_binding_is_removed(self):
        def lost_ack(name, phase, request):
            if name == "policy_add":
                self.provider.apply(name, request)
                raise TimeoutError(PRIVATE)
        self.provider.request_hook = lost_ack
        main, cleanup = self.pair()
        self.assertIsNotNone(main["mainFailure"])
        self.assertEqual(self.provider.policy["bindings"], self.provider.unrelated)
        self.assertTrue(cleanup["policyAbsent"])
        self.assertTrue(cleanup["identityDisabled"])
        self.assertNotEqual(cleanup.get("status"), "SQ1_DIAGNOSTIC_CLOSED")
        self.assertTrue(cleanup["residuals"])

    def test_lost_policy_remove_ack_does_not_retry_or_suppress_disable(self):
        self.phase("main")
        def lost_ack(name, phase, request):
            if name == "policy_remove":
                self.provider.apply(name, request)
                raise TimeoutError(PRIVATE)
        self.provider.request_hook = lost_ack
        cleanup = self.phase("cleanup")
        self.assertTrue(self.provider.disabled)
        self.assertEqual(self.provider.policy["bindings"], self.provider.unrelated)
        self.assertEqual(sum(name == "policy_remove" for _, name, _ in self.provider.requests), 1)
        self.assertTrue(cleanup["residuals"])
        self.assert_bounds_and_privacy()

    def test_sign_prediction_denial_prevents_sign_and_still_restores(self):
        self.provider.prediction = "CANNOT_ACCESS"
        main, cleanup = self.pair()
        self.assertIsNotNone(main["mainFailure"])
        self.assertFalse([1 for _, name, _ in self.provider.requests if name == "sign"])
        self.assertTrue(cleanup["identityDisabled"])
        self.assertTrue(cleanup["policyAbsent"])

    def test_signature_response_does_not_override_unconfirmed_process_close(self):
        self.provider.sign_status = 200
        self.provider.sign_body = {"keyId": "a" * 40, "signedBlob": SIGNATURE}
        self.provider.close_hook = lambda phase: phase != "main"
        main, cleanup = self.pair()
        self.assertEqual(main["signResult"]["outcome"], "SIGNED")
        self.assertFalse(main["processClosed"])
        self.assertTrue(cleanup["residuals"])
        self.assertNotEqual(cleanup.get("status"), "SQ1_DIAGNOSTIC_CLOSED")

    def test_cleanup_cache_horizon_failure_never_dispatches_mutation(self):
        self.phase("main")
        def expired(_phase):
            raise RuntimeError("CACHED_TOKEN_EXPIRED")
        self.provider.cache_hook = expired
        cleanup = self.phase("cleanup")
        self.assertTrue(cleanup["residuals"])
        self.assertFalse([1 for phase, _, _ in self.provider.requests if phase == "cleanup"])
        self.assert_bounds_and_privacy()

    def test_foreign_root_and_duplicate_operation_refuse_before_transport(self):
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaises(Exception):
                s.run_phase(self.scope, "main", hooks=self.hooks(), root=Path(temp) / "foreign")
        self.assertFalse(self.provider.commands)
        self.assertFalse(self.provider.requests)

    def test_exact_maximum_trace_keeps_reserved_cleanup_capacity(self):
        observations = {"main": 0, "cleanup": 0}
        observed_at = {"main": [], "cleanup": []}
        def delayed(name, phase):
            if name == "readback":
                observations[phase] += 1
                observed_at[phase].append(self.clock.monotonic())
                expected_disabled = phase == "cleanup"
                return wire({"email": "signmons-calldesk-p07-runtime@signmons.iam.gserviceaccount.com",
                             "disabled": expected_disabled if observations[phase] == 3 else not expected_disabled})
        self.provider.command_hook = delayed
        main, cleanup = self.pair()
        self.assertEqual(main["signResult"]["httpStatus"], 403)
        self.assertTrue(cleanup["identityDisabled"])
        self.assertEqual(observations, {"main": 3, "cleanup": 3})
        for phase in ("main", "cleanup"):
            offsets = [round(value - observed_at[phase][0], 6) for value in observed_at[phase]]
            self.assertEqual(offsets, [0, 5, 15])
        self.assertEqual(sum(p == "main" for p, _ in self.provider.commands), 13)
        self.assertEqual(sum(p == "cleanup" for p, _ in self.provider.commands), 12)
        self.assertEqual(sum(p == "main" for p, _, _ in self.provider.requests), 10)
        self.assertEqual(sum(p == "cleanup" for p, _, _ in self.provider.requests), 4)
        self.assertEqual(len(self.provider.cache_reads), 2)

    def test_foreign_policy_member_is_not_removed_but_disable_still_runs(self):
        self.phase("main")
        owned = [b for b in self.provider.policy["bindings"]
                 if b["role"] == "projects/signmons/roles/signmonsP08ServiceAccountSignBlob"]
        self.assertEqual(len(owned), 1)
        owned[0]["members"].append("user:foreign@example.invalid")
        original = copy.deepcopy(self.provider.policy["bindings"])
        cleanup = self.phase("cleanup")
        self.assertTrue(cleanup["identityDisabled"])
        self.assertFalse(cleanup["policyAbsent"])
        self.assertTrue(cleanup["residuals"])
        self.assertEqual(self.provider.policy["bindings"], original)
        self.assertFalse([1 for phase, name, _ in self.provider.requests if phase == "cleanup" and name == "policy_remove"])
        self.assert_bounds_and_privacy()

    def test_failed_service_permission_and_policy_reads_never_activate(self):
        for failure in ("service_signing", "service_troubleshooter", "project_permissions",
                        "identity_permissions", "policy_before"):
            with self.subTest(failure=failure):
                self.scope = scope(self.clock())
                self.root = Path(s.root_for(self.scope["operationId"]))
                current_root = self.root
                self.addCleanup(lambda root=current_root: shutil.rmtree(root) if root.exists() else None)
                self.provider = Provider()
                self.provider.request_hook = lambda name, phase, request: Response(wire(denial()), 403) if name == failure else None
                main = self.phase("main")
                self.assertIsNotNone(main["mainFailure"])
                self.assertTrue(self.provider.disabled)
                self.assertFalse([1 for _, name, _ in self.provider.requests if name in ("enable", "policy_add", "sign")])
                self.assert_bounds_and_privacy()

    def test_source_drift_before_dispatch_cannot_reach_provider_or_cache(self):
        def refused(_scope):
            raise RuntimeError("SOURCE_DRIFT")
        self.guard_hook = refused
        try:
            result = self.phase("main")
        except Exception:
            result = None
        if result is not None:
            self.assertIsNotNone(result["mainFailure"])
        self.assertFalse(self.provider.commands)
        self.assertFalse(self.provider.requests)
        self.assertFalse(self.provider.cache_reads)

    def test_configuration_drift_before_dispatch_cannot_reach_provider_or_cache(self):
        self.configuration_hook = lambda: "f" * 64
        try:
            result = self.phase("main")
        except Exception:
            result = None
        if result is not None:
            self.assertIsNotNone(result["mainFailure"])
        self.assertFalse(self.provider.commands)
        self.assertFalse(self.provider.requests)
        self.assertFalse(self.provider.cache_reads)

    def test_presign_uid_mismatch_stops_sign_and_cleanup_checks_fresh_uid(self):
        main_identity = 0
        def identity(name, phase):
            nonlocal main_identity
            if phase == "main" and name == "identity":
                main_identity += 1
                if main_identity == 2:
                    return wire({"email": "signmons-calldesk-p07-runtime@signmons.iam.gserviceaccount.com",
                                 "uniqueId": "999999999999999999999", "disabled": False})
        self.provider.command_hook = identity
        main, cleanup = self.pair()
        self.assertIsNotNone(main["mainFailure"])
        self.assertFalse([1 for _, name, _ in self.provider.requests if name == "sign"])
        self.assertTrue(cleanup["identityDisabled"])
        self.assertTrue(cleanup["policyAbsent"])

    def test_cleanup_fresh_token_is_used_instead_of_main_token(self):
        self.phase("main")
        self.provider.token = "SECOND_PRIVATE_TOKEN_SENTINEL_" * 2
        cleanup = self.phase("cleanup")
        cleanup_requests = [r for phase, _, r in self.provider.requests if phase == "cleanup"]
        self.assertTrue(cleanup_requests)
        self.assertTrue(all(r.get_header("Authorization") == "Bearer " + self.provider.token for r in cleanup_requests))
        self.assertTrue(cleanup["identityDisabled"])
        self.assertEqual(sum(phase == "cleanup" and name == "token" for phase, name in self.provider.commands), 1)
        retained = "".join(p.read_text() for p in self.root.rglob("*") if p.is_file())
        self.assertNotIn(self.provider.token, retained)
        self.assert_bounds_and_privacy()

    def test_no_mutation_does_not_invent_unobserved_current_restoration(self):
        self.provider.command_hook = lambda name, phase: b"[]" if name == "owner" else None
        main, cleanup = self.pair()
        self.assertIsNotNone(main["mainFailure"])
        self.assertEqual(cleanup["status"], "SQ1_NOT_MUTATED")
        self.assertIsNone(cleanup["identityDisabled"])
        self.assertIsNone(cleanup["policyAbsent"])
        self.assertFalse(self.provider.requests)
        self.assertFalse(self.provider.cache_reads)

    def test_condition_free_version_one_policy_roundtrip_uses_version_three_for_add(self):
        self.provider.policy["version"] = 1
        main = self.phase("main")
        self.assertEqual(main["signResult"]["httpStatus"], 403)
        additions = [request for _, name, request in self.provider.requests if name == "policy_add"]
        self.assertEqual(len(additions), 1)
        self.assertEqual(json.loads(additions[0].data)["policy"]["version"], 3)
        def normalized_final(name, phase, request):
            if name == "policy_remove":
                response = self.provider.apply(name, request)
                self.provider.policy["version"] = 1
                return response
        self.provider.request_hook = normalized_final
        cleanup = self.phase("cleanup")
        self.assertTrue(cleanup["identityDisabled"])
        self.assertTrue(cleanup["policyAbsent"])
        self.assertEqual(self.provider.policy["bindings"], self.provider.unrelated)
        self.assert_bounds_and_privacy()

    def test_condition_free_policy_with_omitted_version_is_supported(self):
        self.provider.policy.pop("version")
        main, cleanup = self.pair()
        self.assertEqual(main["signResult"]["httpStatus"], 403)
        self.assertTrue(cleanup["policyAbsent"])

    def test_policy_with_conditional_binding_cannot_claim_version_one(self):
        self.provider.policy["version"] = 1
        self.provider.policy["bindings"][0]["condition"] = {"title": "foreign", "expression": "true"}
        main = self.phase("main")
        self.assertIsNotNone(main["mainFailure"])
        self.assertFalse([name for _, name, _ in self.provider.requests if name in ("enable", "policy_add")])
        self.assert_bounds_and_privacy()

    def test_unsupported_policy_fields_refuse_before_any_policy_overwrite(self):
        self.provider.policy["auditConfigs"] = [{"service": "allServices", "auditLogConfigs": [{"logType": "DATA_READ"}]}]
        main = self.phase("main")
        self.assertIsNotNone(main["mainFailure"])
        self.assertFalse([name for _, name, _ in self.provider.requests if name in ("enable", "policy_add")])
        self.assertIn("auditConfigs", self.provider.policy)
        self.assert_bounds_and_privacy()

    def test_empty_or_invalid_unrelated_policy_members_refuse_before_activation(self):
        for members in ([], [""], [False], PRIVATE):
            with self.subTest(members=members):
                candidate = copy.deepcopy(self.provider.policy)
                candidate["bindings"][0]["members"] = members
                with self.assertRaises(Exception):
                    s.policy_state(candidate, self.scope)

    def test_malformed_enable_success_body_does_not_acknowledge_mutation(self):
        def malformed(name, phase, request):
            if name == "enable":
                self.provider.apply(name, request)
                return Response(wire({"private": PRIVATE}), 200)
        self.provider.request_hook = malformed
        main, cleanup = self.pair()
        self.assertIsNotNone(main["mainFailure"])
        self.assertFalse((self.root / "ack-enable.json").exists())
        self.assertTrue(self.provider.disabled)
        self.assertTrue(cleanup["residuals"])

    def test_malformed_disable_success_body_keeps_unknown_despite_disabled_readback(self):
        self.phase("main")
        def malformed(name, phase, request):
            if name == "disable":
                self.provider.apply(name, request)
                return Response(wire({"private": PRIVATE}), 200)
        self.provider.request_hook = malformed
        cleanup = self.phase("cleanup")
        self.assertTrue(self.provider.disabled)
        self.assertTrue(cleanup["identityDisabled"])
        self.assertFalse((self.root / "ack-disable.json").exists())
        self.assertTrue(cleanup["residuals"])
        self.assert_bounds_and_privacy()

    def test_source_drift_after_activation_stops_sign_and_preserves_unknown(self):
        def guard(_scope):
            if not self.provider.disabled:
                raise RuntimeError("SOURCE_DRIFT")
        self.guard_hook = guard
        main = self.phase("main")
        self.assertIsNotNone(main["mainFailure"])
        self.assertFalse(main["sourceClosed"])
        self.assertFalse([1 for _, name, _ in self.provider.requests if name == "sign"])
        self.guard_hook = lambda _scope: None
        cleanup = self.phase("cleanup")
        self.assertTrue(cleanup["identityDisabled"])
        self.assertIn("SOURCE_UNCONFIRMED", cleanup["residuals"])
        self.assert_bounds_and_privacy()

    def test_configuration_drift_after_activation_stops_sign_and_restores_independently(self):
        self.configuration_hook = lambda: CONFIG if self.provider.disabled else "f" * 64
        main = self.phase("main")
        self.assertIsNotNone(main["mainFailure"])
        self.assertFalse(main["configurationClosed"])
        self.assertFalse([1 for _, name, _ in self.provider.requests if name == "sign"])
        self.configuration_hook = lambda: CONFIG
        cleanup = self.phase("cleanup")
        self.assertTrue(cleanup["identityDisabled"])
        self.assertIn("CONFIGURATION_UNCONFIRMED", cleanup["residuals"])
        self.assert_bounds_and_privacy()

    def test_cleanup_configuration_drift_between_branches_preserves_unrestored_state(self):
        self.phase("main")
        def configuration():
            removed = any(phase == "cleanup" and name == "policy_remove" for phase, name, _ in self.provider.requests)
            return "f" * 64 if removed else CONFIG
        self.configuration_hook = configuration
        cleanup = self.phase("cleanup")
        self.assertTrue(cleanup["residuals"])
        self.assertFalse(cleanup["configurationClosed"])
        self.assertFalse(cleanup["identityDisabled"])
        self.assertFalse([1 for phase, name, _ in self.provider.requests if phase == "cleanup" and name == "disable"])
        self.assert_bounds_and_privacy()

    def test_post_enable_work_deadline_stops_main_but_cleanup_has_separate_reserve(self):
        def deadline(name, phase, request):
            if name == "enable":
                response = self.provider.apply(name, request)
                self.clock.now = datetime.datetime.fromisoformat(self.scope["window"]["workEnd"].replace("Z", "+00:00")).timestamp()
                return response
        self.provider.request_hook = deadline
        main, cleanup = self.pair()
        self.assertIsNotNone(main["mainFailure"])
        self.assertFalse(main["onTime"])
        self.assertTrue(cleanup["identityDisabled"])
        self.assertTrue(cleanup["onTime"])
        self.assertFalse([1 for _, name, _ in self.provider.requests if name == "sign"])

    def test_clock_rollback_stops_following_dispatch_and_cleanup_requires_restored_clock(self):
        previous = self.clock.now
        def rollback(name, phase, request):
            if name == "enable":
                response = self.provider.apply(name, request)
                self.clock.now -= 1
                return response
        self.provider.request_hook = rollback
        main = self.phase("main")
        self.assertIsNotNone(main["mainFailure"])
        self.assertFalse([1 for _, name, _ in self.provider.requests if name in ("policy_add", "sign")])
        self.clock.now = previous + 1
        cleanup = self.phase("cleanup")
        self.assertTrue(cleanup["identityDisabled"])
        self.assert_bounds_and_privacy()

    def test_successful_but_mismatching_provider_metadata_prevents_mutations(self):
        variants = [("service_signing", {"name": "foreign", "state": "ENABLED"}),
                    ("service_troubleshooter", {"name": "projects/" + NUMBER + "/services/policytroubleshooter.googleapis.com", "state": "DISABLED"}),
                    ("project_permissions", {"permissions": []}),
                    ("identity_permissions", {"permissions": ["iam.serviceAccounts.get"]})]
        for failure, value in variants:
            with self.subTest(failure=failure):
                self.scope = scope(self.clock())
                self.root = Path(s.root_for(self.scope["operationId"]))
                current_root = self.root
                self.addCleanup(lambda root=current_root: shutil.rmtree(root) if root.exists() else None)
                self.provider = Provider()
                self.provider.request_hook = lambda name, phase, request: Response(wire(value), 200) if name == failure else None
                main = self.phase("main")
                self.assertIsNotNone(main["mainFailure"])
                self.assertFalse([1 for _, name, _ in self.provider.requests if name in ("enable", "policy_add", "sign")])
                self.assert_bounds_and_privacy()

    def test_wrong_role_definition_is_not_fixed_or_bypassed(self):
        self.provider.command_hook = lambda name, phase: wire({"name": "foreign", "includedPermissions": ["iam.serviceAccounts.signBlob"]}) if name == "role" else None
        main = self.phase("main")
        self.assertIsNotNone(main["mainFailure"])
        self.assertFalse(self.provider.requests)
        self.assertFalse(self.provider.cache_reads)

    def test_phase_lock_prevents_overlapping_cleanup_before_any_dispatch(self):
        import fcntl
        self.phase("main")
        fd = os.open(self.root / "entry.lock", os.O_RDWR)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            before = (len(self.provider.commands), len(self.provider.requests))
            with self.assertRaises(Exception):
                self.phase("cleanup")
            self.assertEqual(before, (len(self.provider.commands), len(self.provider.requests)))
        finally:
            os.close(fd)
        cleanup = self.phase("cleanup")
        self.assertTrue(cleanup["identityDisabled"])
        self.assert_bounds_and_privacy()


class HttpBoundary(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.scope = scope(self.clock())
        contract = s.descriptor_contract(self.scope, UID, NUMBER)
        self.sign = contract["sign"]

    def request(self, body, status=403, *, as_error=False, chunk_size=None, failure=None):
        response = Response(body, status, chunk_size, failure)
        opener = Opener(response, as_error)
        result = s.bounded_request(self.sign, TOKEN, self.clock() + 8,
                                   clock=self.clock, opener=opener)
        self.assertEqual(len(opener.calls), 1)
        self.assertTrue(response.closed)
        self.assertGreaterEqual(response.close_count, 1)
        self.assertEqual(result["status"], status)
        self.assertNotIn(PRIVATE, json.dumps({k: v for k, v in result.items() if k != "body"}))
        return result, opener

    def test_http_error_body_uses_actual_urllib_exception_boundary(self):
        result, opener = self.request(wire(denial()), as_error=True)
        self.assertEqual(result["body"], wire(denial()))
        self.assertIsNone(result["bodyFailure"])
        projected = s.classify_sign_response(result["status"], result["body"])
        self.assertIn("IAM_PERMISSION_DENIED", set(strings(projected)))
        self.assertLessEqual(opener.calls[0][1], 8)

    def test_partial_response_chunks_are_fully_bounded_and_collected(self):
        result, _ = self.request(wire(denial()), chunk_size=7)
        self.assertEqual(result["body"], wire(denial()))

    def test_read_timeout_keeps_observed_status_and_drops_exception_text(self):
        result, _ = self.request(wire(denial()), failure=TimeoutError(PRIVATE))
        self.assertIsNone(result["body"])
        self.assertIsNotNone(result["bodyFailure"])

    def test_body_limit_keeps_observed_status_without_partial_raw_return(self):
        result, _ = self.request(b"x" * 65537)
        self.assertIsNone(result["body"])
        self.assertIsNotNone(result["bodyFailure"])

    def test_redirect_is_a_single_refusal_without_followup(self):
        result, _ = self.request(b"", status=302)
        self.assertIsNone(result["body"])
        self.assertIsNotNone(result["bodyFailure"])

    def test_preheader_failure_has_unknown_status_and_does_not_retry(self):
        class Refused:
            calls = 0
            def open(self, request, timeout=None):
                self.calls += 1
                raise urllib.error.URLError(PRIVATE)
        opener = Refused()
        result = s.bounded_request(self.sign, TOKEN, self.clock() + 8,
                                   clock=self.clock, opener=opener)
        self.assertEqual(opener.calls, 1)
        self.assertIsNone(result["status"])
        self.assertIsNone(result["body"])
        self.assertNotIn(PRIVATE, json.dumps(result))


class LocalHttpBoundary(unittest.TestCase):
    """Real urllib/HTTPServer wire tests, bound exclusively to loopback."""
    def setUp(self):
        cases = self
        self.requests = []
        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_args):
                pass

            def do_POST(self):
                cases.requests.append((self.command, self.path))
                self.rfile.read(int(self.headers.get("Content-Length", "0")))
                try:
                    if self.path == "/slow-header":
                        time.sleep(.35)
                    if self.path == "/redirect":
                        self.send_response(302)
                        self.send_header("Location", "/must-not-follow")
                        self.send_header("Content-Length", "0")
                        self.end_headers()
                        return
                    body = b"x" * 65537 if self.path == "/oversize" else wire(denial())
                    self.send_response(403)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.flush()
                    if self.path == "/slow-body":
                        time.sleep(.35)
                    if self.path == "/stream":
                        for i in range(0, len(body), 7):
                            self.wfile.write(body[i:i + 7])
                            self.wfile.flush()
                    else:
                        self.wfile.write(body)
                        self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=lambda: self.server.serve_forever(poll_interval=.01), daemon=True)
        self.thread.start()
        def close():
            self.server.shutdown()
            self.server.server_close()
            self.thread.join(2)
            self.assertFalse(self.thread.is_alive())
        self.addCleanup(close)

    def request(self, path, seconds=2):
        candidate = scope(time.time())
        descriptor = s.descriptor_contract(candidate, UID, NUMBER)["sign"]
        self.assertEqual(descriptor["url"], "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/signmons-calldesk-p07-runtime@signmons.iam.gserviceaccount.com:signBlob")
        # Keep the production HTTPS descriptor and its guard intact. Only the
        # explicit fake opener sends its Request to this owned loopback server.
        actual = urllib.request.build_opener(urllib.request.ProxyHandler({}), s.NoRedirect())
        local_url = "http://127.0.0.1:" + str(self.server.server_port) + path
        expected_url = descriptor["url"]
        class LocalAdapter:
            def open(adapter, request, timeout):
                self.assertEqual(request.full_url, expected_url)
                local = urllib.request.Request(local_url, data=request.data,
                    headers=dict(request.header_items()), method=request.get_method())
                return actual.open(local, timeout=timeout)
        result = s.bounded_request(descriptor, TOKEN, time.time() + seconds, clock=time.time, opener=LocalAdapter())
        self.assertEqual(self.requests, [("POST", path)])
        return result

    def test_real_http403_stream_is_projected_without_raw_denial_retention(self):
        result = self.request("/stream")
        self.assertEqual(result["status"], 403)
        self.assertIsNone(result["bodyFailure"])
        self.assertEqual(result["body"], wire(denial()))
        safe = s.classify_sign_response(result["status"], result["body"])
        self.assertEqual(safe["outcome"], "REFUSED")
        self.assertNotIn(PRIVATE, json.dumps(safe))

    def test_real_redirect_is_not_followed_or_retried(self):
        result = self.request("/redirect")
        self.assertEqual(result["status"], 302)
        self.assertIsNotNone(result["bodyFailure"])
        self.assertIsNone(result["body"])

    def test_real_streaming_output_limit_keeps_observed403(self):
        result = self.request("/oversize")
        self.assertEqual(result["status"], 403)
        self.assertIsNotNone(result["bodyFailure"])
        self.assertIsNone(result["body"])

    def test_real_delayed_headers_are_unknown_without_retry(self):
        result = self.request("/slow-header", .12)
        self.assertIsNone(result["status"])
        self.assertIsNone(result["body"])
        self.assertEqual(result["bodyFailure"], "SQ1_HTTP_TIMEOUT")

    def test_real_delayed_body_preserves_received403(self):
        result = self.request("/slow-body", .12)
        self.assertEqual(result["status"], 403)
        self.assertIsNone(result["body"])
        self.assertEqual(result["bodyFailure"], "SQ1_HTTP_TIMEOUT")


class ReceiptBoundary(unittest.TestCase):
    setUp = PhaseContract.setUp
    hooks = PhaseContract.hooks
    phase = PhaseContract.phase

    def test_carried_main_receipt_is_strict_and_never_copies_untrusted_fields(self):
        self.phase("main")
        path = self.root / "main-result.json"
        original = json.loads(path.read_text())
        journal = s.Journal(self.root, self.scope)
        changes = [
            {"failure": PRIVATE}, {"mainFailure": PRIVATE}, {"residuals": [PRIVATE]},
            {"scopeSha256": "f" * 64}, {"operationId": str(uuid.uuid4())},
            {"rootIdentity": [0, 0]}, {"counts": {"cli": True, "https": 10, "cache": 1}},
            {"counts": {"cli": 0, "https": 0, "cache": 0}},
            {"signResult": {**original["signResult"], "failureCategory": PRIVATE}},
            {"signResult": {**original["signResult"], "errorInfo": [{"reason": PRIVATE}]}},
            {"processClosed": 1}, {"cleanupFailures": {"policyMutation": PRIVATE}},
        ]
        for change in changes:
            with self.subTest(fields=list(change)), self.assertRaises(s.Stop):
                s.validate_result({**original, **change}, journal, "main")
        path.write_bytes(wire({**original, "failure": PRIVATE,
                              "signResult": {**original["signResult"], "failureCategory": PRIVATE}}))
        result = self.phase("cleanup")
        self.assertEqual(result["status"], "SQ1_CONTAINMENT_UNCONFIRMED")
        self.assertIn("MAIN_RECEIPT_UNCONFIRMED", result["residuals"])
        self.assertIn("MAIN_PROCESS_CLOSEOUT_UNKNOWN", result["residuals"])
        self.assertIsNone(result["signResult"])
        self.assertNotIn(PRIVATE, json.dumps(result))
        self.assertTrue(result["policyAbsent"])
        self.assertTrue(result["identityDisabled"])


class ApprovalContract(unittest.TestCase):
    def setUp(self):
        ScopeContract.setUp(self)
    def refs(self):
        return {"scopeCommit": "b" * 40, "scopePath": "APP013_P08_SQ1_SCOPE_20261116_aaaaaaaa.json",
                "decisionCommit": "d" * 40, "decisionPath": "APP013_P08_SQ1_APPROVAL_20261116_aaaaaaaa.json"}

    def decision(self):
        return {"decision": s.DECISION, "scopeSha256": s.digest(self.scope),
                "operationId": self.scope["operationId"], "externalActionAuthorized": True,
                "independentCleanupAuthorized": True, "sdkException": s.SDK_EXCEPTION,
                "paymentAuthorized": False, "allowanceUsd": 0}

    def approve(self, decision):
        refs = self.refs()
        def read(repo, commit, path):
            self.assertEqual(repo, s.x.p.G)
            return wire(self.scope if path == refs["scopePath"] else decision)
        with patch.object(s, "source_guard", return_value=None), patch.object(s.x, "configuration", return_value=CONFIG):
            return s.approved_scope(refs, read_commit=read)

    def test_exact_separate_committed_authority_is_required(self):
        self.assertEqual(self.approve(self.decision()), self.scope)
        for key, value in (("externalActionAuthorized", False), ("externalActionAuthorized", 1),
                           ("independentCleanupAuthorized", False), ("independentCleanupAuthorized", 1),
                           ("paymentAuthorized", True), ("paymentAuthorized", 0),
                           ("allowanceUsd", False), ("scopeSha256", "f" * 64),
                           ("operationId", str(uuid.uuid4()))):
            changed = self.decision()
            changed[key] = value
            with self.subTest(key=key, value=value), self.assertRaises(Exception):
                self.approve(changed)

    def test_native_constructor_refuses_before_building_opener(self):
        with patch.object(s, "approved_scope", side_effect=s.Stop("SQ1_AUTHORITY")), \
             patch.object(s.urllib.request, "build_opener", side_effect=AssertionError("MUST_NOT_CONSTRUCT_NATIVE")) as opener:
            with self.assertRaises(s.Stop):
                s.NativeHooks(self.refs(), self.scope, "main")
            opener.assert_not_called()

    def test_untrusted_error_text_or_same_named_code_remains_unknown(self):
        self.assertEqual(s.safe_code(RuntimeError("HTTP_TIMEOUT")), "SQ1_UNKNOWN")
        self.assertEqual(s.safe_code(RuntimeError(PRIVATE)), "SQ1_UNKNOWN")
        self.assertEqual(s.safe_code(s.acl.Stop("HTTP_TIMEOUT")), "SQ1_HTTP_TIMEOUT")
        self.assertEqual(s.safe_code(s.q.model.Stop("PROCESS_TIMEOUT")), "SQ1_PROCESS_TIMEOUT")


class SdkWatchdog(unittest.TestCase):
    def test_sdk_mutations_and_unknown_read_vectors_are_rejected_before_spawn(self):
        vectors = [
            [s.q.GCLOUD, "iam", "service-accounts", "enable", s.m.IDENTITY],
            [s.q.GCLOUD, "iam", "service-accounts", "disable", s.m.IDENTITY],
            [s.q.GCLOUD, "iam", "service-accounts", "add-iam-policy-binding", s.m.IDENTITY],
            [s.q.GCLOUD, "auth", "login", s.m.OWNER],
            s.commands()["owner"] + ["--impersonate-service-account=foreign"],
        ]
        for vector in vectors:
            with self.subTest(vector=vector), self.assertRaises(Exception):
                s.sdk_command(vector, time.time() + 5)

    def test_same_process_watchdog_survives_sdk_sigalarm_replacement(self):
        with tempfile.TemporaryDirectory() as folder:
            fake = Path(folder) / "inert_sdk.py"
            fake.write_text("import signal,time\nsignal.signal(signal.SIGALRM,lambda *_:None)\nsignal.alarm(60)\ntime.sleep(60)\n")
            command = s.sdk_command(s.commands()["owner"], time.time() + 2.5)
            self.assertEqual(command[:3], [s.x.SANDBOX, "-p", s.x.PROFILE])
            self.assertIn(s.SDK_BOOTSTRAP, command)
            self.assertEqual(command.count(str(s.x.SDK)), 1)
            command[command.index(str(s.x.SDK))] = str(fake)
            started = time.monotonic()
            result = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                    stderr=subprocess.PIPE, timeout=4,
                                    env={"PATH": "/usr/bin:/bin", "LC_ALL": "C"}, start_new_session=True)
            self.assertEqual(result.returncode, 124, result.stderr.decode(errors="replace"))
            self.assertLess(time.monotonic() - started, 3)

    def test_sdk_watchdog_expires_after_owning_parent_is_sigkilled(self):
        with tempfile.TemporaryDirectory(prefix="sq1-watchdog-test-") as folder:
            fake = Path(folder) / "inert_sdk.py"
            fake.write_text("import os,signal,time\nsignal.signal(signal.SIGALRM,lambda *_:None)\nsignal.alarm(60)\nprint(os.getpid(),flush=True)\ntime.sleep(60)\n")
            command = s.sdk_command(s.commands()["owner"], time.time() + 4)
            self.assertEqual(command.count(str(s.x.SDK)), 1)
            self.assertIn(s.SDK_BOOTSTRAP, command)
            command[command.index(str(s.x.SDK))] = str(fake)
            owner = Path(folder) / "owner.py"
            owner.write_text("import subprocess,sys\np=subprocess.Popen(" + repr(command) +
                ",stdin=subprocess.DEVNULL,stdout=sys.stdout,stderr=sys.stderr,start_new_session=True,env={'PATH':'/usr/bin:/bin','LC_ALL':'C'})\np.wait()\n")
            process = subprocess.Popen([s.x.p.PYTHON, "-I", "-B", str(owner)],
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                start_new_session=True, env={"PATH": "/usr/bin:/bin", "LC_ALL": "C"})
            sdk_pid = None
            started = time.monotonic()
            try:
                with selectors.DefaultSelector() as selector:
                    selector.register(process.stdout, selectors.EVENT_READ)
                    self.assertTrue(selector.select(1.5), "Inert SDK did not signal owned startup")
                raw = process.stdout.readline().strip()
                self.assertTrue(raw.isdigit(), "Only the inert SDK PID is emitted")
                sdk_pid = int(raw)
                self.assertEqual(os.getpgid(sdk_pid), sdk_pid)
                process.kill()
                process.wait(timeout=1)
                stdout, error = process.communicate(timeout=4)
                self.assertEqual(stdout, b"")
                self.assertEqual(error, b"")
                until = time.monotonic() + 1
                while time.monotonic() < until:
                    try:
                        os.killpg(sdk_pid, 0)
                    except ProcessLookupError:
                        break
                    time.sleep(.01)
                with self.assertRaises(ProcessLookupError):
                    os.killpg(sdk_pid, 0)
                self.assertLess(time.monotonic() - started, 5)
            finally:
                if process.poll() is None:
                    process.kill()
                process.communicate(timeout=2)
                if sdk_pid is not None:
                    try:
                        os.killpg(sdk_pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass


def process_fixture(argv, control_path):
    """Run actual native phase/exec/supervision code with explicit fake authority/IO.

    Called only by the temporary child script built below. The simulator state
    lives outside the operation's receipt directory and contains synthetic data.
    """
    control = json.loads(Path(control_path).read_text())
    current = control["scope"]
    s.UID_SHA256 = current["uidSha256"]
    s.PROJECT_HASH = current["projectNumberSha256"]
    s.LEASE = control["lease"]
    s.approved_scope = lambda _refs: copy.deepcopy(current)
    s.source_guard = lambda _scope: None
    s.x.configuration = lambda: CONFIG
    original_command = s.phase_command
    actual_guard = s.NativeHooks.guard
    state_path, ledger = Path(control["state"]), Path(control["ledger"])
    checkpoint = Path(control["checkpoint"])

    def append(value):
        with ledger.open("a") as stream:
            stream.write(json.dumps(value) + "\n")

    class Stateful(Provider):
        def __init__(self, phase):
            super().__init__()
            self.phase = phase
            if state_path.exists():
                saved = json.loads(state_path.read_text())
                self.disabled, self.policy = saved["disabled"], saved["policy"]
            append({"phase": phase, "pid": os.getpid(), "event": "start"})

        def save(self):
            state_path.write_text(json.dumps({"disabled": self.disabled, "policy": self.policy}))

        def _owned_run(self, vector, env, deadline):
            name = self.command_name(vector)
            append({"phase": self.phase, "pid": os.getpid(), "event": name})
            if self.phase == "cleanup" and name == "owner" and control["scenario"] == "cleanup-term":
                checkpoint.write_text(json.dumps({"pid": os.getpid(), "phase": "cleanup"}))
                until = time.monotonic() + 4
                while not Path(control["release"]).exists() and time.monotonic() < until:
                    time.sleep(.01)
            return super()._owned_run(vector, env, deadline)

        def open(self, request, timeout=None):
            name = self.request_name(request)
            result = super().open(request, timeout)
            self.save()
            append({"phase": self.phase, "pid": os.getpid(), "event": name})
            if self.phase == "main" and name == "enable" and control["scenario"] in ("worker-kill", "supervisor-kill", "main-int", "main-term"):
                parent = os.getppid()
                checkpoint.write_text(json.dumps({"pid": os.getpid(), "parent": parent, "phase": "main"}))
                until = time.monotonic() + 4
                while time.monotonic() < until:
                    if control["scenario"] == "supervisor-kill" and os.getppid() != parent:
                        break
                    time.sleep(.01)
            return result

    class Hooks:
        def __init__(self, refs, scope, phase, *, parent=None):
            self.scope, self.phase, self.parent = scope, phase, parent
            self.clock, self.monotonic, self.sleep = time.time, time.monotonic, time.sleep
            self.provider = Stateful(phase)
            self.opener = self.provider

        def guard(self, value):
            return actual_guard(self, value)

        def configuration(self):
            return CONFIG

        def io_factory(self):
            return self.provider

        def cache_reader(self, end):
            return self.provider.cache_reader(end)

    def command(mode, envelope, held_fd=None):
        vector = original_command(mode, envelope, held_fd)
        assert vector.count(str(Path(s.__file__).resolve())) == 1
        vector[vector.index(str(Path(s.__file__).resolve()))] = control["fixture"]
        return vector

    s.NativeHooks = Hooks
    s.phase_command = command
    try:
        s.native_main(argv)
    except BaseException as error:
        append({"event": "fixture-stop", "code": s.safe_code(error), "pid": os.getpid()})
        raise


class ActualProcessBoundaries(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="sq1-process-test-")
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.scope = scope(time.time())
        self.root = Path(s.root_for(self.scope["operationId"]))
        self.assertFalse(self.root.exists())
        self.addCleanup(lambda: shutil.rmtree(self.root) if self.root.exists() else None)
        self.control = {"scope": self.scope,
                        **{name: str(self.directory / (name + ".json")) for name in
                           ("state", "ledger", "checkpoint", "release", "lease")},
                        "fixture": str(self.directory / "fixture.py")}
        self.control_path = self.directory / "control.json"
        fixture = "import sys,traceback\nsys.path.insert(0," + repr(str(Path(__file__).resolve().parent)) + ")\ntry:\n from test_sq1_signing_boundary import process_fixture\n process_fixture(sys.argv[1:]," + repr(str(self.control_path)) + ")\nexcept BaseException:\n with open(" + repr(str(self.directory / "fixture-error.txt")) + ", 'a') as stream: traceback.print_exc(file=stream)\n raise\n"
        Path(self.control["fixture"]).write_text(fixture)
        self.process = None

    def start(self, scenario):
        self.control["scenario"] = scenario
        self.control_path.write_text(json.dumps(self.control))
        self.process = subprocess.Popen([s.x.p.PYTHON, "-I", "-B", self.control["fixture"],
            "--run", "b" * 40, "APP013_P08_SQ1_SCOPE_20261116_aaaaaaaa.json",
            "d" * 40, "APP013_P08_SQ1_APPROVAL_20261116_aaaaaaaa.json"],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
            start_new_session=True, env={"HOME": "/Users/debynyhanbanks", "PATH": "/usr/bin:/bin", "LANG": "C"})
        def close():
            if self.process.poll() is None:
                self.process.terminate()
            Path(self.control["release"]).touch()
            try:
                self.process.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.communicate(timeout=2)
            ledger = Path(self.control["ledger"])
            if ledger.exists():
                owned = {row["pid"] for line in ledger.read_text().splitlines()
                         if (row := json.loads(line)).get("phase") in ("main", "cleanup")}
                for pid in owned:
                    # This test-only ledger identifies candidate PIDs; verify
                    # the unique synthetic program before any failure cleanup.
                    check = subprocess.run(["/bin/ps", "-p", str(pid), "-o", "command="],
                        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=2)
                    if self.control["fixture"].encode() in check.stdout:
                        try:
                            os.killpg(pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
        self.addCleanup(close)
        return self.process

    def test_signal_in_spawn_registration_gap_stops_worker_and_closes_fresh_root(self):
        self.control["scenario"] = "normal"
        self.control_path.write_text(json.dumps(self.control))
        refs = {"scopeCommit": "b" * 40, "scopePath": "APP013_P08_SQ1_SCOPE_20261116_aaaaaaaa.json",
                "decisionCommit": "d" * 40, "decisionPath": "APP013_P08_SQ1_APPROVAL_20261116_aaaaaaaa.json"}
        marker = self.directory / "must-not-dispatch"
        worker = [s.x.p.PYTHON, "-I", "-B", "-c",
                  "import time,pathlib;time.sleep(2);pathlib.Path(" + repr(str(marker)) + ").touch()"]
        def command(mode, envelope):
            if mode == "--worker":
                return worker
            vector = s.phase_command(mode, envelope)
            vector[vector.index(str(Path(s.__file__).resolve()))] = self.control["fixture"]
            return vector
        original_popen = subprocess.Popen
        created = []
        def spawning(vector, **kwargs):
            child = original_popen(vector, **kwargs)
            created.append(child)
            if vector == worker:
                # Deliver the signal after real spawn, before q.NativeIO adds
                # the exact Popen to its owned-child set.
                signal.getsignal(signal.SIGTERM)(signal.SIGTERM, None)
            return child
        with patch.object(s, "UID_SHA256", self.scope["uidSha256"]), \
             patch.object(s, "PROJECT_HASH", self.scope["projectNumberSha256"]):
            journal = s.Journal(self.root, self.scope, create=True)
            journal.put("envelope.json", refs)
            journal.put("launch.json", journal.base)
            transport = s.q.NativeIO(time.time, self.scope["operationId"])
            try:
                with patch.object(subprocess, "Popen", side_effect=spawning):
                    summary = s.supervise(self.scope, self.root / "envelope.json",
                        command_builder=command, io_factory=lambda: transport, clock=time.time,
                        guard=lambda _: None, configuration=lambda: CONFIG)
            finally:
                self.assertTrue(transport.close(time.time() + 3))
        self.assertFalse(marker.exists())
        self.assertTrue(summary["interrupted"])
        self.assertTrue(summary["supervisorOwnedProcessesClosed"])
        self.assertTrue(all(child.poll() is not None for child in created))
        self.assertTrue((self.root / "result.json").exists(), "Fresh-root independent cleanup must leave an honest safe result")
        result = json.loads((self.root / "result.json").read_text())
        self.assertIsNone(result["policyAbsent"])
        self.assertIsNone(result["identityDisabled"])
        self.assertIn("MAIN_PROCESS_CLOSEOUT_UNKNOWN", result["residuals"])
        self.assertEqual(result["counts"], {"cli": 0, "https": 0, "cache": 0})

    def wait_file(self, path, timeout=7):
        path = Path(path)
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            if path.exists():
                try:
                    return json.loads(path.read_text())
                except json.JSONDecodeError:
                    pass
            if self.process is not None and self.process.poll() not in (None, 0, -signal.SIGKILL):
                _, error = self.process.communicate(timeout=2)
                self.fail("Synthetic process exited before receipt: " + error.decode(errors="replace"))
            time.sleep(.01)
        error_path = self.directory / "fixture-error.txt"
        detail = error_path.read_text() if error_path.exists() else "No synthetic exception retained"
        self.fail("Timed out waiting for synthetic receipt " + path.name + ": " + detail)

    def completed(self):
        result = self.wait_file(self.root / "result.json")
        ledger = [json.loads(line) for line in Path(self.control["ledger"]).read_text().splitlines()]
        state = json.loads(Path(self.control["state"]).read_text())
        self.assertTrue(state["disabled"])
        self.assertFalse([row for row in state["policy"]["bindings"] if row["role"] == "projects/signmons/roles/signmonsP08ServiceAccountSignBlob"])
        for event in ("enable", "disable", "policy_add", "policy_remove", "sign"):
            self.assertLessEqual(sum(row.get("event") == event for row in ledger), 1)
        self.assertTrue(result["identityDisabled"])
        self.assertTrue(result["policyAbsent"])
        raw = "".join(path.read_text() for path in self.root.iterdir() if path.is_file())
        for sentinel in (TOKEN, UID, NUMBER, PRIVATE, SIGNATURE):
            self.assertNotIn(sentinel, raw)
        owned = {row["pid"] for row in ledger if row.get("phase") in ("main", "cleanup")}
        for pid in owned:
            until = time.monotonic() + 2
            while time.monotonic() < until:
                try:
                    os.kill(pid, 0)
                except ProcessLookupError:
                    break
                time.sleep(.01)
            with self.assertRaises(ProcessLookupError):
                os.kill(pid, 0)
        return result, ledger

    def test_actual_worker_execs_fresh_cleanup_with_same_owned_lease(self):
        process = self.start("normal")
        result, ledger = self.completed()
        process.communicate(timeout=5)
        self.assertEqual(process.returncode, 0)
        main_pid = next(row["pid"] for row in ledger if row.get("phase") == "main")
        cleanup_pid = next(row["pid"] for row in ledger if row.get("phase") == "cleanup")
        self.assertEqual(main_pid, cleanup_pid, "Cleanup must exec, dropping main raw memory while retaining the lease")
        self.assertEqual(result["status"], "SQ1_DIAGNOSTIC_CLOSED")

    def test_worker_sigkill_leaves_supervisor_owned_independent_cleanup(self):
        process = self.start("worker-kill")
        checkpoint = self.wait_file(self.control["checkpoint"])
        os.kill(checkpoint["pid"], signal.SIGKILL)
        result, ledger = self.completed()
        process.communicate(timeout=5)
        cleanup_pid = next(row["pid"] for row in ledger if row.get("phase") == "cleanup")
        self.assertNotEqual(cleanup_pid, checkpoint["pid"])
        self.assertTrue(result["residuals"])
        self.assertNotEqual(result["status"], "SQ1_DIAGNOSTIC_CLOSED")

    def test_supervisor_sigkill_leaves_worker_exec_cleanup_route(self):
        process = self.start("supervisor-kill")
        checkpoint = self.wait_file(self.control["checkpoint"])
        os.kill(process.pid, signal.SIGKILL)
        result, ledger = self.completed()
        process.communicate(timeout=5)
        cleanup_pid = next(row["pid"] for row in ledger if row.get("phase") == "cleanup")
        self.assertEqual(cleanup_pid, checkpoint["pid"])
        self.assertTrue(result["residuals"])

    def test_main_sigint_stops_following_main_dispatch_and_restores(self):
        self.start("main-int")
        checkpoint = self.wait_file(self.control["checkpoint"])
        os.kill(checkpoint["pid"], signal.SIGINT)
        result, ledger = self.completed()
        self.assertFalse([row for row in ledger if row.get("event") == "sign"])
        self.assertTrue(result["residuals"])

    def test_main_sigterm_stops_following_main_dispatch_and_restores(self):
        self.start("main-term")
        checkpoint = self.wait_file(self.control["checkpoint"])
        os.kill(checkpoint["pid"], signal.SIGTERM)
        result, ledger = self.completed()
        self.assertFalse([row for row in ledger if row.get("event") == "sign"])
        self.assertTrue(result["residuals"])

    def test_cleanup_sigterm_does_not_skip_authorized_restoration(self):
        self.start("cleanup-term")
        checkpoint = self.wait_file(self.control["checkpoint"])
        self.assertEqual(checkpoint["phase"], "cleanup")
        os.kill(checkpoint["pid"], signal.SIGTERM)
        Path(self.control["release"]).touch()
        result, ledger = self.completed()
        self.assertTrue(result["identityDisabled"])
        self.assertTrue(result["policyAbsent"])
        self.assertTrue([row for row in ledger if row.get("event") == "disable"])
