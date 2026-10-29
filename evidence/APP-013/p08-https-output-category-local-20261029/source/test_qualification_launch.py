import contextlib,copy,datetime as dt,hashlib,io,json,os,socket,subprocess,tempfile,unittest
from pathlib import Path
from unittest.mock import patch

import composed_qualification as model
import qualification_launch as launch
from test_composed_qualification import NOW,access,cloud,database,firebase,plan


def binding(p):
    environment=[{"name":"A"},{"name":"B"}]
    b={"mode":"P08_READ_ONLY_QUALIFICATION_LAUNCH","localPreparationSha256":launch.LOCAL_PREPARATION_SHA256,"operationProposalSha256":"9"*64,"planSha256":model.digest(p),"sourceManifestSha256":launch.source_manifest_sha256(),"externalReadAuthorized":True,"mutationsAuthorized":False,"allowanceUsd":0,"automaticRetryAllowed":False,"operationId":p["operationId"],"prospectiveOperationId":p["prospectiveOperationId"],"cliLimit":26,"httpsLimit":10,"sqlLimit":2,"candidateImage":"us-east5-docker.pkg.dev/signmons/signmons/signmons-calldesk-backend@sha256:"+"a"*64,"environmentSha256":model.digest(environment),"normalRevision":"signmons-calldesk-staging-app013dbrot2","databasePassword":"private-password"}
    b["ownerApproval"]={"decision":"APPROVE_EXACT_P08_READ_ONLY_QUALIFICATION","owner":"Debynyhan Banks","operationId":p["operationId"],"operationProposalSha256":b["operationProposalSha256"],"bindingSha256":model.digest({k:v for k,v in b.items() if k!="databasePassword"})}
    return b


UID="11111111-2222-4333-8444-555555555555"
def database_raw():
    return {"jobCount":1,"job":{"id":model.JOB,"tenantId":model.TENANT,"policySnapshot":{"intakeAdmission":{"humanReviewed":True}},"calendarEventId":None},"tenantCount":1,"tenant":{"id":model.TENANT,"status":"ACTIVE"},"operatorCount":1,"operator":{"id":UID,"tenantId":model.TENANT,"email":launch.TARGET_EMAIL,"fullName":launch.TARGET_NAME,"role":"ADMIN","status":"DISABLED"},"calendarCount":0,"roleCount":0,"sessionCount":0}


class FakeIO:
    def __init__(self,b,p):self.b=b;self.p=p;self.calls=[];self.closed=False;self.override={}
    def cli(self,d,deadline):
        self.calls.append(("cli",d));i=d["id"]
        values={"owner":[{"account":model.OWNER,"status":"ACTIVE"}],"config":{"core":{"project":model.PROJECT},"auth":{}},"project":{"projectId":model.PROJECT,"projectNumber":"123456789012","lifecycleState":"ACTIVE"},"billing_project":{"billingAccountName":"billingAccounts/ABCDEF-123456","billingEnabled":True,"projectId":model.PROJECT},"billing_account":{"open":True},"service":{"status":{"latestReadyRevisionName":launch.REVISION,"traffic":[{"revisionName":self.b["normalRevision"],"percent":100},{"revisionName":launch.REVISION,"percent":0}]}},"revision":{"metadata":{"name":launch.REVISION},"spec":{"serviceAccountName":model.IDENTITY,"containers":[{"image":self.b["candidateImage"],"env":[{"name":"A"},{"name":"B"}]}]},"status":{"conditions":[{"type":"Ready","status":"True"}]}},"identity":{"email":model.IDENTITY,"disabled":True,"uniqueId":"123"},"project_policy":{"bindings":[]},"identity_policy":{"bindings":[]},"lookup_role":{"name":model.LOOKUP_ROLE,"includedPermissions":["firebaseauth.users.get"],"stage":"GA","deleted":False},"signing_role":{"name":model.SIGNING_ROLE,"includedPermissions":["iam.serviceAccounts.signBlob"],"stage":"GA","deleted":False},"token":{"accessToken":"x"*32}}
        if i.startswith("secret_state_"):v={"name":i,"state":"DISABLED"}
        elif i.startswith("secret_policy_"):v={"bindings":[],"etag":"x","version":1}
        else:v=values[i]
        return copy.deepcopy(self.override.get(i,v))
    def https(self,d,token,deadline):
        self.calls.append(("https",d));i=d["id"]
        if i.startswith("service_"):v={"status":200,"body":{"state":"ENABLED"}}
        elif i=="project_permissions":v={"status":200,"body":{"permissions":list(model.PERMISSIONS)}}
        elif i=="identity_permissions":v={"status":200,"body":{"permissions":list(model.PERMISSIONS)}}
        elif i=="key_absence":v={"status":404,"body":{"error":{"status":"NOT_FOUND"}}}
        else:v={"status":200,"body":{"users":[{"localId":UID,"disabled":True,"email":launch.TARGET_EMAIL,"displayName":launch.TARGET_NAME,"customAttributes":json.dumps({"tenantId":model.TENANT,"role":"admin","testOnly":True}),"validSince":str(launch.REVOCATION_LOWER_BOUND_MS//1000)}]}}
        return copy.deepcopy(self.override.get(i,v))
    def sql(self,d,password,deadline):
        self.calls.append(("sql",d));v=database_raw() if d["id"]=="qualification" else {"sessionsAbsent":True};return copy.deepcopy(self.override.get(d["id"],v))
    def close(self,deadline):self.calls.append(("close",None));self.closed=True;return True


class Tests(unittest.TestCase):
    def setUp(self):
        self.patchers=[patch.object(launch,"PROJECT_NUMBER_SHA256",model.digest("123456789012")),patch.object(launch,"BILLING_ACCOUNT_SHA256",hashlib.sha256(b"billingAccounts/ABCDEF-123456").hexdigest()),patch.object(launch,"TARGET_SHA256",hashlib.sha256(json.dumps(database_raw()["operator"],separators=(",",":")).encode()).hexdigest())]
        for item in self.patchers:item.start()
        self.p=plan();self.b=binding(self.p);self.io=FakeIO(self.b,self.p);self.tmp=tempfile.TemporaryDirectory(prefix="p08-launch-");os.chmod(self.tmp.name,0o700)
    def tearDown(self):
        self.tmp.cleanup()
        for item in reversed(self.patchers):item.stop()
    def adapter(self):return launch.Adapter(self.b,self.p,self.io,lambda:NOW)
    def test_exact_serialized_contracts_are_read_only(self):
        cli=launch.cli_contract();self.assertEqual(len(cli),26);self.assertTrue(all(x["argv"][0]==launch.GCLOUD for x in cli));self.assertFalse(any(a in {"create","delete","enable","disable","add-iam-policy-binding","remove-iam-policy-binding","set-iam-policy"} for x in cli for a in x["argv"]))
        http=(*launch.access_https_contract("123456789012",self.p["prospectiveKeyId"]),launch.firebase_https_contract(UID));self.assertEqual(len(http),10);self.assertTrue(all(x["method"] in {"GET","POST"} for x in http));self.assertFalse(any(s in x["url"] for x in http for s in (":enable",":signBlob","keyString","accounts:update")))
        sql=launch.sql_contract();self.assertEqual(len(sql),2);self.assertTrue(all(x["readOnly"] for x in sql));self.assertNotIn("UPDATE",json.dumps(sql));self.assertNotIn("DELETE FROM",json.dumps(sql));self.assertNotIn("INSERT",json.dumps(sql))
    def test_fake_transport_proves_exact_counts_and_positive_model(self):
        a=self.adapter();result=model.Coordinator(self.p,a,self.tmp.name,clock=lambda:NOW).run();self.assertEqual(result["status"],"P08_COMPOSED_QUALIFICATION_LOCAL_VERIFIED")
        self.assertEqual(sum(k=="cli" for k,_ in self.io.calls),26);self.assertEqual(sum(k=="https" for k,_ in self.io.calls),10);self.assertEqual(sum(k=="sql" for k,_ in self.io.calls),2);self.assertTrue(self.io.closed);self.assertIsNone(a.token);self.assertIsNone(a.binding["databasePassword"])
    def test_https_output_stop_records_only_fixed_descriptor_id(self):
        descriptors=(*launch.access_https_contract("123456789012",self.p["prospectiveKeyId"]),launch.firebase_https_contract(UID))
        self.assertEqual({item["id"] for item in descriptors},launch.HTTPS_DESCRIPTOR_IDS)
        for descriptor in descriptors:
            for raw,category in ((b"private-response-not-json","INVALID_JSON"),(b"\xffprivate-response","INVALID_UTF8"),(b"x"*(launch.MAX_OUTPUT+1),"OVERSIZE")):
                with self.subTest(request=descriptor["id"],category=category):
                    self.io.override[descriptor["id"]]={"status":200,"body":raw}
                    with self.assertRaises(model.Stop) as raised:self.adapter()._https(descriptor)
                    self.assertEqual(str(raised.exception),"HTTPS_OUTPUT:"+descriptor["id"]+":"+category)
                    self.assertNotIn("private-response",str(raised.exception))
            self.io.override.pop(descriptor["id"],None)
        self.io.override["service_0"]={"status":200,"body":b"private-response-not-json"}
        result=model.Coordinator(self.p,self.adapter(),self.tmp.name,clock=lambda:NOW).run()
        self.assertEqual(result["failure"],"HTTPS_OUTPUT:service_0:INVALID_JSON")
        saved=(Path(self.tmp.name)/"journal.json").read_text()
        self.assertNotIn("private-response",saved)
        self.assertNotIn("https://",saved)
        self.assertNotIn("accessToken",saved)
        self.assertEqual(self.io.calls[-1][0],"close")
    def test_https_wrong_shape_refuses_without_invented_category(self):
        descriptor=launch.access_https_contract("123456789012",self.p["prospectiveKeyId"])[1]
        self.io.override[descriptor["id"]]={"status":200,"body":b"42"}
        with self.assertRaises(model.Stop) as raised:self.adapter()._https(descriptor)
        self.assertEqual(str(raised.exception),"HTTPS_OUTPUT:"+descriptor["id"])
        self.io.override[descriptor["id"]]={"status":200,"body":b'{"state":"ENABLED"}'}
        self.assertEqual(self.adapter()._https(descriptor)["body"],{"state":"ENABLED"})
    def test_https_output_from_transport_is_labeled_and_foreign_id_refuses_before_call(self):
        descriptor=launch.access_https_contract("123456789012",self.p["prospectiveKeyId"])[0]
        self.io.https=lambda *_:(_ for _ in ()).throw(model.Stop("HTTPS_OUTPUT"))
        with self.assertRaises(model.Stop) as raised:self.adapter()._https(descriptor)
        self.assertEqual(str(raised.exception),"HTTPS_OUTPUT:"+descriptor["id"])
        self.io.https=lambda *_:(_ for _ in ()).throw(model.Stop("HTTPS_OUTPUT_OVERSIZE"))
        with self.assertRaises(model.Stop) as raised:self.adapter()._https(descriptor)
        self.assertEqual(str(raised.exception),"HTTPS_OUTPUT:"+descriptor["id"]+":OVERSIZE")
        before=len(self.io.calls)
        with self.assertRaises(model.Stop) as raised:self.adapter()._https({"id":"foreign","url":"https://invalid.example"})
        self.assertEqual(str(raised.exception),"HTTPS_DESCRIPTOR_SCOPE")
        self.assertEqual(len(self.io.calls),before)
    def test_native_https_oversize_is_fixed_category_without_response_retention(self):
        class OversizeResponse:
            status=200
            def __enter__(self):return self
            def __exit__(self,*_):return False
            def read(self,limit):return b"private-body"+b"x"*limit
        descriptor=launch.access_https_contract("123456789012",self.p["prospectiveKeyId"])[1]
        with patch("urllib.request.urlopen",return_value=OversizeResponse()),self.assertRaises(model.Stop) as raised:
            launch.NativeIO(lambda:NOW,self.p["operationId"]).https(descriptor,"x"*32,NOW+10)
        self.assertEqual(str(raised.exception),"HTTPS_OUTPUT_OVERSIZE")
        self.assertNotIn("private-body",str(raised.exception))
    def test_retired_traffic_accepts_absent_or_explicit_zero_candidate(self):
        normal={"revisionName":self.b["normalRevision"],"percent":100}
        for rows in ([normal], [normal,{"revisionName":"other-retired-revision","percent":0}],
                     [normal,{"revisionName":launch.REVISION,"percent":0}]):
            with self.subTest(rows=len(rows)):
                self.assertTrue(launch.traffic_retired(rows,self.b["normalRevision"]))
                self.tearDown();self.setUp()
                self.io.override["service"]={"status":{"traffic":rows}}
                result=model.Coordinator(self.p,self.adapter(),self.tmp.name,clock=lambda:NOW).run()
                self.assertEqual(result["verdict"],"QUALIFIED")
                self.assertEqual(self.io.calls[-1][0],"close")
    def test_retired_traffic_rejects_unsafe_or_ambiguous_routing(self):
        normal={"revisionName":self.b["normalRevision"],"percent":100}
        candidate={"revisionName":launch.REVISION,"percent":0}
        bad=[
            [candidate],
            [{"revisionName":self.b["normalRevision"],"percent":99},candidate],
            [normal,{"revisionName":launch.REVISION,"percent":1}],
            [normal,{"revisionName":"foreign-revision","percent":1}],
            [normal,{"revisionName":launch.REVISION}],
            [{**normal,"tag":"app013-p07-atomic"}],
            [normal,{**candidate,"tag":"app013-p07-atomic"}],
        ]
        for rows in bad:
            with self.subTest(rows=rows):
                self.tearDown();self.setUp()
                self.io.override["service"]={"status":{"traffic":rows}}
                result=model.Coordinator(self.p,self.adapter(),self.tmp.name,clock=lambda:NOW).run()
                self.assertEqual(result["verdict"],"DRIFT")
                self.assertEqual(self.io.calls[-1][0],"close")
        malformed=[[],[normal,normal],[normal,candidate,candidate],[{"revisionName":self.b["normalRevision"],"percent":True}],
                   [{"revisionName":self.b["normalRevision"],"percent":-1}],
                   [{"revisionName":self.b["normalRevision"],"percent":"100"}],
                   [{"revisionName":self.b["normalRevision"],"percent":101}],
                   [{"percent":100}],[{"revisionName":self.b["normalRevision"],"percent":100,"tag":123}],
                   [normal]*21]
        for rows in malformed:
            with self.subTest(malformed=rows):
                self.tearDown();self.setUp()
                self.io.override["service"]={"status":{"traffic":rows}}
                result=model.Coordinator(self.p,self.adapter(),self.tmp.name,clock=lambda:NOW).run()
                self.assertEqual(result["verdict"],"UNKNOWN")
                self.assertEqual(result["failure"],"SERVICE_OUTPUT")
                self.assertEqual(self.io.calls[-1][0],"close")
    def test_config_output_accepts_only_two_exact_safe_shapes(self):
        self.assertEqual(launch.config_output_shape({"core":{"project":model.PROJECT}}),"AUTH_SECTION_OMITTED")
        self.assertEqual(launch.config_output_shape({"core":{"project":model.PROJECT},"auth":{}}),"AUTH_SECTION_EMPTY")
        self.io.override["config"]={"core":{"project":model.PROJECT}}
        result=model.Coordinator(self.p,self.adapter(),self.tmp.name,clock=lambda:NOW).run();self.assertEqual(result["verdict"],"QUALIFIED")
    def test_config_output_rejects_every_other_shape(self):
        values=[
            {"core":{"project":"foreign"}},
            {"core":{}},
            {"auth":{}},
            {"core":{"project":model.PROJECT,"extra":True}},
            {"core":{"project":model.PROJECT},"auth":{"impersonate_service_account":"foreign"}},
            {"core":{"project":model.PROJECT},"auth":{},"extra":True},
            [],
            "not-json",
        ]
        for value in values:
            self.tearDown();self.setUp();self.io.override["config"]=value
            result=model.Coordinator(self.p,self.adapter(),self.tmp.name,clock=lambda:NOW).run()
            expected="CLI_OUTPUT" if value=="not-json" else "CONFIG_OUTPUT"
            self.assertEqual(result["verdict"],"UNKNOWN");self.assertEqual(result["failure"],expected);self.assertEqual(self.io.calls[-1][0],"close")
    def test_native_io_refuses_ambient_credential_and_database_overrides(self):
        cases=[
            {"GOOGLE_APPLICATION_CREDENTIALS":"foreign.json"},
            {"CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT":"foreign@example.invalid"},
            {"CLOUDSDK_AUTH_ACCESS_TOKEN":"private"},
            {"DATABASE_URL":"postgres://foreign"},
            {"PGHOST":"foreign"},
        ]
        for values in cases:
            with self.subTest(values=tuple(values)),patch.dict(os.environ,values,clear=True),self.assertRaises(model.Stop):
                launch.NativeIO(lambda:NOW,self.p["operationId"])
    def test_native_refuses_before_process_network_or_environment(self):
        output=io.StringIO()
        with patch("subprocess.Popen",side_effect=AssertionError("no process")),patch("socket.socket",side_effect=AssertionError("no network")),patch.dict(os.environ,{"GOOGLE_APPLICATION_CREDENTIALS":"do-not-read"}),contextlib.redirect_stdout(output):
            code=launch.native()
        self.assertEqual(code,2);self.assertEqual(output.getvalue().strip(),"P08_COMPOSED_QUALIFICATION_LAUNCH_REFUSED_UNBOUND")
    def test_binding_drift_refuses_before_transport(self):
        changes={"mode":"bad","localPreparationSha256":"0"*64,"operationProposalSha256":"bad","planSha256":"0"*64,"sourceManifestSha256":"0"*64,"externalReadAuthorized":False,"mutationsAuthorized":True,"allowanceUsd":1,"automaticRetryAllowed":True,"operationId":"bad","prospectiveOperationId":"bad","cliLimit":27,"httpsLimit":11,"sqlLimit":3}
        for key,value in changes.items():
            b=copy.deepcopy(self.b);b[key]=value
            with self.subTest(key=key),self.assertRaises(model.Stop):launch.Adapter(b,self.p,self.io,lambda:NOW)
        self.assertEqual(self.io.calls,[])
    def test_each_domain_drift_and_denial_stops_with_closeout(self):
        cases=[("project",{"projectId":"other","projectNumber":"123456789012","lifecycleState":"ACTIVE"},"DRIFT"),("service_0",{"status":403,"body":{"error":{"status":"PERMISSION_DENIED"}}},"UNKNOWN"),("key_absence",{"status":200,"body":{"name":"collision"}},"NOT_READY"),("qualification",{**database_raw(),"jobCount":0},"DRIFT"),("firebase",{"status":403,"body":{"error":{"status":"PERMISSION_DENIED"}}},"UNKNOWN")]
        for key,value,verdict in cases:
            with self.subTest(key=key):
                self.tearDown();self.setUp();self.io.override[key]=value
                result=model.Coordinator(self.p,self.adapter(),self.tmp.name,clock=lambda:NOW).run();self.assertEqual(result["verdict"],verdict);self.assertEqual(self.io.calls[-1][0],"close")
    def test_malformed_extra_and_oversize_outputs_refuse_and_close(self):
        for value in ("not-json",b"x"*(launch.MAX_OUTPUT+1),{"unexpected":True}):
            self.tearDown();self.setUp();self.io.override["owner"]=value
            result=model.Coordinator(self.p,self.adapter(),self.tmp.name,clock=lambda:NOW).run();self.assertEqual(result["verdict"],"UNKNOWN");self.assertEqual(self.io.calls[-1][0],"close")
    def test_closeout_failure_never_qualifies(self):
        self.io.override["closeout"]={"sessionsAbsent":False};result=model.Coordinator(self.p,self.adapter(),self.tmp.name,clock=lambda:NOW).run();self.assertEqual(result["status"],"CONTAINMENT_UNCONFIRMED")
    def test_closeout_mode_cannot_perform_normal_reads(self):
        adapter=launch.Adapter(self.b,self.p,self.io,lambda:NOW,mode="closeout")
        self.assertTrue(adapter.closeout(adapter.times["closeoutEnd"]));self.assertEqual([kind for kind,_ in self.io.calls],["sql","close"]);self.assertEqual(self.io.calls[0][1]["id"],"closeout")
    def test_database_projection_never_synthesizes_missing_facts(self):
        changes=[("jobCount",0),("tenantCount",0),("operatorCount",0),("calendarCount",1),("roleCount",1),("sessionCount",1)]
        for key,value in changes:
            with self.subTest(key=key):
                self.tearDown();self.setUp();raw=database_raw();raw[key]=value;self.io.override["qualification"]=raw
                result=model.Coordinator(self.p,self.adapter(),self.tmp.name,clock=lambda:NOW).run();self.assertNotEqual(result["verdict"],"QUALIFIED")
        for key,value in [("email","foreign@example.invalid"),("role","OWNER"),("status","ACTIVE"),("tenantId","40000000-0000-4000-8000-000000000001")]:
            with self.subTest(operator=key):
                self.tearDown();self.setUp();raw=database_raw();raw["operator"][key]=value;self.io.override["qualification"]=raw
                result=model.Coordinator(self.p,self.adapter(),self.tmp.name,clock=lambda:NOW).run();self.assertNotEqual(result["verdict"],"QUALIFIED")
    def test_firebase_claims_and_revocation_are_parsed_and_bounded(self):
        boundary=str(launch.REVOCATION_LOWER_BOUND_MS//1000)
        for patch_value in [{"customAttributes":"{}"},{"validSince":str(int(boundary)-1)},{"validSince":"-1"},{"validSince":"1.5"},{"validSince":"9223372036854775808"},{"validSince":None},{"localId":"40000000-0000-4000-8000-000000000001"},{"tokensValidAfterTime":"2026-10-26T13:18:00Z"}]:
            self.tearDown();self.setUp();user={"localId":UID,"disabled":True,"email":launch.TARGET_EMAIL,"displayName":launch.TARGET_NAME,"customAttributes":json.dumps({"tenantId":model.TENANT,"role":"admin","testOnly":True}),"validSince":boundary};user.update(patch_value);self.io.override["firebase"]={"status":200,"body":{"users":[user]}}
            self.assertNotEqual(model.Coordinator(self.p,self.adapter(),self.tmp.name,clock=lambda:NOW).run()["verdict"],"QUALIFIED")
        self.tearDown();self.setUp();sdk_only={"localId":UID,"disabled":True,"email":launch.TARGET_EMAIL,"displayName":launch.TARGET_NAME,"customAttributes":json.dumps({"tenantId":model.TENANT,"role":"admin","testOnly":True}),"tokensValidAfterTime":"2026-10-26T13:18:00Z"};self.io.override["firebase"]={"status":200,"body":{"users":[sdk_only]}};self.assertNotEqual(model.Coordinator(self.p,self.adapter(),self.tmp.name,clock=lambda:NOW).run()["verdict"],"QUALIFIED")
    def test_exact_private_input_purge_checks_scope_mode_and_absence(self):
        directory=Path(self.tmp.name);paths=[directory/"plan.json",directory/"binding.json"]
        for path in paths:path.write_text("{}\n");os.chmod(path,0o600)
        self.assertTrue(launch.purge_private_inputs(directory,paths));self.assertTrue(all(not path.exists() for path in paths));receipt=json.loads((directory/"private-input-retirement.json").read_text());self.assertTrue(receipt["privateInputsAbsent"]);self.assertEqual(receipt["absence"],{"plan.json":True,"binding.json":True})
    def test_native_sql_executes_only_exact_read_contract_without_locked_substitution(self):
        completed=subprocess.CompletedProcess([],0,stdout=json.dumps(database_raw()).encode(),stderr=b"")
        with patch("subprocess.run",return_value=completed) as run:
            value=launch.NativeIO(lambda:NOW,self.p["operationId"]).sql(launch.sql_contract()[0],"private-password",NOW+10)
        self.assertEqual(value,database_raw());argv=run.call_args.args[0];self.assertIn(launch.QUALIFICATION_SQL,argv);self.assertNotIn("private-password",argv);self.assertEqual(run.call_args.kwargs["stdin"],subprocess.DEVNULL);self.assertEqual(run.call_args.kwargs["stderr"],subprocess.DEVNULL)
    def test_bound_stop_purges_exact_inputs_before_any_password_prompt(self):
        directory=Path(self.tmp.name);paths=[directory/"plan.json",directory/"binding.json"]
        paths[0].write_text(json.dumps(self.p));bad={**self.b,"externalReadAuthorized":False};paths[1].write_text(json.dumps(bad))
        for path in paths:os.chmod(path,0o600)
        with patch("getpass.getpass",side_effect=AssertionError("credential prompt forbidden")),self.assertRaises(model.Stop):launch.native(["--qualify",str(paths[0]),str(paths[1]),str(directory)])
        self.assertTrue(all(not path.exists() for path in paths));self.assertTrue(json.loads((directory/"private-input-retirement.json").read_text())["privateInputsAbsent"])
    def test_disabled_service_and_role_definition_drift_are_not_ready_or_drift(self):
        self.io.override["service_0"]={"status":200,"body":{"state":"DISABLED"}}
        result=model.Coordinator(self.p,self.adapter(),self.tmp.name,clock=lambda:NOW).run();self.assertEqual(result["verdict"],"NOT_READY")
        self.tearDown();self.setUp();self.io.override["lookup_role"]={"name":model.LOOKUP_ROLE,"includedPermissions":["foreign.permission"],"stage":"GA","deleted":False}
        result=model.Coordinator(self.p,self.adapter(),self.tmp.name,clock=lambda:NOW).run();self.assertEqual(result["verdict"],"DRIFT")
    def test_no_private_values_in_journal(self):
        model.Coordinator(self.p,self.adapter(),self.tmp.name,clock=lambda:NOW).run();data="".join(x.read_text() for x in Path(self.tmp.name).iterdir());self.assertNotIn("private-password",data);self.assertNotIn("Bearer ",data);self.assertNotIn("x"*32,data)


if __name__=="__main__":unittest.main()
