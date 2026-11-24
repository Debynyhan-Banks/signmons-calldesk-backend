"""VM2 synthetic contract tests; no real SDK, provider or credential-store calls."""
import copy
import contextlib
import datetime
import importlib.util
import inspect
import io
import json
import os
from pathlib import Path
import signal
import socket
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import uuid
from types import SimpleNamespace
from unittest.mock import patch

import vm2_metadata_read as v


NUMBER = "123456789012"
PRIVATE = "VM2_PRIVATE_RESPONSE_SENTINEL"
TOKEN = "VM2_PRIVATE_TOKEN_SENTINEL_" * 3
CONFIG = "a" * 64
ERROR_TYPE = "type.googleapis.com/google.rpc.ErrorInfo"


def wire(value):
    return json.dumps(value, separators=(",", ":")).encode()


def metadata(state="DISABLED", number=NUMBER):
    return {"name": "projects/" + number +
            "/secrets/signmons-staging-p07-payment-database-url/versions/1",
            "state": state}


def denial(status=403, label="PERMISSION_DENIED", reason="IAM_PERMISSION_DENIED",
           domain="iam.googleapis.com"):
    return {"error": {"code": status, "status": label, "message": PRIVATE,
                      "details": [{"@type": ERROR_TYPE, "reason": reason,
                                   "domain": domain,
                                   "metadata": {
                                       "permission": "secretmanager.versions.get",
                                       "service": "secretmanager.googleapis.com",
                                       "consumer": "projects/" + NUMBER,
                                       "target": metadata()["name"],
                                       "private": PRIVATE}}]}}


class Clock:
    def __init__(self):
        self.now = 1795521600.0

    def __call__(self):
        return self.now


class Response(io.BytesIO):
    def __init__(self, value=None, *, status=200, raw=None, chunk_size=None,
                 read_error=None, close_error=None, on_read=None):
        super().__init__(wire(metadata() if value is None else value) if raw is None else raw)
        self.status = status
        self.chunk_size = chunk_size
        self.read_error = read_error
        self.close_error = close_error
        self.on_read = on_read
        self.read_count = 0
        self.close_count = 0

    def read(self, size=-1):
        self.read_count += 1
        if self.on_read:
            self.on_read(self.read_count)
        if self.read_error:
            raise self.read_error
        if self.chunk_size is not None:
            size = self.chunk_size if size < 0 else min(size, self.chunk_size)
        return super().read(size)

    def close(self):
        self.close_count += 1
        super().close()
        if self.close_error:
            raise self.close_error


class Opener:
    def __init__(self, response=None, *, error=None, http_error=False):
        self.response = response if response is not None else Response()
        self.error = error
        self.http_error = http_error
        self.calls = []

    def open(self, request, timeout=None):
        self.calls.append((request, timeout))
        if self.error:
            raise self.error
        if self.http_error:
            raise urllib.error.HTTPError(request.full_url, self.response.status,
                                         PRIVATE, {}, self.response)
        return self.response


def scope(now):
    def stamp(offset):
        return datetime.datetime.fromtimestamp(now + offset, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {"version": 1, "action": v.ACTION, "operationId": str(uuid.uuid4()),
            "sourceCommit": "b" * 40, "manifestSha256": "c" * 64,
            "configSha256": CONFIG, "projectNumberSha256": v.m.digest(NUMBER),
            "commands": v.commands(), "limits": dict(v.LIMITS),
            "sdkException": v.SDK_EXCEPTION, "allowanceUsd": 0,
            "automaticRetryAllowed": False,
            "window": {key: stamp(offset) for key, offset in (
                ("start", -1), ("cutoff", 60), ("readEnd", 150), ("closeoutEnd", 270))}}


class FakeIO:
    def __init__(self):
        self.commands = []
        self.close_calls = []
        self.absence_calls = []
        self.command_hook = None
        self.close_result = True
        self.absence_result = True

    def _owned_run(self, argv, env, deadline):
        name = next(row["id"] for row in v.commands() if row["argv"] == list(argv))
        self.commands.append(name)
        if self.command_hook:
            result = self.command_hook(name)
            if result is not None:
                return result
        return wire([{"account": v.m.OWNER, "status": "ACTIVE"}]) if name == "owner" else wire(
            {"projectId": "signmons", "projectNumber": NUMBER, "lifecycleState": "ACTIVE"})

    def close(self, deadline):
        self.close_calls.append(deadline)
        if isinstance(self.close_result, BaseException):
            raise self.close_result
        return self.close_result

    def verify_absent(self, deadline):
        self.absence_calls.append(deadline)
        if isinstance(self.absence_result, BaseException):
            raise self.absence_result
        return self.absence_result


class Harness:
    def __init__(self, clock):
        self.clock = clock
        self.io = FakeIO()
        self.opener = Opener()
        self.factories = 0
        self.cache_calls = []
        self.cache_hook = None
        self.guard_hook = None
        self.guard_calls = 0
        self.config_hook = None
        self.config_calls = 0

    def io_factory(self):
        self.factories += 1
        return self.io

    def cache_reader(self, deadline):
        self.cache_calls.append(deadline)
        return self.cache_hook(deadline) if self.cache_hook else TOKEN

    def guard(self, candidate):
        self.guard_calls += 1
        if self.guard_hook:
            self.guard_hook(candidate, self.guard_calls)

    def configuration(self):
        self.config_calls += 1
        return self.config_hook(self.config_calls) if self.config_hook else CONFIG


class Fixture(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.scope = scope(self.clock())
        project = patch.object(v.q, "PROJECT_NUMBER_SHA256", self.scope["projectNumberSha256"])
        environment = patch.dict(os.environ, {"HOME": "/Users/debynyhanbanks"}, clear=True)
        for item in (project, environment):
            item.start()
            self.addCleanup(item.stop)
        self.tmp = tempfile.TemporaryDirectory(prefix="p08-vm2-synthetic-", dir="/private/tmp")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "operation"
        self.hooks = Harness(self.clock)

    def assert_private_absent(self, value):
        encoded = json.dumps(value, sort_keys=True)
        for private in (PRIVATE, TOKEN, NUMBER, metadata()["name"]):
            self.assertNotIn(private, encoded)

    def run_operation(self):
        result = v.run(self.scope, hooks=self.hooks, root=self.root)
        self.assert_private_absent(result)
        for path in self.root.iterdir():
            self.assert_private_absent(json.loads(path.read_bytes()))
        return result

    def native_hooks(self):
        refs = {"commit": "d" * 40, "scope_path": "APP013_P08_VM2_SCOPE_20261124_12345678.json",
                "decision_path": "APP013_P08_VM2_APPROVAL_20261124_12345678.json"}
        with patch.object(v, "authorize", return_value=self.scope):
            return v.NativeHooks(self.scope, refs=refs)


class ScopeContract(Fixture):
    def test_exact_scope_and_existing_owner_project_descriptors(self):
        self.assertEqual(v.validate_scope(self.scope, self.clock())["readEnd"], self.clock() + 150)
        expected = [next(row for row in v.q.cli_contract() if row["id"] == name)
                    for name in ("owner", "project")]
        self.assertEqual(v.commands(), json.loads(json.dumps(expected)))
        self.assertEqual(self.scope["limits"], {"cli": 2, "cache": 1, "https": 1, "sql": 0, "mutations": 0})

    def test_scope_rejects_extra_fields_types_identity_limits_and_mutated_commands(self):
        changes = [{"extra": True}, {"version": True}, {"action": "OTHER"},
                   {"operationId": "foreign"}, {"sourceCommit": ""},
                   {"manifestSha256": None}, {"projectNumberSha256": "f" * 64},
                   {"sdkException": "OTHER"}, {"allowanceUsd": True},
                   {"automaticRetryAllowed": True}, {"commands": []}]
        changes += [{"limits": {**v.LIMITS, key: replacement}} for key in v.LIMITS
                    for replacement in (True, -1, v.LIMITS[key] + 1)]
        for change in changes:
            with self.subTest(change=change), self.assertRaises(Exception):
                v.validate_scope({**self.scope, **change}, self.clock())

    def test_early_late_and_insufficient_cleanup_windows_refuse(self):
        for now in (self.clock() - 2, self.clock() + 60, self.clock() + 270):
            with self.subTest(now=now), self.assertRaises(Exception):
                v.validate_scope(self.scope, now)
        for key, prior in (("readEnd", "cutoff"), ("closeoutEnd", "readEnd")):
            changed = copy.deepcopy(self.scope)
            changed["window"][key] = changed["window"][prior]
            with self.subTest(key=key), self.assertRaises(Exception):
                v.validate_scope(changed, self.clock())
        v.validate_scope(self.scope, self.clock() + 60, starting=False)
        with self.assertRaises(Exception):
            v.validate_scope(self.scope, self.clock() + 150, starting=False)

    def test_preflight_source_and_configuration_refuse_before_factory_or_reservation(self):
        for cause in ("source", "configuration"):
            h = Harness(self.clock)
            if cause == "source":
                h.guard_hook = lambda *_: (_ for _ in ()).throw(v.Stop("VM2_SOURCE"))
            else:
                h.config_hook = lambda _: "f" * 64
            with self.subTest(cause=cause), self.assertRaises(v.Stop):
                v.run(self.scope, hooks=h, root=self.root)
            self.assertEqual(h.factories, 0)
            self.assertFalse(self.root.exists())
            self.assertFalse(h.cache_calls or h.opener.calls)

    def test_preflight_rechecks_cutoff_after_source_inspection(self):
        def late(_):
            self.clock.now += 60
        with self.assertRaisesRegex(v.Stop, "VM2_CUTOFF"):
            v.preflight(self.scope, self.clock, guard=late, configuration=lambda: CONFIG)


class SafeProjection(Fixture):
    def project(self, status, value):
        result = v.classify_metadata(status, value if isinstance(value, bytes) else wire(value), NUMBER)
        self.assert_private_absent(result)
        self.assertEqual(set(result), {"httpStatus", "outcome", "state", "resourceMatched",
                                      "failureCategory", "errorStatus", "errorCode", "errorInfo",
                                      "errorEnvelopeValid"})
        return result

    def test_each_documented_state_retains_only_safe_metadata(self):
        for state in ("ENABLED", "DISABLED", "DESTROYED"):
            with self.subTest(state=state):
                result = self.project(200, metadata(state))
                self.assertEqual(result["outcome"], "METADATA_OBSERVED")
                self.assertEqual(result["state"], state)
                self.assertTrue(result["resourceMatched"])
                self.assertIsNone(result["failureCategory"])

    def test_foreign_missing_null_typed_or_extra_metadata_never_qualifies(self):
        values = [{}, None, [], metadata(number="654321098765"),
                  {"name": metadata()["name"]}, {"state": "DISABLED"},
                  {**metadata(), "private": PRIVATE}]
        for field in ("name", "state"):
            values += [{**metadata(), field: value} for value in (None, True, 0, [], {}, "", PRIVATE)]
        for value in values:
            with self.subTest(value=value):
                result = self.project(200, value)
                self.assertEqual(result["state"], "UNKNOWN")
                self.assertEqual(result["outcome"], "UNKNOWN")
                self.assertFalse(result["resourceMatched"])

    def test_malformed_duplicate_nonfinite_deep_utf8_and_oversized_json_fail_closed(self):
        raw = wire(metadata())
        cases = [b"", b"null", b"[]", b"true", b"42", b"\xff", b"{" + PRIVATE.encode(),
                 raw[:-1] + b',"state":"ENABLED"}', b'{"state":NaN}',
                 b'{"state":Infinity}', b"[" * 30 + b"]" * 30, b"x" * 65537]
        for body in cases:
            with self.subTest(length=len(body)):
                result = self.project(200, body)
                self.assertEqual(result["outcome"], "UNKNOWN")
                self.assertFalse(result["resourceMatched"])

    def test_safe_http_errors_preserve_status_without_claiming_resource_absence(self):
        for status, label in ((401, "UNAUTHENTICATED"), (403, "PERMISSION_DENIED"),
                              (404, "NOT_FOUND"), (429, "RESOURCE_EXHAUSTED"),
                              (500, "INTERNAL"), (503, "UNAVAILABLE")):
            with self.subTest(status=status):
                result = self.project(status, denial(status, label))
                self.assertEqual(result["httpStatus"], status)
                self.assertEqual(result["errorCode"], status)
                self.assertEqual(result["errorStatus"], label)
                self.assertTrue(result["errorEnvelopeValid"])
                self.assertEqual(result["state"], "UNKNOWN")
                self.assertFalse(result["resourceMatched"])

    def test_allowed_reasons_and_metadata_equality_flags_exclude_values(self):
        for reason in ("IAM_PERMISSION_DENIED", "SERVICE_DISABLED", "ACCESS_TOKEN_SCOPE_INSUFFICIENT"):
            result = self.project(403, denial(reason=reason, domain="googleapis.com"))
            self.assertEqual(result["errorInfo"][0]["reason"], reason)
            self.assertEqual(result["errorInfo"][0]["metadataMatches"], {
                "permission": "MATCH", "service": "MATCH", "consumer": "MATCH", "target": "MATCH"})
        changed = denial()
        changed["error"]["details"][0]["metadata"]["target"] = PRIVATE
        changed["error"]["details"][0]["metadata"].pop("consumer")
        result = self.project(403, changed)
        self.assertEqual(result["errorInfo"][0]["metadataMatches"]["target"], "MISMATCH")
        self.assertEqual(result["errorInfo"][0]["metadataMatches"]["consumer"], "UNKNOWN")

    def test_documented_google_reason_labels_are_retained_without_shared_changes(self):
        # Public google/api/error_reason.proto snapshot reviewed 2026-11-24.
        documented = set(('SERVICE_DISABLED BILLING_DISABLED API_KEY_INVALID API_KEY_SERVICE_BLOCKED '
            'API_KEY_HTTP_REFERRER_BLOCKED API_KEY_IP_ADDRESS_BLOCKED API_KEY_ANDROID_APP_BLOCKED '
            'API_KEY_IOS_APP_BLOCKED RATE_LIMIT_EXCEEDED RESOURCE_QUOTA_EXCEEDED LOCATION_TAX_POLICY_VIOLATED '
            'USER_PROJECT_DENIED CONSUMER_SUSPENDED CONSUMER_INVALID SECURITY_POLICY_VIOLATED '
            'ACCESS_TOKEN_EXPIRED ACCESS_TOKEN_SCOPE_INSUFFICIENT ACCOUNT_STATE_INVALID '
            'ACCESS_TOKEN_TYPE_UNSUPPORTED CREDENTIALS_MISSING RESOURCE_PROJECT_INVALID SESSION_COOKIE_INVALID '
            'USER_BLOCKED_BY_ADMIN RESOURCE_USAGE_RESTRICTION_VIOLATED SYSTEM_PARAMETER_UNSUPPORTED '
            'ORG_RESTRICTION_VIOLATION ORG_RESTRICTION_HEADER_INVALID SERVICE_NOT_VISIBLE GCP_SUSPENDED '
            'LOCATION_POLICY_VIOLATED MISSING_ORIGIN OVERLOADED_CREDENTIALS LOCATION_ORG_POLICY_VIOLATED '
            'TLS_ORG_POLICY_VIOLATED EMULATOR_QUOTA_EXCEEDED CREDENTIAL_ANDROID_APP_INVALID '
            'IAM_PERMISSION_DENIED JWT_TOKEN_INVALID CREDENTIAL_TYPE_UNSUPPORTED ACCOUNT_TYPE_UNSUPPORTED '
            'ENDPOINT_USAGE_RESTRICTION_VIOLATED TLS_CIPHER_RESTRICTION_VIOLATED MCP_SERVER_DISABLED').split())
        self.assertEqual(len(documented), 43)
        self.assertEqual(v.GOOGLE_ERROR_REASONS, documented)
        reasons, domains = v.sq.REASONS, v.sq.DOMAINS
        for reason in sorted(documented):
            with self.subTest(reason=reason):
                result = self.project(403, denial(reason=reason, domain="googleapis.com"))
                self.assertEqual(result["outcome"], "REFUSED")
                self.assertEqual(result["errorInfo"][0]["reason"], reason)
                self.assertEqual(result["errorInfo"][0]["domain"], "googleapis.com")
                self.assertTrue(result["errorEnvelopeValid"])
                self.assertEqual(result["state"], "UNKNOWN")
                self.assertFalse(result["resourceMatched"])
        self.assertIs(v.sq.REASONS, reasons)
        self.assertIs(v.sq.DOMAINS, domains)
        shared = v.sq.classify_sign_response(403, wire(denial(reason="BILLING_DISABLED", domain="googleapis.com")))
        self.assertEqual(shared["errorInfo"][0]["reason"], "UNKNOWN")

    def test_added_google_reasons_require_exact_domain_and_default_stays_unknown(self):
        for reason in sorted(v.GOOGLE_ERROR_REASONS - v.sq.REASONS):
            for domain in ("iam.googleapis.com", "Googleapis.com", "googleapis.com/policies/endpointUsageRestriction",
                           "googleapis.com/policies/tlsCipherRestriction", PRIVATE):
                with self.subTest(reason=reason, domain=domain):
                    result = self.project(403, denial(reason=reason, domain=domain))
                    self.assertEqual(result["outcome"], "UNKNOWN")
                    self.assertEqual(result["errorInfo"][0]["reason"], "UNKNOWN")
        for reason in ("ERROR_REASON_UNSPECIFIED", "BILLING_DISABLED_PRIVATE", "billing_disabled", PRIVATE):
            result = self.project(403, denial(reason=reason, domain="googleapis.com"))
            self.assertEqual(result["outcome"], "UNKNOWN")
            self.assertEqual(result["errorInfo"][0]["reason"], "UNKNOWN")

    def test_new_reason_with_supplemental_or_unknown_details_stays_unknown(self):
        for extra in ({"@type": "type.googleapis.com/google.rpc.Help", "links": [{"url": PRIVATE}]},
                      {"@type": "type.googleapis.com/google.rpc.LocalizedMessage", "message": PRIVATE},
                      denial(reason=PRIVATE, domain="googleapis.com")["error"]["details"][0]):
            body = denial(reason="BILLING_DISABLED", domain="googleapis.com")
            body["error"]["details"].append(extra)
            result = self.project(403, body)
            self.assertEqual(result["outcome"], "UNKNOWN")
            self.assertEqual([row["reason"] for row in result["errorInfo"]], ["BILLING_DISABLED", "UNKNOWN"])

    def test_new_old_and_already_collapsed_conflicts_cannot_be_remapped(self):
        cases = (("BILLING_DISABLED", "USER_PROJECT_DENIED"),
                 ("BILLING_DISABLED", "IAM_PERMISSION_DENIED"),
                 ("IAM_PERMISSION_DENIED", "SERVICE_DISABLED", "BILLING_DISABLED"))
        for reasons in cases:
            for order in (reasons, tuple(reversed(reasons))):
                with self.subTest(reasons=order):
                    body = denial(reason=order[0], domain="googleapis.com")
                    for reason in order[1:]:
                        body["error"]["details"] += denial(reason=reason, domain="googleapis.com")["error"]["details"]
                    result = self.project(403, body)
                    self.assertEqual(result["outcome"], "UNKNOWN")
                    self.assertEqual(result["errorInfo"], [{"reason": "UNKNOWN", "domain": "UNKNOWN",
                        "metadataMatches": {key: "UNKNOWN" for key in ("permission", "service", "consumer", "target")}}])

    def test_matching_new_reasons_preserve_row_metadata_flags(self):
        body = denial(reason="BILLING_DISABLED", domain="googleapis.com")
        second = copy.deepcopy(body["error"]["details"][0])
        second["metadata"]["target"] = PRIVATE
        second["metadata"].pop("consumer")
        body["error"]["details"].append(second)
        result = self.project(403, body)
        self.assertEqual(result["outcome"], "REFUSED")
        self.assertEqual([row["reason"] for row in result["errorInfo"]], ["BILLING_DISABLED"] * 2)
        self.assertEqual(result["errorInfo"][0]["metadataMatches"]["target"], "MATCH")
        self.assertEqual(result["errorInfo"][1]["metadataMatches"]["target"], "MISMATCH")
        self.assertEqual(result["errorInfo"][1]["metadataMatches"]["consumer"], "UNKNOWN")

    def test_unknown_or_conflicting_error_reasons_cannot_become_precise_diagnosis(self):
        conflicting = denial()
        conflicting["error"]["details"] += denial(reason="SERVICE_DISABLED")["error"]["details"]
        for body in (denial(reason=PRIVATE), denial(domain=PRIVATE), conflicting):
            with self.subTest(body=body):
                result = self.project(403, body)
                self.assertEqual(result["outcome"], "UNKNOWN")

    def test_invalid_error_code_or_status_and_extra_fields_are_never_retained(self):
        for field, replacement in [("code", True), ("code", 403.0), ("code", "403"),
                                   ("code", 200), ("status", PRIVATE), ("private", PRIVATE)]:
            body = denial()
            body["error"][field] = replacement
            with self.subTest(field=field, replacement=replacement):
                result = self.project(403, body)
                self.assertEqual(result["outcome"], "UNKNOWN")

    def test_redirect_unexpected_success_and_invalid_http_status_fail_closed(self):
        for status in (True, None, "200", 99, 600, 201, 204, 301, 302, 307, 308):
            with self.subTest(status=status):
                result = self.project(status, metadata())
                self.assertEqual(result["outcome"], "UNKNOWN")
                self.assertFalse(result["resourceMatched"])

    def test_malformed_error_details_cannot_validate_envelope(self):
        values = [None, PRIVATE, [None], [PRIVATE], [1], [True], [{}] * 33,
                  [{"@type": ERROR_TYPE, "reason": "IAM_PERMISSION_DENIED",
                    "domain": "googleapis.com", "metadata": None}],
                  [{"@type": ERROR_TYPE, "reason": "IAM_PERMISSION_DENIED",
                    "domain": "googleapis.com", "metadata": {"permission": 403}}]]
        for details in values:
            body = {"error": {"code": 403, "status": "PERMISSION_DENIED", "details": details}}
            with self.subTest(details=details):
                result = self.project(403, body)
                self.assertFalse(result["errorEnvelopeValid"])
                self.assertEqual(result["outcome"], "UNKNOWN")

    def test_valid_typed_error_without_details_does_not_invent_reason(self):
        for status, label in ((403, "PERMISSION_DENIED"), (404, "NOT_FOUND")):
            result = self.project(status, {"error": {"code": status, "status": label}})
            self.assertTrue(result["errorEnvelopeValid"])
            self.assertEqual(result["errorInfo"], [])
            self.assertEqual(result["state"], "UNKNOWN")


class BoundedTransport(Fixture):
    def request(self, opener, token=TOKEN, deadline=None):
        result = v.bounded_metadata_request(NUMBER, token, self.clock() + 20 if deadline is None else deadline,
                                            clock=self.clock, opener=opener)
        self.assert_private_absent(result)
        self.assertLessEqual(len(opener.calls), 1)
        return result

    def test_exact_metadata_get_no_payload_access_and_partial_reads_close(self):
        response = Response(chunk_size=3)
        opener = Opener(response)
        result = self.request(opener)
        request, timeout = opener.calls[0]
        self.assertEqual(request.full_url, "https://secretmanager.googleapis.com/v1/" + metadata()["name"] + "?fields=name,state")
        self.assertEqual(request.get_method(), "GET")
        self.assertIsNone(request.data)
        self.assertNotIn(":access", request.full_url)
        self.assertEqual(request.get_header("Authorization"), "Bearer " + TOKEN)
        self.assertEqual(timeout, 8)
        self.assertGreater(response.read_count, 1)
        self.assertEqual(response.close_count, 1)
        self.assertTrue(result["responseClosed"])
        self.assertEqual(result["outcome"], "METADATA_OBSERVED")

    def test_no_redirect_handler_and_proxy_override(self):
        with patch.object(v.urllib.request, "build_opener") as build:
            self.native_hooks()
        args = build.call_args.args
        self.assertEqual(args[0].proxies, {})
        self.assertIsInstance(args[1], v.sq.NoRedirect)
        self.assertIsNone(args[1].redirect_request(None, None, 302, "redirect", {}, "https://foreign.invalid"))
        for status in (301, 302, 307, 308):
            response = Response(status=status)
            result = self.request(Opener(response))
            self.assertEqual(result["outcome"], "UNKNOWN")
            self.assertTrue(response.closed)
            self.assertEqual(response.read_count, 0)

    def test_http_error_body_is_projected_once_and_closed(self):
        response = Response(denial(), status=403)
        result = self.request(Opener(response, http_error=True))
        self.assertEqual(result["errorStatus"], "PERMISSION_DENIED")
        self.assertTrue(response.closed)
        self.assertTrue(result["responseClosed"])

    def test_new_google_reason_through_actual_http_error_transport(self):
        for reason in ("BILLING_DISABLED", "USER_PROJECT_DENIED"):
            response = Response(denial(reason=reason, domain="googleapis.com"), status=403, chunk_size=7)
            opener = Opener(response, http_error=True)
            result = self.request(opener)
            self.assertEqual(result["errorInfo"][0]["reason"], reason)
            self.assertEqual(result["outcome"], "REFUSED")
            self.assertEqual(result["errorStatus"], "PERMISSION_DENIED")
            self.assertIsNone(result["failure"])
            self.assertTrue(result["responseClosed"])
            self.assertEqual(response.close_count, 1)
            self.assertEqual(len(opener.calls), 1)

    def test_unsafe_tokens_and_foreign_project_refuse_before_open(self):
        for token in (None, "", "short", TOKEN + "\n", TOKEN + " ", TOKEN + "\x00", TOKEN + "é"):
            opener = Opener()
            with self.subTest(token_type=type(token).__name__), self.assertRaises(Exception):
                self.request(opener, token)
            self.assertFalse(opener.calls)
        opener = Opener()
        with self.assertRaises(Exception):
            v.bounded_metadata_request("654321098765", TOKEN, self.clock() + 20, clock=self.clock, opener=opener)
        self.assertFalse(opener.calls)

    def test_oversized_wrong_type_partial_failure_and_timeout_never_retry(self):
        class WrongType(Response):
            def read(self, size=-1):
                return PRIVATE
        for response in (Response(raw=b"x" * 65537), WrongType(),
                         Response(read_error=TimeoutError(PRIVATE)),
                         Response(read_error=OSError(PRIVATE))):
            with self.subTest(response=type(response).__name__):
                result = self.request(Opener(response))
                self.assertEqual(result["outcome"], "UNKNOWN")
                self.assertIsNotNone(result["failure"])
                self.assertTrue(result["responseClosed"])
        opener = Opener(error=TimeoutError(PRIVATE))
        result = self.request(opener)
        self.assertEqual(result["outcome"], "UNKNOWN")
        self.assertEqual(len(opener.calls), 1)

    def test_deadline_expiry_during_stream_and_before_open(self):
        response = Response(chunk_size=3, on_read=lambda _: setattr(self.clock, "now", self.clock() + 21))
        result = self.request(Opener(response))
        self.assertEqual(result["outcome"], "UNKNOWN")
        self.assertTrue(response.closed)
        opener = Opener()
        with self.assertRaises(Exception):
            self.request(opener, deadline=self.clock())
        self.assertFalse(opener.calls)

    def test_real_deadline_interrupts_blocked_injected_opener(self):
        class Blocked:
            calls = 0
            def open(self, request, timeout=None):
                self.calls += 1
                time.sleep(1)
                raise AssertionError("deadline did not interrupt synthetic wait")
        opener = Blocked()
        started = time.monotonic()
        result = v.bounded_metadata_request(NUMBER, TOKEN, time.time() + .05, clock=time.time, opener=opener)
        self.assertLess(time.monotonic() - started, .5)
        self.assertEqual(opener.calls, 1)
        self.assertEqual(result["outcome"], "UNKNOWN")
        self.assert_private_absent(result)

    def test_close_failure_cannot_leave_success_classification(self):
        result = self.request(Opener(Response(close_error=OSError(PRIVATE))))
        self.assertFalse(result["responseClosed"])
        self.assertEqual(result["outcome"], "UNKNOWN")
        self.assertEqual(result["state"], "UNKNOWN")
        self.assertEqual(result["failure"], "VM2_RESPONSE_CLOSE")


class Orchestration(Fixture):
    def test_success_one_reservation_each_and_private_data_never_persisted(self):
        result = self.run_operation()
        self.assertEqual(result["status"], "METADATA_DIAGNOSED")
        self.assertEqual(result["counts"], {"cli": 2, "cache": 1, "https": 1})
        self.assertEqual(self.hooks.io.commands, ["owner", "project"])
        self.assertEqual(self.hooks.cache_calls, [self.clock() + 270])
        self.assertEqual(len(self.hooks.opener.calls), 1)
        self.assertTrue(all(result["closeout"].values()))
        self.assertEqual(result["residuals"], [])
        self.assertFalse(result["paymentAttempted"])
        self.assertEqual({p.name for p in self.root.iterdir()}, {
            "attempt.json", "owner.json", "project.json", "cache.json", "metadata.json", "closeout.json", "result.json"})

    def test_provider_reported_denial_is_diagnosis_without_success_or_absence_claim(self):
        self.hooks.opener = Opener(Response(denial(404, "NOT_FOUND"), status=404))
        result = self.run_operation()
        self.assertEqual(result["status"], "METADATA_DIAGNOSED")
        self.assertEqual(result["metadata"]["errorStatus"], "NOT_FOUND")
        self.assertFalse(result["metadata"]["resourceMatched"])
        self.assertEqual(result["metadata"]["state"], "UNKNOWN")

    def test_new_reason_http_error_receipts_readback_and_independent_closeout(self):
        for index, supplemental in enumerate((False, True)):
            self.root = Path(self.tmp.name) / str(index)
            self.hooks = Harness(self.clock)
            body = denial(reason="BILLING_DISABLED", domain="googleapis.com")
            if supplemental:
                body["error"]["details"].append({"@type": "type.googleapis.com/google.rpc.Help",
                                                 "links": [{"description": PRIVATE, "url": PRIVATE}]})
            response = Response(body, status=403)
            self.hooks.opener = Opener(response, http_error=True)
            result = self.run_operation()
            self.assertEqual(result["status"], "METADATA_DIAGNOSED")
            self.assertEqual(result["metadata"]["errorInfo"][0]["reason"], "BILLING_DISABLED")
            self.assertEqual(result["metadata"]["outcome"], "UNKNOWN" if supplemental else "REFUSED")
            self.assertEqual(result["metadata"]["state"], "UNKNOWN")
            self.assertFalse(result["metadata"]["resourceMatched"])
            self.assertEqual(result["counts"], {"cli": 2, "cache": 1, "https": 1})
            self.assertEqual(self.hooks.io.commands, ["owner", "project"])
            self.assertEqual(len(self.hooks.cache_calls), 1)
            self.assertEqual(len(self.hooks.opener.calls), 1)
            self.assertEqual(response.close_count, 1)
            self.assertEqual(len(self.hooks.io.close_calls), 1)
            self.assertEqual(len(self.hooks.io.absence_calls), 1)
            self.assertTrue(all(result["closeout"].values()))
            self.assertEqual(result["residuals"], [])
            retained = v.read_result(self.root, result["resultSha256"])
            self.assertEqual(retained, result)
            self.assert_private_absent(retained)
            self.assertFalse(retained["paymentAttempted"])

    def test_invalid_error_envelope_never_reports_diagnosed(self):
        for index, details in enumerate((PRIVATE, [None], [{"@type": ERROR_TYPE,
                "reason": "IAM_PERMISSION_DENIED", "domain": "googleapis.com", "metadata": None}])):
            self.root = Path(self.tmp.name) / str(index)
            self.hooks = Harness(self.clock)
            self.hooks.opener = Opener(Response({"error": {"code": 403, "status": "PERMISSION_DENIED",
                                                         "details": details}}, status=403))
            result = self.run_operation()
            self.assertEqual(result["status"], "UNKNOWN")
            self.assertFalse(result["metadata"]["errorEnvelopeValid"])
            self.assertEqual(result["counts"], {"cli": 2, "cache": 1, "https": 1})

    def test_valid_status_only_error_is_diagnosed_without_detail_claim(self):
        self.hooks.opener = Opener(Response({"error": {"code": 403, "status": "PERMISSION_DENIED"}}, status=403))
        result = self.run_operation()
        self.assertEqual(result["status"], "METADATA_DIAGNOSED")
        self.assertEqual(result["metadata"]["errorInfo"], [])
        self.assertFalse(result["metadata"]["resourceMatched"])

    def test_foreign_owner_stops_before_project_cache_and_request(self):
        self.hooks.io.command_hook = lambda _: wire([{"account": PRIVATE, "status": "ACTIVE"}])
        result = self.run_operation()
        self.assertEqual(result["failure"], "VM2_OWNER")
        self.assertEqual(self.hooks.io.commands, ["owner"])
        self.assertFalse(self.hooks.cache_calls or self.hooks.opener.calls)
        self.assertEqual(len(self.hooks.io.close_calls), 1)
        self.assertEqual(len(self.hooks.io.absence_calls), 1)

    def test_foreign_or_malformed_project_stops_before_cache_and_request(self):
        cases = [b"null", b'{"projectNumber":NaN}', wire({"projectId": "foreign", "projectNumber": NUMBER, "lifecycleState": "ACTIVE"}),
                 wire({"projectId": "signmons", "projectNumber": "654321098765", "lifecycleState": "ACTIVE"})]
        for index, raw in enumerate(cases):
            self.root = Path(self.tmp.name) / str(index)
            self.hooks = Harness(self.clock)
            self.hooks.io.command_hook = lambda name, raw=raw: raw if name == "project" else None
            with self.subTest(index=index):
                result = self.run_operation()
                self.assertEqual(result["status"], "UNKNOWN")
                self.assertFalse(self.hooks.cache_calls or self.hooks.opener.calls)
                self.assertTrue(all(result["closeout"].values()))

    def test_replay_refuses_before_second_factory_or_dispatch(self):
        self.run_operation()
        before = (self.hooks.factories, list(self.hooks.io.commands), len(self.hooks.cache_calls), len(self.hooks.opener.calls))
        with self.assertRaises(Exception):
            v.run(self.scope, hooks=self.hooks, root=self.root)
        self.assertEqual(before, (self.hooks.factories, self.hooks.io.commands, len(self.hooks.cache_calls), len(self.hooks.opener.calls)))

    def test_concurrent_attempt_cannot_construct_second_io(self):
        started, release = threading.Event(), threading.Event()
        result, errors = [], []
        def owner(_):
            started.set()
            if not release.wait(3):
                raise AssertionError("synthetic owner was not released")
            return b"[]"
        self.hooks.io.command_hook = owner
        def first():
            try:
                result.append(v.run(self.scope, hooks=self.hooks, root=self.root))
            except BaseException as error:
                errors.append(error)
        thread = threading.Thread(target=first)
        thread.start()
        try:
            self.assertTrue(started.wait(3))
            second = Harness(self.clock)
            with self.assertRaises(Exception):
                v.run(self.scope, hooks=second, root=self.root)
            self.assertEqual(second.factories, 0)
            self.assertFalse(second.cache_calls or second.opener.calls)
        finally:
            release.set()
            thread.join(3)
        self.assertFalse(thread.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(result[0]["failure"], "VM2_OWNER")
        self.assertEqual(len(self.hooks.io.close_calls), 1)

    def test_interruption_after_cli_or_cache_reservation_closes_once_without_retry(self):
        for stage in ("owner", "cache"):
            self.root = Path(self.tmp.name) / stage
            self.hooks = Harness(self.clock)
            def interrupted(*_):
                raise KeyboardInterrupt(PRIVATE)
            if stage == "owner":
                self.hooks.io.command_hook = interrupted
            else:
                self.hooks.cache_hook = interrupted
            with self.subTest(stage=stage):
                result = self.run_operation()
                self.assertEqual(result["failure"], "VM2_INTERRUPTED")
                self.assertFalse(self.hooks.opener.calls)
                self.assertEqual(result["counts"], {"cli": 1 if stage == "owner" else 2,
                                                    "cache": 0 if stage == "owner" else 1, "https": 0})
                self.assertEqual(len(self.hooks.io.close_calls), 1)
                self.assertEqual(len(self.hooks.io.absence_calls), 1)

    def test_pending_native_signal_stops_before_next_dispatch_and_restores_handler(self):
        previous = signal.getsignal(signal.SIGTERM)
        def pending(_):
            signal.getsignal(signal.SIGTERM)(signal.SIGTERM, None)
        self.hooks.io.command_hook = pending
        with v.interruption_handlers():
            result = self.run_operation()
            self.assertTrue(v.INTERRUPTED.get())
        self.assertFalse(v.INTERRUPTED.get())
        self.assertIs(signal.getsignal(signal.SIGTERM), previous)
        self.assertEqual(result["failure"], "VM2_INTERRUPTED")
        self.assertEqual(result["status"], "UNKNOWN")
        self.assertEqual(self.hooks.io.commands, ["owner"])
        self.assertFalse(self.hooks.cache_calls or self.hooks.opener.calls)
        self.assertTrue(all(result["closeout"].values()))

    def test_signal_during_dispatch_guard_stops_before_owned_command(self):
        def guard(_, count):
            if count == 2:
                signal.getsignal(signal.SIGTERM)(signal.SIGTERM, None)
        self.hooks.guard_hook = guard
        with v.interruption_handlers():
            result = self.run_operation()
        self.assertEqual(result["status"], "UNKNOWN")
        self.assertEqual(result["failure"], "VM2_INTERRUPTED")
        self.assertFalse(self.hooks.io.commands or self.hooks.cache_calls or self.hooks.opener.calls)
        self.assertTrue(all(result["closeout"].values()))

    def test_signal_during_closeout_publication_cannot_persist_success(self):
        original = v.Journal.put
        def publish(journal, name, value):
            if name == "closeout.json":
                signal.getsignal(signal.SIGTERM)(signal.SIGTERM, None)
            return original(journal, name, value)
        with v.interruption_handlers(), patch.object(v.Journal, "put", publish):
            result = self.run_operation()
        persisted = json.loads((self.root / "result.json").read_bytes())
        self.assertEqual(result["status"], "UNKNOWN")
        self.assertEqual(persisted["status"], "UNKNOWN")
        self.assertEqual(persisted["failure"], "VM2_INTERRUPTED")
        self.assertTrue(all(result["closeout"].values()))

    def test_late_result_publication_signal_is_vetoed_by_authoritative_readback(self):
        original = v.Journal.put
        def publish(journal, name, value):
            original(journal, name, value)
            if name == "result.json":
                signal.getsignal(signal.SIGTERM)(signal.SIGTERM, None)
        with v.interruption_handlers(), patch.object(v.Journal, "put", publish):
            result = self.run_operation()
        immutable = json.loads((self.root / "result.json").read_bytes())
        self.assertEqual(immutable["status"], "METADATA_DIAGNOSED")
        self.assertEqual(v.m.digest(immutable), result["resultSha256"])
        self.assertEqual(result["status"], "UNKNOWN")
        self.assertEqual(json.loads((self.root / "interruption.json").read_bytes()), {"failure": "VM2_INTERRUPTED"})
        readback = v.read_result(self.root, result["resultSha256"])
        self.assertEqual(readback, result)
        self.assert_private_absent(readback)
        (self.root / "interruption.json").write_bytes(wire({"failure": PRIVATE}))
        with self.assertRaisesRegex(v.Stop, "VM2_CUSTODY"):
            v.read_result(self.root, result["resultSha256"])

    def test_authoritative_readback_refuses_wrong_digest_or_modified_result(self):
        result = self.run_operation()
        self.assertEqual(v.read_result(self.root, result["resultSha256"]), result)
        with self.assertRaisesRegex(v.Stop, "VM2_CUSTODY"):
            v.read_result(self.root, "0" * 64)
        path = self.root / "result.json"
        changed = json.loads(path.read_bytes())
        changed["ownerMatched"] = False
        path.write_bytes(wire(changed))
        with self.assertRaisesRegex(v.Stop, "VM2_CUSTODY"):
            v.read_result(self.root, result["resultSha256"])

    def test_required_interruption_marker_deletion_cannot_restore_success(self):
        result = self.run_operation()
        vetoed = v.record_interruption(self.root, result["resultSha256"])
        self.assertEqual(vetoed["status"], "UNKNOWN")
        self.assertEqual(vetoed["failure"], "VM2_INTERRUPTED")
        marker = self.root / "interruption.json"
        original = marker.read_bytes()
        self.assertEqual(v.record_interruption(self.root, result["resultSha256"]), vetoed)
        self.assertEqual(marker.read_bytes(), original)
        marker.unlink()
        with self.assertRaisesRegex(v.Stop, "VM2_CUSTODY"):
            v.read_result(self.root, result["resultSha256"],
                          interruption_required=vetoed["failure"] == "VM2_INTERRUPTED")

    def test_execute_interrupted_final_readback_persists_veto_before_reporting(self):
        # execute() intentionally starts with the native-clock preflight.
        self.clock.now = float(int(time.time()))
        self.scope = scope(self.clock())
        original = v.read_result
        reads = []
        def readback(root, digest, **kwargs):
            value = original(root, digest, **kwargs)
            reads.append(True)
            if len(reads) == 1:
                signal.getsignal(signal.SIGTERM)(signal.SIGTERM, None)
            return value
        output = io.StringIO()
        with patch.object(v, "authorize", return_value=self.scope), \
                patch.object(v, "source_guard"), patch.object(v, "configuration", return_value=CONFIG), \
                patch.object(v, "NativeHooks", return_value=self.hooks), \
                patch.object(v, "root_for", return_value=self.root), \
                patch.object(v.sq, "identity_lease", return_value=contextlib.nullcontext()), \
                patch.object(v, "read_result", side_effect=readback), contextlib.redirect_stdout(output):
            code = v.execute("d" * 40, "APP013_P08_VM2_SCOPE_20261124_12345678.json",
                             "APP013_P08_VM2_APPROVAL_20261124_12345678.json")
        reported = json.loads(output.getvalue())
        self.assertEqual(code, 2)
        self.assertEqual(reported["status"], "UNKNOWN")
        self.assertEqual(reported["failure"], "VM2_INTERRUPTED")
        self.assertEqual(json.loads((self.root / "interruption.json").read_bytes()), {"failure": "VM2_INTERRUPTED"})
        self.assertEqual(original(self.root, reported["resultSha256"], interruption_required=True), reported)
        self.assertEqual(reported["counts"], {"cli": 2, "cache": 1, "https": 1})
        self.assert_private_absent(reported)
        self.assertFalse(v.INTERRUPTED.get())

    def test_interruption_swallowed_by_reused_error_classifier_cannot_report_success(self):
        self.hooks.opener = Opener(Response(denial(), status=403))
        lines, first_line = inspect.getsourcelines(v.sq.classify_sign_response)
        target = first_line + next(i for i, line in enumerate(lines) if "details = error.get(" in line)
        fired = []
        previous = sys.gettrace()
        def interrupt(frame, event, arg):
            if event == "line" and frame.f_code is v.sq.classify_sign_response.__code__ and frame.f_lineno == target:
                fired.append(True)
                sys.settrace(None)
                signal.getsignal(signal.SIGTERM)(signal.SIGTERM, None)
                raise v.Stop("VM2_INTERRUPTED")
            return interrupt
        try:
            with v.interruption_handlers():
                sys.settrace(interrupt)
                result = self.run_operation()
        finally:
            sys.settrace(previous)
        self.assertEqual(fired, [True])
        self.assertEqual(result["status"], "UNKNOWN")
        self.assertEqual(result["failure"], "VM2_INTERRUPTED")
        self.assertFalse(result["metadata"]["errorEnvelopeValid"])
        self.assertEqual(len(self.hooks.opener.calls), 1)
        self.assertTrue(all(result["closeout"].values()))

    def test_clock_rollback_between_owned_commands_blocks_next_dispatch(self):
        self.hooks.io.command_hook = lambda _: setattr(self.clock, "now", self.clock() - 2)
        result = self.run_operation()
        self.assertEqual(result["status"], "UNKNOWN")
        self.assertEqual(self.hooks.io.commands, ["owner"])
        self.assertFalse(self.hooks.cache_calls or self.hooks.opener.calls)

    def test_source_and_configuration_drift_stop_before_next_dispatch(self):
        for kind in ("source", "configuration"):
            self.root = Path(self.tmp.name) / kind
            self.hooks = Harness(self.clock)
            if kind == "source":
                def guard(_, count):
                    if count > 2:
                        raise v.Stop("VM2_SOURCE")
                self.hooks.guard_hook = guard
            else:
                self.hooks.config_hook = lambda count: CONFIG if count <= 2 else "f" * 64
            with self.subTest(kind=kind):
                result = self.run_operation()
                self.assertEqual(self.hooks.io.commands, ["owner"])
                self.assertFalse(self.hooks.cache_calls or self.hooks.opener.calls)
                self.assertEqual(result["status"], "UNKNOWN")

    def test_unsafe_parent_environment_never_dispatches(self):
        with patch.dict(os.environ, {"HTTPS_PROXY": "https://" + PRIVATE}):
            result = self.run_operation()
        self.assertEqual(result["status"], "UNKNOWN")
        self.assertFalse(self.hooks.io.commands or self.hooks.cache_calls or self.hooks.opener.calls)
        self.assertEqual(len(self.hooks.io.close_calls), 1)

    def test_cleanup_and_independent_absence_failures_cannot_claim_closed_success(self):
        for key, failure in (("close_result", False), ("close_result", OSError(PRIVATE)),
                             ("absence_result", False), ("absence_result", OSError(PRIVATE))):
            self.root = Path(self.tmp.name) / str(uuid.uuid4())
            self.hooks = Harness(self.clock)
            setattr(self.hooks.io, key, failure)
            with self.subTest(key=key, failure=type(failure).__name__):
                result = self.run_operation()
                self.assertEqual(result["status"], "UNKNOWN")
                self.assertEqual(result["residuals"], ["LOCAL_CLOSEOUT_UNCONFIRMED"])
                self.assertEqual(len(self.hooks.io.close_calls), 1)
                self.assertEqual(len(self.hooks.io.absence_calls), 1)

    def test_transport_response_close_failure_propagates_into_closeout(self):
        self.hooks.opener = Opener(Response(close_error=OSError(PRIVATE)))
        result = self.run_operation()
        self.assertEqual(result["status"], "UNKNOWN")
        self.assertFalse(result["closeout"]["responseClosed"])
        self.assertEqual(result["residuals"], ["LOCAL_CLOSEOUT_UNCONFIRMED"])


class AuthorityAndSources(Fixture):
    def decision(self):
        return {"owner": "Debynyhan Banks", "decision": v.DECISION,
                "scopeSha256": v.m.digest(self.scope), "operationId": self.scope["operationId"],
                "externalReadAuthorized": True, "independentCleanupAuthorized": True,
                "sdkException": v.SDK_EXCEPTION, "paymentAuthorized": False, "allowanceUsd": 0}

    def test_exact_committed_decision_is_required_and_reads_only_named_documents(self):
        names = ["APP013_P08_VM2_SCOPE_20261124_12345678.json", "APP013_P08_VM2_APPROVAL_20261124_12345678.json"]
        documents = dict(zip(names, (wire(self.scope), wire(self.decision()))))
        calls = []
        def read(repo, commit, name):
            calls.append((repo, commit, name))
            return documents[name]
        self.assertEqual(v.authorize("d" * 40, *names, read_commit=read), self.scope)
        self.assertEqual([row[2] for row in calls], names)
        for change in ({"externalReadAuthorized": False}, {"independentCleanupAuthorized": False},
                       {"paymentAuthorized": True}, {"allowanceUsd": True}, {"scopeSha256": "f" * 64},
                       {"operationId": str(uuid.uuid4())}, {"private": PRIVATE}):
            documents[names[1]] = wire({**self.decision(), **change})
            with self.subTest(change=change), self.assertRaises(v.Stop):
                v.authorize("d" * 40, *names, read_commit=read)

    def test_default_execute_refuses_missing_authority_before_native_hooks(self):
        with patch.object(v, "NativeHooks") as factory, patch.object(v.a, "committed", side_effect=FileNotFoundError(PRIVATE)):
            with self.assertRaises(Exception):
                v.execute("d" * 40, "APP013_P08_VM2_SCOPE_20261124_12345678.json",
                          "APP013_P08_VM2_APPROVAL_20261124_12345678.json")
            factory.assert_not_called()

    def test_native_hooks_default_deny_and_recheck_exact_authority(self):
        with patch.object(v.urllib.request, "build_opener") as opener:
            with self.assertRaisesRegex(v.Stop, "VM2_AUTHORITY"):
                v.NativeHooks(self.scope)
            with self.assertRaisesRegex(v.Stop, "VM2_AUTHORITY"):
                v.NativeHooks(self.scope, refs={})
            opener.assert_not_called()
        hooks = self.native_hooks()
        with patch.object(v, "authorize", return_value={**self.scope, "configSha256": "f" * 64}), \
                patch.object(v, "source_guard") as source:
            with self.assertRaisesRegex(v.Stop, "VM2_AUTHORITY"):
                hooks.guard(self.scope)
            source.assert_not_called()
        with patch.object(v, "NativeHooks") as factory:
            with self.assertRaises(v.Stop):
                v.execute("not-a-commit", "scope.json", "approval.json")
            factory.assert_not_called()

    def test_actual_source_guard_checks_local_committed_and_dependency_bytes(self):
        base = Path(self.tmp.name)
        here = base / "evidence/APP-013/synthetic-vm2"
        here.mkdir(parents=True)
        for name in ("vm2_metadata_read.py", "test_vm2_metadata_read.py"):
            (here / name).write_text("# synthetic source fixture\n")
        manifest = {"version": 1,
                    "files": {str((here / name).relative_to(base)): v.m.digest((here / name).read_bytes())
                              for name in ("vm2_metadata_read.py", "test_vm2_metadata_read.py")},
                    "dependencies": {"sq1ManifestSha256": "d" * 64, "iq1ManifestSha256": "e" * 64}}
        path = here / "vm2-source-manifest.json"
        path.write_bytes(wire(manifest))
        candidate = {**self.scope, "manifestSha256": v.m.digest(path.read_bytes())}
        original = {str(p.relative_to(base)): p.read_bytes() for p in here.iterdir()}
        def committed(repo, commit, name):
            self.assertEqual(commit, candidate["sourceCommit"])
            return original[name]
        with patch.object(v, "HERE", here), patch.object(v, "MANIFEST", path), \
                patch.object(v.p, "B", base), patch.object(v.a, "committed", side_effect=committed), \
                patch.object(v.sq, "source_guard") as dependency:
            v.source_guard(candidate)
            self.assertEqual(dependency.call_args.args[0], {
                "sourceCommit": candidate["sourceCommit"], "manifestSha256": "d" * 64,
                "iq1ManifestSha256": "e" * 64})
            (here / "vm2_metadata_read.py").write_text("# changed synthetic source\n")
            with self.assertRaisesRegex(v.Stop, "VM2_SOURCE"):
                v.source_guard(candidate)


class NativeCacheAndProcesses(Fixture):
    def test_actual_native_cache_requires_expiry_strictly_beyond_closeout(self):
        fixture_path = v.acl.HERE / "test_access_check.py"
        spec = importlib.util.spec_from_file_location("vm2_reused_cache_fixture", fixture_path)
        fixture = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"access_check": v.acl}):
            spec.loader.exec_module(fixture)
        end = self.clock() + 270
        for offset in (-1, 0, 1):
            root = Path(self.tmp.name) / ("cache" + str(offset))
            root.mkdir(mode=0o700)
            database = fixture.make_cache(root, end + offset)
            before = database.read_bytes()
            with patch.object(v.acl, "CONFIG_ROOT", root), patch.object(socket.socket, "connect", side_effect=AssertionError("network forbidden")):
                hooks = self.native_hooks()
                if offset > 0:
                    self.assertEqual(hooks.cache_reader(end), "SYNTHETIC_BEARER_NEVER_PERSIST")
                else:
                    with self.assertRaisesRegex(v.acl.Stop, "CACHED_TOKEN_EXPIRED"):
                        hooks.cache_reader(end)
            self.assertEqual(database.read_bytes(), before)
            self.assertFalse(any(Path(str(database) + suffix).exists() for suffix in ("-wal", "-shm", "-journal")))

    def test_native_cache_rejects_wrong_horizon_before_cache_adapter(self):
        hooks = self.native_hooks()
        with patch.object(v.acl, "read_cached_token") as read:
            with self.assertRaisesRegex(v.Stop, "VM2_CREDENTIAL"):
                hooks.cache_reader(self.clock() + 269)
            read.assert_not_called()

    def test_actual_owned_inert_child_is_closed_and_independently_absent(self):
        owned = v.TrackedIO(time.time, str(uuid.uuid4()))
        end = time.time() + 5
        raw = owned._owned_run([sys.executable, "-I", "-B", "-c", "print('synthetic-owned-child')"],
                              {"PATH": "/usr/bin:/bin"}, end)
        self.assertEqual(raw, b"synthetic-owned-child\n")
        self.assertTrue(owned.close(end))
        self.assertTrue(owned.verify_absent(end))
        self.assertTrue(owned.observed)

    def test_pending_signal_during_popen_registration_preserves_owned_child_cleanup(self):
        owned = v.TrackedIO(self.clock, self.scope["operationId"])
        self.hooks.io_factory = lambda: owned
        original = v.q.subprocess.Popen
        processes = []
        def spawn(argv, **kwargs):
            child = original([sys.executable, "-I", "-B", "-c", "print('[]')"], **kwargs)
            processes.append(child)
            signal.getsignal(signal.SIGTERM)(signal.SIGTERM, None)
            return child
        with v.interruption_handlers(), patch.object(v.q.subprocess, "Popen", side_effect=spawn):
            result = self.run_operation()
        self.assertEqual(len(processes), 1)
        self.assertIsNotNone(processes[0].poll())
        self.assertFalse(owned.children)
        self.assertEqual(result["failure"], "VM2_INTERRUPTED")
        self.assertEqual(result["counts"], {"cli": 1, "cache": 0, "https": 0})
        self.assertTrue(result["closeout"]["processCleanupVerified"])
        self.assertTrue(result["closeout"]["independentProcessAbsence"])


if __name__ == "__main__":
    unittest.main()
