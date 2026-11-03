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
            def close(self):pass
        descriptor=launch.access_https_contract("123456789012",self.p["prospectiveKeyId"])[1]
        with patch("urllib.request.build_opener",return_value=type("Opener",(),{"open":lambda self,*a,**k:OversizeResponse()})()),self.assertRaises(model.Stop) as raised:
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
        with patch.object(launch.NativeIO,"_owned_run",return_value=completed.stdout) as run:
            value=launch.NativeIO(lambda:NOW,self.p["operationId"]).sql(launch.sql_contract()[0],"private-password",NOW+10)
        self.assertEqual(value,database_raw());argv=run.call_args.args[0];self.assertIn(launch.QUALIFICATION_SQL,argv);self.assertNotIn("private-password",argv);self.assertEqual(run.call_args.args[1]["PGSSLMODE"],"verify-full");self.assertNotIn("DATABASE_URL",run.call_args.args[1])
    def test_valid_legacy_external_binding_is_now_refused_before_credentials(self):
        directory=Path(self.tmp.name);paths=[directory/'plan.json',directory/'binding.json']
        for path,value in zip(paths,[self.p,self.b]):path.write_text(json.dumps(value));os.chmod(path,0o600)
        with patch.object(model.time,'time',return_value=NOW),patch('getpass.getpass') as password,patch.object(launch,'NativeIO') as native:
            with self.assertRaisesRegex(model.Stop,'CURRENT_NATIVE_ENTRY_UNBOUND'):
                launch.native(['--qualify',str(paths[0]),str(paths[1]),str(directory)])
            password.assert_not_called();native.assert_not_called()
        self.assertTrue(all(not path.exists() for path in paths))

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



class CurrentProofTests(unittest.TestCase):
    def setUp(self):
        import sys,time,uuid,shutil,importlib.util
        path=model.ROOT.parent.parent/'p08-native-entry-local-20261101/source'
        sys.path.insert(0,str(path))
        import test_entry
        self.native=test_entry.EntryTests();self.native.setUp();self.addCleanup(self.native.doCleanups)
        self.scope={k:copy.deepcopy(self.native.e[k]) for k in ('plan','target','database','resources','limits')}
        self.now=int(time.time());self.p=plan();self.p['operationId']=str(uuid.uuid4())
        self.p['prospectiveOperationId']=self.scope['plan']['operationId'];self.p['prospectiveKeyId']='signmons-p08-'+self.p['prospectiveOperationId'].replace('-','')
        iso=lambda x:dt.datetime.fromtimestamp(self.now+x,dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        self.p['window']={k:iso(v) for k,v in {'start':-10,'cutoff':30,'readEnd':60,'closeoutEnd':400,'purgeEnd':1000}.items()}
        self.p['readInventory']=model.read_inventory(self.p)
        self.p.update(producerDecision='APPROVE_LOCAL_CURRENT_EVIDENCE_PROOF',producerManifestSha256=launch.source_manifest_sha256(),nativeScopeSha256=model.digest(self.scope))
        self.root=Path('/private/tmp/p08-current-proof-'+self.p['operationId'])
        self.addCleanup(lambda:shutil.rmtree(self.root,ignore_errors=True))
        self.raw=database_raw();self.raw['roleCount']=1;self.raw['operator']={**self.scope['target'],'status':'DISABLED'}
        # Preserve inspected ownership serialization order.
        self.raw['operator']={k:self.raw['operator'][k] for k in ('id','tenantId','email','fullName','role','status')}
        self.acl=launch.current_module('acl')
        self.environment=[{'name':k,'value':v} for k,v in {
            'NODE_ENV':'production','GOOGLE_CLOUD_PROJECT':'signmons','DEV_AUTH_ENABLED':'false','SCHEDULING_ENABLED':'false',
            'STRIPE_WEBHOOK_LIVEMODE':'false','SMS_DELIVERY_ENABLED':'false','BACKGROUND_WORKERS_ENABLED':'false',
            'STAGING_PHONE_TEST_ENABLED':'false','ENABLED_TOOLS':'none','WEBCHAT_INTEGRATIONS_JSON':'[]','TWILIO_TENANT_IDENTITIES_JSON':'[]',
            'CUSTOMER_PAYMENT_RETURN_URL':'https://fixture.invalid/payment-return'}.items()]
        for name,secret in zip(('DATABASE_URL','STRIPE_WEBHOOK_SECRET','OPENAI_API_KEY','ADMIN_API_TOKEN','CONVERSATION_DATA_ENCRYPTION_KEY','TECHNICIAN_LINK_SECRET'),launch.SECRETS):
            self.environment.append({'name':name,'valueFrom':{'secretKeyRef':{'name':secret,'key':'1'}}})
        self.environment.append({'name':'STRIPE_SECRET_KEY','valueFrom':{'secretKeyRef':{'name':'signmons-staging-stripe-secret-key','key':'1'}}})
        self.b=binding(self.p);self.b.update(candidateImage=self.scope['resources']['image'],normalRevision=self.scope['resources']['normalRevision'])
        case=self
        class CurrentIO(FakeIO):
            proof=True
            def cli(obj,d,deadline):
                if d['id']=='stripe_state':
                    obj.calls.append(('cli',d));return obj.override.get('stripe_state',{'name':'projects/123456789012/secrets/signmons-staging-stripe-secret-key/versions/1','state':'ENABLED'})
                value=super().cli(d,deadline)
                if d['id']=='revision' and 'revision' not in obj.override:value['spec']['containers'][0]['env']=copy.deepcopy(case.environment)
                if d['id']=='service' and 'service' not in obj.override:value['metadata']={'name':launch.SERVICE}
                if d['id'].startswith('secret_state_') and d['id'] not in obj.override:
                    value['name']='projects/123456789012/secrets/'+launch.SECRETS[int(d['id'].split('_')[-1])]+'/versions/1'
                return value
            def https(obj,d,token,deadline):
                obj.calls.append(('https',d));i=d['id']
                if i in obj.override:return copy.deepcopy(obj.override[i])
                if i.startswith('service_'):return {'status':200,'body':{'name':d['url'].split('/v1/')[1],'state':'ENABLED'}}
                if d['body'] and 'permissions' in d['body']:return {'status':200,'body':{'permissions':d['body']['permissions']}}
                if i=='key_absence':return {'status':404,'body':{'error':{'code':404,'status':'NOT_FOUND'}}}
                return {'status':200,'body':{'users':[{'localId':case.scope['target']['id'],'disabled':True,
                    'email':launch.TARGET_EMAIL,'displayName':launch.TARGET_NAME,'customAttributes':json.dumps({'tenantId':model.TENANT,'role':'admin','testOnly':True}),
                    'validSince':str(launch.REVOCATION_LOWER_BOUND_MS//1000)}]}}
            def sql(obj,d,password,deadline):
                obj.calls.append(('sql',d));i=d['id']
                if i in obj.override:return copy.deepcopy(obj.override[i])
                if i=='qualification':return copy.deepcopy(case.raw)
                if i=='closeout':return {'sessionsAbsent':True}
                rows=case.acl.expected_retired_acl()
                for row in rows:
                    if row['kind']=='database':row['object']=case.scope['database']['database']
                return dict(role='p07_payment_runtime',database=case.scope['database']['database'],user=case.scope['database']['user'],
                    count=1,login=False,limit=0,expiryFinite=True,expired=True,unsafe=False,memberships=0,owned=0,sessions=0,
                    schemaCreate=False,databaseTemp=False,acl=rows)
            def close(obj,deadline):obj.closed=True;return obj.override.get('close_result',True)
            def independent(obj):
                fresh=CurrentIO(obj.b,obj.p);fresh.override=copy.deepcopy(obj.override);case.fresh=fresh;return fresh
        self.io=CurrentIO(self.b,self.p);self.fresh=None
        for name,value in [('PROJECT_NUMBER_SHA256',model.digest('123456789012')),('BILLING_ACCOUNT_SHA256',hashlib.sha256(b'billingAccounts/ABCDEF-123456').hexdigest()),
                           ('TARGET_SHA256',hashlib.sha256(json.dumps(self.raw['operator'],separators=(',',':')).encode()).hexdigest()),
                           ('TARGET_NAME',self.scope['target']['fullName'])]:
            patcher=patch.object(launch,name,value);patcher.start();self.addCleanup(patcher.stop)
    def run_proof(self):return launch.produce_native_qualification(self.p,self.scope,self.io,lambda:self.now)
    def test_current_positive_exact_counts_and_native_scope(self):
        result=self.run_proof();self.assertEqual(result['status'],'CURRENT_EVIDENCE_LOCAL_VERIFIED',result)
        self.assertFalse(result['liveObserved'] or result['executionReady'])
        self.assertEqual(result['candidate']['scopeSha256'],model.digest(self.scope))
        self.assertEqual([sum(k==kind for k,d in self.io.calls) for kind in ('cli','https','sql')],[27,20,3])
        self.assertEqual([k for k,d in self.fresh.calls],['sql']);self.assertTrue(self.io.closed and self.fresh.closed)
        text=''.join(p.read_text() for p in self.root.glob('*.json'))
        for secret in ('private-password','SYNTHETIC_CURRENT_PROOF_ONLY',self.scope['target']['email']):self.assertNotIn(secret,text)
        with self.assertRaises(FileExistsError):self.run_proof()
    def test_each_permission_resource_missing_never_qualifies(self):
        for d in launch.current_https_contract('123456789012',self.p['prospectiveKeyId']):
            if not d['body'] or 'permissions' not in d['body']:continue
            with self.subTest(d=d['id']):
                import shutil
                shutil.rmtree(self.root,ignore_errors=True);self.io.calls=[];self.io.closed=False
                self.io.override={d['id']:{'status':200,'body':{'permissions':[]}}}
                r=self.run_proof();self.assertIsNone(r['candidate']);self.assertEqual(r['failure'],'OWNER_PERMISSION_NOT_READY')
                self.assertTrue(self.io.closed and self.fresh.closed)
    def test_no_external_or_cross_scope_proof_before_io(self):
        self.io.proof=False
        with self.assertRaisesRegex(model.Stop,'CURRENT_PROOF_ONLY'):self.run_proof()
        self.io.proof=True;self.scope['limits']['cli']-=1
        with self.assertRaisesRegex(model.Stop,'CURRENT_DECISION_BINDING'):self.run_proof()
        self.assertEqual(self.io.calls,[])
    def test_concurrent_reservation_and_expired_entry_refuse_before_dispatch(self):
        import threading
        started=threading.Event();release=threading.Event();out=[];original=self.io.cli
        def waiting(d,t):
            if d['id']=='owner':started.set();release.wait(5)
            return original(d,t)
        self.io.cli=waiting
        def worker():
            try:out.append(self.run_proof())
            except BaseException as error:out.append(error)
        thread=threading.Thread(target=worker);thread.start()
        try:
            self.assertTrue(started.wait(5));before=len(self.io.calls)
            with self.assertRaises(FileExistsError):self.run_proof()
            self.assertEqual(len(self.io.calls),before)
        finally:release.set();thread.join(10)
        self.assertFalse(thread.is_alive());self.assertEqual(out[0]['status'],'CURRENT_EVIDENCE_LOCAL_VERIFIED',out)
        with self.assertRaisesRegex(model.Stop,'START_CUTOFF'):
            launch.produce_native_qualification(self.p,self.scope,self.io,lambda:self.now+31)

    def test_clock_rollback_during_reads_remains_unqualified(self):
        now=[self.now];original=self.io.cli
        def rollback(d,t):
            value=original(d,t);now[0]-=1;return value
        self.io.cli=rollback
        with self.assertRaisesRegex(model.Stop,'PURGE_DEADLINE'):
            launch.produce_native_qualification(self.p,self.scope,self.io,lambda:now[0])
        self.assertTrue(self.io.closed and self.fresh.closed)

    def test_independent_crash_readback_never_promotes_lost_process_history(self):
        self.root.mkdir(mode=0o700)
        fd=os.open(self.root/'entry.lock',os.O_CREAT|os.O_WRONLY,0o600);os.close(fd)
        model.reserve(self.root/'attempt.json',{'operationId':self.p['operationId'],'scopeSha256':self.p['nativeScopeSha256']})
        result=launch.recover_current_proof(self.p,self.scope,self.io,lambda:self.now+31)
        self.assertIsNone(result['candidate']);self.assertIn('OWNED_PROCESS_HISTORY_UNKNOWN',result['residuals'])
        self.assertTrue(self.io.closed);self.assertEqual([k for k,d in self.io.calls],['sql'])
        with self.assertRaises(FileExistsError):launch.recover_current_proof(self.p,self.scope,self.io,lambda:self.now+31)

    def test_environment_duplicates_unknown_fields_and_observed_hash_not_baseline(self):
        for change in ('duplicate','literal','secret','url','extra'):
            rows=copy.deepcopy(self.environment)
            if change=='duplicate':rows[-1]=rows[0]
            if change=='literal':rows[0]['value']='development'
            if change=='secret':rows[-1]['valueFrom']['secretKeyRef']['key']='latest'
            if change=='url':next(r for r in rows if r['name']=='CUSTOMER_PAYMENT_RETURN_URL')['value']='http://fixture.invalid'
            if change=='extra':rows[0]['valueFrom']={}
            with self.assertRaises(model.Stop):launch.environment_digest(rows)
    def test_strict_json_rejects_duplicate_and_nonfinite(self):
        for raw in ('{"x":1,"x":2}','{"x":NaN}',b'\xff',b'x'*65537):
            with self.assertRaises(model.Stop):launch.strict_json(raw)
    def test_cleanup_failure_has_no_candidate(self):
        self.io.override['close_result']=False;r=self.run_proof()
        self.assertIsNone(r['candidate']);self.assertIn('CLOSEOUT_UNCONFIRMED',r['residuals'])
    def test_unknown_and_role_or_business_drift_fail_closed(self):
        cases={'role_absent':{'qualification':{**self.raw,'roleCount':0}},
               'wrong_job':{'qualification':{**self.raw,'job':{**self.raw['job'],'id':'foreign'}}},
               'missing_firebase':{'firebase':{'status':200,'body':{'users':[]}}},
               'session':{'closeout':{'sessionsAbsent':False}},
               'bill':{'billing_account':{'open':False}},
               'malformed_policy':{'project_policy':{'bindings':[{'role':'roles/viewer','members':[None]}]}}}
        import shutil
        for name,changes in cases.items():
            with self.subTest(case=name):
                shutil.rmtree(self.root,ignore_errors=True);self.io.override=changes;self.io.calls=[];self.io.closed=False
                r=self.run_proof();self.assertIsNone(r['candidate'])

class OwnedProcessTests(unittest.TestCase):
    def test_real_child_success_oversize_timeout_and_group_cleanup(self):
        import time,sys,uuid
        for script,seconds,success in [("print('synthetic')",5,True),("print('x'*70000)",5,False),('import time;time.sleep(20)',2.3,False)]:
            io=launch.NativeIO(time.time,str(uuid.uuid4()))
            try:
                if success:self.assertEqual(io._owned_run([sys.executable,'-c',script],{'PATH':'/usr/bin:/bin'},time.time()+seconds),b'synthetic\n')
                else:
                    with self.assertRaises(model.Stop):io._owned_run([sys.executable,'-c',script],{'PATH':'/usr/bin:/bin'},time.time()+seconds)
                self.assertTrue(io.close(time.time()+2));self.assertFalse(io.children)
            finally:io.close(time.time()+2)
    def test_interruption_and_exited_leader_do_not_leave_owned_group(self):
        import signal,time,sys,uuid
        io=launch.NativeIO(time.time,str(uuid.uuid4()))
        old=signal.signal(signal.SIGALRM,lambda *_:(_ for _ in ()).throw(KeyboardInterrupt()))
        try:
            signal.setitimer(signal.ITIMER_REAL,.1)
            with self.assertRaises(model.Stop):io._owned_run([sys.executable,'-c','import time;time.sleep(20)'],{'PATH':'/usr/bin:/bin'},time.time()+5)
        finally:
            signal.setitimer(signal.ITIMER_REAL,0);signal.signal(signal.SIGALRM,old)
            self.assertTrue(io.close(time.time()+3))
        io=launch.NativeIO(time.time,str(uuid.uuid4()))
        script="import subprocess,sys;subprocess.Popen([sys.executable,'-c','import time;time.sleep(20)']);print('synthetic-leader-exit')"
        try:
            with self.assertRaises(model.Stop):io._owned_run([sys.executable,'-c',script],{'PATH':'/usr/bin:/bin'},time.time()+3)
        finally:self.assertTrue(io.close(time.time()+4));self.assertFalse(io.children)

    def test_unknown_group_probe_is_not_absence(self):
        import time,uuid
        io=launch.NativeIO(time.time,str(uuid.uuid4()))
        class Owned:
            pid=12345
            def poll(self):return 0
        with patch('os.killpg',side_effect=PermissionError()):
            with self.assertRaisesRegex(model.Stop,'PROCESS_OWNERSHIP_UNKNOWN'):
                io._group_alive(Owned(),time.monotonic()+.02)

    def test_actual_sdk_serializer_and_http_error_close_without_external_calls(self):
        import time,uuid,urllib.error
        transport=launch.NativeIO(time.time,str(uuid.uuid4()));descriptor=launch.current_cli_contract()[0]
        with patch.object(transport,'_owned_run',return_value=b'[]') as child:
            self.assertEqual(transport.cli(descriptor,time.time()+10),b'[]')
            argv,env,deadline=child.call_args.args
            self.assertEqual(argv,descriptor['argv']);self.assertEqual(argv[0],launch.GCLOUD)
            self.assertNotIn('DATABASE_URL',env)
            with self.assertRaisesRegex(model.Stop,'CLI_SCOPE'):
                transport.cli({'id':'owner','argv':(launch.GCLOUD,'secrets','versions','access','latest')},time.time()+10)
            self.assertEqual(child.call_count,1)
        body=io.BytesIO(b'{"error":{"code":403}}')
        d=launch.current_https_contract('123456789012','signmons-p08-'+'0'*32)[0]
        error=urllib.error.HTTPError(d['url'],403,'synthetic',{},body)
        with patch('urllib.request.build_opener') as opener:
            opener.return_value.open.side_effect=error
            self.assertEqual(transport.https(d,'x'*32,time.time()+5)['status'],403)
        self.assertTrue(body.closed)

    def test_slow_http_body_is_bounded_and_closed(self):
        import time,uuid
        class Slow:
            status=200;closed=False
            def read(self,n):time.sleep(.3);return b'{}'
            def close(self):self.closed=True
        response=Slow();io=launch.NativeIO(time.time,str(uuid.uuid4()))
        d=launch.current_https_contract('123456789012','signmons-p08-'+'0'*32)[0]
        with patch('urllib.request.build_opener') as opener:
            opener.return_value.open.return_value=response
            started=time.monotonic()
            with self.assertRaisesRegex(model.Stop,'HTTPS_REFUSED'):io.https(d,'x'*32,time.time()+.05)
            self.assertLess(time.monotonic()-started,.25)
        self.assertTrue(response.closed)

    def test_http_redirect_and_error_response_closed(self):
        import time,uuid
        d=launch.current_https_contract('123456789012','signmons-p08-'+'0'*32)[0]
        class Response:
            closed=False
            def __init__(self,status,body):self.status=status;self.body=body
            def read(self,n):return self.body[:n]
            def close(self):self.closed=True
        for status,body in [(302,b'{}'),(200,b'x'*65537),(403,b'{}')]:
            r=Response(status,body);io=launch.NativeIO(time.time,str(uuid.uuid4()))
            with patch('urllib.request.build_opener') as opener:
                opener.return_value.open.return_value=r
                if status==403:self.assertEqual(io.https(d,'x'*32,time.time()+5)['status'],403)
                else:
                    with self.assertRaises(model.Stop):io.https(d,'x'*32,time.time()+5)
            self.assertTrue(r.closed)


class ExternalBindingTests(unittest.TestCase):
    def setUp(self):
        import tempfile,subprocess,shutil
        self.case=CurrentProofTests();self.case.setUp();self.addCleanup(self.case.doCleanups)
        t=self.case;t.scope['database']={'host':launch._operator_module().DB_HOST,'port':5432,'database':'neondb','user':'neondb_owner'}
        t.p['nativeScopeSha256']=model.digest(t.scope)
        self.temp=tempfile.TemporaryDirectory(dir='/private/tmp',prefix='p08-binding-git-');self.addCleanup(self.temp.cleanup)
        self.repo=Path(self.temp.name)
        config=self.repo/'synthetic-config';config.mkdir(mode=0o700);(config/'configurations').mkdir(mode=0o700)
        (config/'active_config').write_text('default\n');(config/'configurations/config_default').write_text('[core]\naccount = '+model.OWNER+'\nproject = signmons\n')
        cp=patch.object(launch,'CONFIG_ROOT',config);cp.start();self.addCleanup(cp.stop)
        self.git=lambda *args:subprocess.check_output(['/usr/bin/git',*args],cwd=self.repo,stderr=subprocess.DEVNULL).decode().strip()
        self.git('init','-q');self.git('config','user.name','Synthetic Proof');self.git('config','user.email','proof@example.invalid')
        authority=launch.current_module('authority');self.authority=authority;self.real_committed=authority.committed
        manifest=model.verify_local_manifest();paths=[model.ROOT/'source-manifest.json',*[model.ROOT/n for n in manifest['files']],
            *[model.ROOT.parent.parent/n for n in manifest['producerDependencies']],*model.SOURCE_PATHS.values()]
        for p in paths:
            dest=self.repo/p.relative_to(authority.BACKEND);dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(p.read_bytes())
        self.git('add','.');self.git('-c','core.hooksPath=/dev/null','commit','-qm','synthetic exact source')
        self.e={'version':1,'plan':t.p,'nativeScope':t.scope,'sourceCommit':self.git('rev-parse','HEAD'),
            'manifestSha256':launch.source_manifest_sha256(),'sdkReview':manifest['sdkReview']}
        self.bind_decision()
        self.root=Path('/private/tmp/p08-current-external-'+t.p['operationId']);self.addCleanup(lambda:shutil.rmtree(self.root,ignore_errors=True))
    def bind_decision(self,action="APPROVE_EXACT_P08_CURRENT_QUALIFICATION"):
        self.e.pop('decision',None)
        decision={'owner':'Debynyhan Banks','decision':action,'externalReadAuthorized':True,
            'scopeSha256':model.digest(self.e)}
        path='APP013_P08_CURRENT_QUALIFICATION_20261103.json';raw=json.dumps(decision,sort_keys=True).encode()
        (self.repo/path).write_bytes(raw);self.git('add',path);self.git('-c','core.hooksPath=/dev/null','commit','--allow-empty','-qm','synthetic owner decision')
        self.e['decision']={'commit':self.git('rev-parse','HEAD'),'path':path,'sha256':model.digest(raw)}
    def read_commit(self,repo,commit,path):return self.real_committed(self.repo,commit,path)
    def cap(self,mode='qualify'):return launch.QualificationCapability(self.e,lambda:self.case.now,mode,self.read_commit)
    def test_actual_committed_decision_and_source_before_credentials(self):
        with patch.object(launch,'hidden_password',side_effect=AssertionError('must not prompt')):
            cap=self.cap();self.assertEqual(cap.counts,{'cli':0,'https':0,'sql':0,'cache':0})
        self.assertFalse(cap.root.exists());self.assertEqual(cap.e['sdkReview']['limits']['cache'],1)
    def test_forged_uncommitted_wrong_action_and_source_refuse(self):
        for field,value in [('sha256','0'*64),('commit','0'*40),('path','APP013_P08_NATIVE_OPERATION_20261103.json')]:
            saved=copy.deepcopy(self.e)
            with self.subTest(field=field):
                self.e['decision'][field]=value
                with self.assertRaises(Exception):self.cap()
                self.e=saved
        self.bind_decision(action='APPROVE_EXACT_P08_NATIVE_ENTRY')
        with self.assertRaisesRegex(model.Stop,'QUALIFIER_OWNER_APPROVAL'):self.cap()
        self.e['sourceCommit']='0'*40;self.bind_decision()
        with self.assertRaises(Exception):self.cap()
    def test_scope_unknown_field_budget_and_expiry_refuse(self):
        for mutate in [lambda e:e.update(extra=True),lambda e:e['plan'].update(extra=True),
            lambda e:e['sdkReview']['limits'].update(cache=2),lambda e:e['nativeScope']['database'].update(host='foreign.invalid'),
            lambda e:e['plan']['window'].update(cutoff=e['plan']['window']['start'])]:
            saved=copy.deepcopy(self.e);mutate(self.e)
            with self.assertRaises(Exception):self.cap()
            self.e=saved
    def test_complete_external_branch_with_injected_observations_and_no_native_entry(self):
        cap=self.cap();t=self.case
        with patch.object(launch,'hidden_password',return_value='SYNTHETIC_HIDDEN_PASSWORD') as password:
            result=launch._produce_current(t.p,t.scope,t.io,lambda:t.now,capability=cap)
        self.assertEqual(result['status'],'CURRENT_EVIDENCE_OBSERVED',result)
        self.assertFalse(result['liveObserved'] or result['executionReady']) # injected I/O is not provider evidence
        self.assertEqual(password.call_count,1)
        self.assertEqual(result['candidate']['scopeSha256'],model.digest(t.scope))
        text=''.join(p.read_text() for p in self.root.iterdir())
        self.assertNotIn('SYNTHETIC_HIDDEN_PASSWORD',text);self.assertNotIn(t.scope['target']['email'],text)
        with patch.object(launch,'hidden_password',side_effect=AssertionError('replay prompted')):
            with self.assertRaises(Exception):self.cap()
            with self.assertRaises(FileExistsError):launch._produce_current(t.p,t.scope,t.io,lambda:t.now,capability=cap)
    def test_cleanup_cannot_read_work_and_budget_rollback_refuse(self):
        cap=self.cap();io=launch.QualificationIO(cap,True)
        with self.assertRaisesRegex(model.Stop,'CLOSEOUT_ONLY'):io.cli(launch.current_cli_contract()[0],self.case.now+1)
        with self.assertRaisesRegex(model.Stop,'CLOSEOUT_ONLY'):io.https({},'synthetic',self.case.now+1)
        cap.gate('cache')
        with self.assertRaisesRegex(model.Stop,'QUALIFIER_LIMIT'):cap.gate('cache')
        self.case.now-=1
        with self.assertRaisesRegex(model.Stop,'CLOCK_ROLLBACK'):cap.gate('sql',True)
    def test_recovery_one_read_never_qualifies_or_replays(self):
        cap=self.cap('closeout');self.root.mkdir(mode=0o700)
        model.reserve(self.root/'entry.lock',{})
        model.reserve(self.root/'attempt.json',{'operationId':cap.plan['operationId'],
            'scopeSha256':cap.plan['nativeScopeSha256'],'authoritySha256':cap.hash})
        with patch.object(launch,'hidden_password',return_value='synthetic'),patch.object(launch.QualificationIO,'sql',return_value={'sessionsAbsent':True}) as sql:
            result=launch.recover_current_external(cap)
        self.assertIsNone(result['candidate']);self.assertIn('OWNED_PROCESS_HISTORY_UNKNOWN',result['residuals']);self.assertEqual(sql.call_count,1)
        with self.assertRaises(model.Stop):launch.recover_current_external(cap)
    def test_foreign_inventory_refuses_before_recovery_password(self):
        cap=self.cap('closeout');self.root.mkdir(mode=0o700);model.reserve(self.root/'foreign.json',{})
        with patch.object(launch,'hidden_password',side_effect=AssertionError('must not prompt')):
            with self.assertRaisesRegex(model.Stop,'PRIVATE_INVENTORY'):launch.recover_current_external(cap)
        self.assertTrue((self.root/'foreign.json').exists())
    def test_sdk_environment_overrides_and_pinned_suppression(self):
        safe=launch.sdk_environment({'HOME':'/Users/debynyhanbanks','PATH':'/untrusted','PYTHONPATH':'/untrusted'})
        self.assertEqual(safe['CLOUDSDK_CORE_MAX_LOG_DAYS'],'0');self.assertEqual(safe['CLOUDSDK_CORE_DISABLE_FILE_LOGGING'],'true')
        self.assertNotIn('PYTHONPATH',safe);self.assertEqual(safe['PATH'],'/usr/bin:/bin:/opt/homebrew/bin')
        for key in ('CLOUDSDK_CONFIG','HTTPS_PROXY','GOOGLE_APPLICATION_CREDENTIALS','PGHOST','DATABASE_URL'):
            with self.assertRaises(model.Stop):launch.sdk_environment({'HOME':'/Users/debynyhanbanks',key:'foreign'})
    def test_cli_private_input_is_purged_on_refused_authority_without_prompt(self):
        import shutil
        directory=Path('/private/tmp/p08-current-input-'+self.case.p['operationId']);directory.mkdir(mode=0o700)
        self.addCleanup(lambda:shutil.rmtree(directory,ignore_errors=True));path=directory/'envelope.json'
        bad=copy.deepcopy(self.e);bad['decision']['sha256']='0'*64;model.reserve(path,bad)
        with patch.object(launch,'hidden_password',side_effect=AssertionError('must not prompt')):
            with self.assertRaises(Exception):launch.current_main(['--qualify-current',str(path)])
        self.assertFalse(path.exists() or directory.exists())

    def test_public_dispatch_after_actual_committed_approval(self):
        original=launch.current_module;authority=self.authority
        authority.committed=self.read_commit
        # Save the real reader separately: the injected function still uses real git show.
        self.addCleanup(lambda:setattr(authority,'committed',original('authority').committed))
        def modules(name):return authority if name=='authority' else original(name)
        t=self.case
        def password():
            self.assertTrue((self.root/'attempt.json').exists());return 'synthetic'
        with patch.object(launch,'current_module',side_effect=modules),patch.object(launch,'QualificationIO',return_value=t.io),patch.object(launch,'hidden_password',side_effect=password):
            result=launch.current_dispatch(self.e,'qualify',lambda:t.now)
        self.assertIsNotNone(result['candidate']);self.assertFalse(result['executionReady'] or result['liveObserved'])
    def test_concurrent_recovery_lock_refuses_before_password(self):
        import fcntl,os
        cap=self.cap('closeout');self.root.mkdir(mode=0o700);model.reserve(self.root/'entry.lock',{})
        model.reserve(self.root/'attempt.json',{'operationId':cap.plan['operationId'],'scopeSha256':cap.plan['nativeScopeSha256'],'authoritySha256':cap.hash})
        fd=os.open(self.root/'entry.lock',os.O_WRONLY)
        try:
            fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
            with patch.object(launch,'hidden_password',side_effect=AssertionError('must not prompt')):
                with self.assertRaises(BlockingIOError):launch.recover_current_external(cap)
        finally:os.close(fd)
        self.assertFalse((self.root/'independent-closeout.json').exists())


class CacheBindingTests(unittest.TestCase):
    def setUp(self):
        import tempfile,importlib.util,sys,time
        path=model.ROOT.parent.parent/'p08-narrow-access-check-local-20261101/source'
        sys.path.insert(0,str(path));spec=importlib.util.spec_from_file_location('cache_binding_tests',path/'test_access_check.py')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        self.helper=module;self.acl=module.a
        self.temp=tempfile.TemporaryDirectory(dir='/private/tmp',prefix='p08-binding-cache-');self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.end=int(time.time())+600;self.db=module.make_cache(self.root,self.end+1000)
    def test_actual_cache_expiry_and_token_matching_boundary(self):
        token=self.acl.read_cached_token(self.root,self.end,env={});self.assertEqual(token,'SYNTHETIC_BEARER_NEVER_PERSIST')
        import sqlite3
        with sqlite3.connect(self.db) as c:c.execute('UPDATE access_tokens SET token_expiry=? WHERE account_id=?',('2000-01-01 00:00:00',self.acl.OWNER))
        c.close()
        with self.assertRaisesRegex(self.acl.Stop,'CACHED_TOKEN_EXPIRED'):self.acl.read_cached_token(self.root,self.end,env={})
    def test_foreign_owner_and_sidecar_cache_refuse(self):
        import sqlite3
        sidecar=Path(str(self.db)+'-wal');sidecar.write_bytes(b'synthetic')
        with self.assertRaisesRegex(self.acl.Stop,'CACHE_JOURNAL_UNSUPPORTED'):self.acl.read_cached_token(self.root,self.end,env={})
        sidecar.unlink()
        with sqlite3.connect(self.db) as c:c.execute('DELETE FROM access_tokens WHERE account_id=?',(self.acl.OWNER,))
        c.close()
        with self.assertRaisesRegex(self.acl.Stop,'CACHED_TOKEN_MISSING'):self.acl.read_cached_token(self.root,self.end,env={})
    def test_installed_sdk_log_controls_execute_actual_method_bodies_without_sdk_launch(self):
        import ast,types
        sdk=Path('/opt/homebrew/Caskroom/gcloud-cli/583.0.0/google-cloud-sdk/lib')
        tree=ast.parse((sdk/'googlecloudsdk/core/log.py').read_text())
        methods={node.name:node for node in ast.walk(tree) if isinstance(node,ast.FunctionDef) and node.name in ('AddLogsDir','_CleanUpLogs','_GetMaxLogDays')}
        logtree=ast.Module(body=list(methods.values()),type_ignores=[])
        class Setting:
            def __init__(self,value):self.value=value
            def GetBool(self):return self.value
            def GetInt(self):return self.value
        ns={'properties':types.SimpleNamespace(VALUES=types.SimpleNamespace(core=types.SimpleNamespace(
            disable_file_logging=Setting(True),max_log_days=Setting(0))))}
        exec(compile(logtree,'installed-sdk-log-methods','exec'),ns)
        holder=types.SimpleNamespace(_logs_dirs=[],_CleanLogsDir=lambda _:self.fail('ambient logs deleted'),_SetupLogsDir=lambda _:self.fail('log created'))
        holder._GetMaxLogDays=types.MethodType(ns['_GetMaxLogDays'],holder)
        holder._CleanUpLogs=types.MethodType(ns['_CleanUpLogs'],holder)
        ns['AddLogsDir'](holder,'/synthetic/logs');self.assertEqual(holder._logs_dirs,['/synthetic/logs'])
        tree=ast.parse((sdk/'googlecloudsdk/api_lib/util/api_enablement.py').read_text())
        fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='PromptToEnableApi')
        console_tree=ast.parse((sdk/'googlecloudsdk/core/console/console_io.py').read_text())
        prompt=next(n for n in console_tree.body if isinstance(n,ast.FunctionDef) and n.name=='PromptContinue')
        prompt_ns={'properties':types.SimpleNamespace(VALUES=types.SimpleNamespace(core=types.SimpleNamespace(disable_prompts=Setting(True))))}
        exec(compile(ast.Module(body=[prompt],type_ignores=[]),'installed-sdk-prompt','exec'),prompt_ns)
        ns={'console_io':types.SimpleNamespace(PromptContinue=prompt_ns['PromptContinue']),
            'enable_api':types.SimpleNamespace(EnableService=lambda *_:self.fail('API enable attempted'))}
        exec(compile(ast.Module(body=[fn],type_ignores=[]),'installed-sdk-enable-method','exec'),ns)
        self.assertFalse(ns['PromptToEnableApi']('synthetic','synthetic'))

class CacheTransportTests(CacheBindingTests):
    def test_real_cache_through_transport_compares_token_once_before_https(self):
        import time
        cap=object.__new__(launch.QualificationCapability)
        cap.clock=time.time;cap.plan={'operationId':'12345678-1234-4234-8234-123456789abc'}
        cap.config_root=self.root;cap.config=None;cap.mode='qualify';cap.last=time.time()
        cap.times={'start':cap.last-1,'readEnd':cap.last+50,'closeoutEnd':cap.last+100,'purgeEnd':self.end}
        cap.e={'sdkReview':{'files':{},'limits':{'cli':27,'https':20,'sql':4,'cache':1}}}
        cap.counts={'cli':0,'https':0,'sql':0,'cache':0}
        with patch.dict(launch.os.environ,{'HOME':'/Users/debynyhanbanks'},clear=True):
            io=launch.QualificationIO(cap)
            d=next(d for d in launch.current_cli_contract() if d['id']=='token')
            with patch.object(io,'_owned_run',return_value=b'SYNTHETIC_BEARER_NEVER_PERSIST'):
                self.assertEqual(io.cli(d,cap.times['readEnd']),{'accessToken':'SYNTHETIC_BEARER_NEVER_PERSIST'})
                self.assertEqual(cap.counts['cache'],1)
                with self.assertRaisesRegex(model.Stop,'QUALIFIER_LIMIT'):io.cli(d,cap.times['readEnd'])
            cap.counts={'cli':0,'https':0,'sql':0,'cache':0}
            with patch.object(io,'_owned_run',return_value=b'SYNTHETIC_MISMATCHED_BEARER'):
                with self.assertRaisesRegex(model.Stop,'TOKEN_CACHE_MISMATCH'):io.cli(d,cap.times['readEnd'])
            self.assertEqual(cap.counts['https'],0);self.assertTrue(io.close(cap.times['closeoutEnd']))

# Do not duplicate the helper's three independent cases through subclass discovery.
for _name in list(CacheBindingTests.__dict__):
    if _name.startswith('test_'):setattr(CacheTransportTests,_name,None)

class BindingRecoveryTests(unittest.TestCase):
    def setUp(self):
        import uuid,time,shutil
        self.raw=database_raw();self.now=int(time.time());self.guards=[]
        self.e=self.envelope(self.now)
        self.cap=launch.BindingRecoveryCapability(self.e)
        self.root=self.cap.root
        self.addCleanup(self.cleanup)
        original=launch.start_binding_guard
        def track(cap):
            p=original(cap);self.guards.append(p);return p
        patcher=patch.object(launch,'start_binding_guard',side_effect=track);patcher.start();self.addCleanup(patcher.stop)
        case=self
        class ProofIO:
            proof=True
            def __init__(obj,cap,independent=False):obj.cap=cap;obj.second=independent;obj.calls=[];obj.closed=False;obj.overrides={}
            def cli(obj,d,deadline):
                obj.cap.gate('cli',d['id']);obj.calls.append(('cli',d['id']))
                return copy.deepcopy(obj.overrides.get(d['id'],[{'account':model.OWNER,'status':'ACTIVE'}] if d['id']=='owner' else {'projectId':model.PROJECT,'projectNumber':'123456789012','lifecycleState':'ACTIVE'}))
            def sql(obj,d,password,deadline):
                cleanup=d['id']=='closeout';label=('closeout-independent' if obj.second else 'closeout-main') if cleanup else 'qualification'
                obj.cap.gate('sql',label,cleanup);obj.calls.append(('sql',label))
                if obj.overrides.get('interrupt') and not cleanup:
                    import signal
                    os.kill(os.getpid(),signal.SIGINT)
                return copy.deepcopy(obj.overrides.get(label,{'sessionsAbsent':True} if cleanup else case.raw))
            def close(obj,deadline):obj.closed=True;return obj.overrides.get('close',True)
            def independent(obj):
                fresh=ProofIO(obj.cap,True);fresh.overrides=copy.deepcopy(obj.overrides);case.fresh=fresh;return fresh
        self.io=ProofIO(self.cap);self.fresh=None
    def envelope(self,now,purge=500):
        import uuid
        m=model.verify_local_manifest();iso=lambda x:dt.datetime.fromtimestamp(now+x,dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        e={'version':1,'execution':'PROOF_ONLY','operationId':str(uuid.uuid4()),'qualificationId':str(uuid.uuid4()),
          'project':model.PROJECT,'owner':model.OWNER,'database':{'host':launch._operator_module().DB_HOST,'port':5432,'database':'neondb','user':'neondb_owner'},
          'projectNumberSha256':model.digest('123456789012'),'targetSha256':hashlib.sha256(json.dumps(self.raw['operator'],separators=(',',':')).encode()).hexdigest(),
          'window':{k:iso(v) for k,v in {'start':-10,'cutoff':30,'readEnd':60,'closeoutEnd':400,'purgeEnd':purge}.items()},
          'limits':copy.deepcopy(launch.RECOVERY_LIMITS),'sdkException':'SDK_EXISTING_OWNER_REFRESH_CACHE_INTERNAL_RETRIES_NO_TOKEN_EXPORT',
          'sdkFilesSha256':model.digest(m['sdkReview']['files']),'manifestSha256':launch.source_manifest_sha256(),'sourceCommit':'0'*40}
        return self.seal(e)
    def seal(self,e):
        e.pop('decision',None);e['decision']={'decision':'APPROVE_LOCAL_BINDING_RECOVERY_PROOF','scopeSha256':model.digest(e)};return e
    def cleanup(self):
        import shutil
        for guard in self.guards:
            if guard.poll() is None:
                if self.root.exists() and not (self.root/'purge-now.json').exists():model.reserve(self.root/'purge-now.json',{})
                try:guard.wait(timeout=5)
                except subprocess.TimeoutExpired:guard.terminate();guard.wait(timeout=3)
        shutil.rmtree(self.root,ignore_errors=True);shutil.rmtree(self.cap.input_root,ignore_errors=True)
    def run_recovery(self):return launch.run_binding_recovery(self.cap,self.io)
    def test_positive_two_cli_three_sql_then_private_handoff_and_purge(self):
        r,guard=self.run_recovery();self.assertEqual(r['status'],'HANDOFF_RETAINED',r)
        self.assertFalse(r['liveObserved'] or r['executionReady']);self.assertIsNone(r['candidate'])
        self.assertEqual(self.io.calls,[('cli','owner'),('cli','project'),('sql','qualification'),('sql','closeout-main')])
        self.assertEqual(self.fresh.calls,[('sql','closeout-independent')]);self.assertTrue(self.io.closed and self.fresh.closed)
        h=launch.BindingRecoveryCapability(self.e,mode='handoff')
        self.assertEqual(launch.read_recovered_bindings(h),{'projectNumber':'123456789012','targetId':UID})
        text=''.join(p.read_text() for p in self.root.glob('*.json') if p.name!='recovered-inputs.json')
        for value in ('123456789012',UID,'SYNTHETIC_RECOVERY_ONLY'):self.assertNotIn(value,text)
        model.reserve(self.root/'purge-now.json',{});guard.wait(timeout=5)
        receipt=launch.private_json(self.root/'purge-result.json');self.assertTrue(receipt['rawFilesAbsent'] and receipt['onTime'])
        self.assertFalse((self.root/'recovered-inputs.json').exists())
    def test_same_operation_and_read_reservations_cannot_replay(self):
        self.run_recovery()
        with self.assertRaisesRegex(model.Stop,'RECOVERY_CONSUMED'):launch.BindingRecoveryCapability(self.e)
        with self.assertRaises(FileExistsError):self.cap.gate('cli','owner')
        for kind,label in [('https','anything'),('cache','anything'),('cli','token'),('sql','retired_role')]:
            with self.assertRaises(model.Stop):self.cap.gate(kind,label)
    def test_wrong_owner_stops_before_project_database_or_password(self):
        self.io.overrides['owner']=[{'account':'foreign@example.invalid','status':'ACTIVE'}]
        with patch.object(launch,'hidden_password',side_effect=AssertionError('unexpected credential')):r,g=self.run_recovery()
        self.assertEqual(self.io.calls,[('cli','owner')]);self.assertEqual(r['status'],'BINDING_INPUT_RECOVERY_UNQUALIFIED')
        self.assertFalse((self.root/'recovered-inputs.json').exists());self.assertIsNotNone(g.poll())
    def test_wrong_project_stops_before_database(self):
        self.io.overrides['project']={'projectId':'foreign','projectNumber':'123456789012','lifecycleState':'ACTIVE'}
        r,_=self.run_recovery();self.assertEqual(r['failure'],'RECOVERY_PROJECT')
        self.assertEqual(len(self.io.calls),2);self.assertFalse((self.root/'recovered-inputs.json').exists())
    def test_wrong_target_and_cleanup_failure_never_publish(self):
        self.raw['operator']['status']='ACTIVE';self.io.overrides['close']=False
        r,_=self.run_recovery();self.assertEqual(r['status'],'BINDING_INPUT_RECOVERY_UNQUALIFIED')
        self.assertIn('MAIN_PROCESSES_UNCONFIRMED',r['residuals']);self.assertFalse((self.root/'recovered-inputs.json').exists())
    def test_actual_parent_sigint_closes_both_ports_without_handoff(self):
        self.io.overrides['interrupt']=True;r,g=self.run_recovery()
        self.assertEqual(r['failure'],'INTERRUPTED');self.assertTrue(self.io.closed and self.fresh.closed)
        self.assertFalse((self.root/'recovered-inputs.json').exists());self.assertIsNotNone(g.poll())
    def test_guard_sigterm_purges_its_owned_file(self):
        _,g=self.run_recovery();g.terminate();g.wait(timeout=5)
        self.assertFalse((self.root/'recovered-inputs.json').exists());self.assertTrue(launch.private_json(self.root/'purge-result.json')['rawFilesAbsent'])
    def test_guard_sigkill_requires_explicit_reconciliation_and_no_provider_replay(self):
        _,g=self.run_recovery();g.kill();g.wait(timeout=3)
        self.assertTrue((self.root/'recovered-inputs.json').exists());self.assertFalse((self.root/'purge-result.json').exists())
        c=launch.BindingRecoveryCapability(self.e,mode='closeout')
        with patch.object(launch,'hidden_password',side_effect=AssertionError('replay')):r=launch.closeout_binding_recovery(c)
        self.assertTrue(r['rawFilesAbsent']);self.assertTrue(r['resourceCloseout']['verified']);self.assertIsNone(r['candidate'])
    def test_unknown_replacement_is_not_deleted(self):
        _,g=self.run_recovery();g.kill();g.wait(timeout=3)
        p=self.root/'recovered-inputs.json';raw=p.read_bytes();p.unlink();p.write_bytes(raw);p.chmod(0o600)
        # Force a different inode deterministically, rather than assuming allocator behavior.
        registry=launch.private_json(self.root/'owned-files.json');registry['recovered']['file'][1]=-1
        launch.save_owned_registry(self.cap,registry)
        r=launch.purge_recovery_files(self.cap)
        self.assertFalse(r['rawFilesAbsent']);self.assertTrue(p.exists())
    def test_symlink_and_hardlink_inventory_refuse_without_following(self):
        launch.initialize_recovery(self.cap)
        victim=self.root/'fixture-victim';victim.write_text('synthetic');victim.chmod(0o600)
        p=self.root/'recovered-inputs.json';p.symlink_to(victim)
        with self.assertRaises(model.Stop):launch.purge_recovery_files(self.cap)
        self.assertEqual(victim.read_text(),'synthetic');p.unlink();victim.unlink()
        p.write_text('synthetic');p.chmod(0o600);os.link(p,self.root/'extra-link')
        with self.assertRaises(model.Stop):launch.purge_recovery_files(self.cap)
    def test_deadline_guard_purges_pending_inode_intent(self):
        import time
        # Same source-bound guard, with a valid historic work window ending shortly now.
        e=copy.deepcopy(self.e);iso=lambda x:dt.datetime.fromtimestamp(time.time()+x,dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        e['window']={k:iso(v) for k,v in {'start':-500,'cutoff':-490,'readEnd':-400,'closeoutEnd':-50,'purgeEnd':4}.items()}
        self.seal(e);cap=launch.BindingRecoveryCapability(e,mode='guard');self.cap=cap
        launch.initialize_recovery(cap);g=launch.start_binding_guard(cap)
        with launch.recovery_lock(cap):
            launch.record_private_file(cap,'recovered',{'projectNumber':'123456789012','targetId':UID})
            reg=launch.private_json(self.root/'owned-files.json');reg['recovered']['file']=None;launch.save_owned_registry(cap,reg)
        g.wait(timeout=6);self.assertFalse((self.root/'recovered-inputs.json').exists())
        self.assertTrue(launch.private_json(self.root/'purge-result.json')['onTime'])
    def test_late_purge_reports_retention_breach(self):
        _,g=self.run_recovery();g.kill();g.wait(timeout=3)
        self.cap.clock=lambda:self.cap.times['purgeEnd']+1
        r=launch.purge_recovery_files(self.cap);self.assertTrue(r['rawFilesAbsent']);self.assertFalse(r['onTime']);self.assertEqual(r['status'],'PRIVATE_PURGE_LATE')
    def test_expired_unknown_fields_and_wrong_limits_fail_before_transport(self):
        for mutate in [lambda e:e.update(extra=True),lambda e:e['limits'].update(cli=3),lambda e:e.update(owner='foreign'),lambda e:e['window'].update(purgeEnd='2099-01-01T00:00:00Z')]:
            e=copy.deepcopy(self.e);mutate(e);self.seal(e)
            with self.assertRaises(Exception):launch.BindingRecoveryCapability(e)
        with self.assertRaisesRegex(model.Stop,'RECOVERY_EXTERNAL_ONLY'):launch.BindingRecoveryIO(self.cap)
    def test_malformed_duplicate_and_null_reducer_refuses(self):
        for raw in [None,{}, {**self.raw,'operatorCount':2},{**self.raw,'operator':None},{**self.raw,'extra':1}]:
            with self.assertRaises(Exception):launch.recovery_values(self.cap,[{'account':model.OWNER,'status':'ACTIVE'}],{'projectId':model.PROJECT,'projectNumber':'123456789012','lifecycleState':'ACTIVE'},raw)
        with self.assertRaises(model.Stop):launch.strict_json(b'{"a":1,"a":2}')


    def test_guard_survives_actual_parent_sigkill_and_purges(self):
        import time
        e=copy.deepcopy(self.e);iso=lambda x:dt.datetime.fromtimestamp(time.time()+x,dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        e['window']={k:iso(v) for k,v in {'start':-500,'cutoff':-490,'readEnd':-400,'closeoutEnd':-50,'purgeEnd':6}.items()};self.seal(e)
        input_path=Path(str(self.root)+'-synthetic-request.json');model.reserve(input_path,e);self.addCleanup(lambda:input_path.unlink(missing_ok=True))
        code="""import sys,time
sys.path.insert(0,sys.argv[1])
import qualification_launch as q
c=q.BindingRecoveryCapability(q.private_json(sys.argv[2]),mode='guard')
q.initialize_recovery(c);g=q.start_binding_guard(c)
with q.recovery_lock(c):
 q.record_private_file(c,'recovered',{'projectNumber':'123456789012','targetId':'11111111-2222-4333-8444-555555555555'})
 q.model.reserve(c.root/'handoff-published.json',{'scopeSha256':c.hash})
time.sleep(20)
"""
        parent=subprocess.Popen([launch.SDK_ENV['CLOUDSDK_PYTHON'],'-I','-B','-c',code,str(model.ROOT),str(input_path)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
        try:
            until=time.monotonic()+3
            while time.monotonic()<until and not (self.root/'handoff-published.json').exists():
                self.assertIsNone(parent.poll());time.sleep(.01)
            self.assertTrue((self.root/'recovered-inputs.json').exists())
            guard_pid=launch.private_json(self.root/'guard-ready.json')['pid']
            parent.kill();parent.wait(timeout=3)
            until=time.monotonic()+7
            while time.monotonic()<until and not (self.root/'purge-result.json').exists():time.sleep(.02)
            self.assertTrue(launch.private_json(self.root/'purge-result.json')['rawFilesAbsent'])
            self.assertFalse((self.root/'recovered-inputs.json').exists())
            until=time.monotonic()+2
            while time.monotonic()<until:
                probe=subprocess.run(['/bin/ps','-o','pid=','-p',str(guard_pid)],capture_output=True)
                if probe.returncode==1:break
                time.sleep(.02)
            self.assertEqual(probe.returncode,1,'orphan guard process absence unconfirmed')
        finally:
            if parent.poll() is None:parent.kill();parent.wait(timeout=3)
    def test_handoff_storage_uses_guard_ack_and_same_expiry(self):
        from types import SimpleNamespace
        _,guard=self.run_recovery();self.cap.mode='handoff';self.cap.external=True
        # This test isolates storage transaction after separately tested authority validation.
        plan={k:None for k in ('mode','externalActionAuthorized','automaticRetryAllowed','allowanceUsd','project','projectNumber','projectNumberSha256','tenantId','jobId','ownerPrincipal','runtimeIdentity','serviceRetention','operationId','keyId','window')}
        plan['projectNumber']='123456789012';plan['window']={k:None for k in ('start','cutoff','workEnd','cleanupEnd','purgeEnd')}
        qualified=SimpleNamespace(plan={'operationId':self.e['qualificationId']},times={'purgeEnd':self.cap.times['purgeEnd']},scope={'target':{'id':UID},'plan':plan})
        with patch.object(launch,'QualificationCapability',return_value=qualified):
            r=launch.handoff_recovered_bindings(self.cap,{'synthetic':'noncredential envelope'})
        self.assertEqual(r['status'],'QUALIFICATION_INPUT_TRANSFERRED');self.assertFalse((self.root/'recovered-inputs.json').exists())
        self.assertTrue((self.cap.input_root/'envelope.json').exists())
        self.assertEqual(set(launch.private_json(self.root/'owned-files.json')),{'recovered','qualification'})
        model.reserve(self.root/'purge-now.json',{});guard.wait(timeout=5)
        self.assertFalse((self.cap.input_root/'envelope.json').exists());self.assertTrue(launch.private_json(self.root/'purge-result.json')['rawFilesAbsent'])
    def test_handoff_never_uses_dead_guard_or_extends_expiry(self):
        from types import SimpleNamespace
        _,guard=self.run_recovery();self.cap.mode='handoff';self.cap.external=True
        plan={k:None for k in ('mode','externalActionAuthorized','automaticRetryAllowed','allowanceUsd','project','projectNumber','projectNumberSha256','tenantId','jobId','ownerPrincipal','runtimeIdentity','serviceRetention','operationId','keyId','window')}
        plan['projectNumber']='123456789012';plan['window']={k:None for k in ('start','cutoff','workEnd','cleanupEnd','purgeEnd')}
        qualified=SimpleNamespace(plan={'operationId':self.e['qualificationId']},times={'purgeEnd':self.cap.times['purgeEnd']+1},scope={'target':{'id':UID},'plan':plan})
        with patch.object(launch,'QualificationCapability',return_value=qualified):
            with self.assertRaisesRegex(model.Stop,'RECOVERY_HANDOFF_SCOPE'):launch.handoff_recovered_bindings(self.cap,{})
        guard.kill();guard.wait(timeout=3);qualified.times['purgeEnd']-=1
        with patch.object(launch,'QualificationCapability',return_value=qualified):
            with self.assertRaisesRegex(model.Stop,'PURGE_GUARD_UNCONFIRMED'):launch.handoff_recovered_bindings(self.cap,{})
        self.assertFalse(self.cap.input_root.exists())
        launch.purge_recovery_files(self.cap)


    def test_recovery_closeout_cannot_race_active_parent(self):
        import fcntl
        _,guard=self.run_recovery();fd=os.open(self.root/'entry.lock',os.O_WRONLY)
        try:
            fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
            with patch.object(launch,'hidden_password',side_effect=AssertionError('concurrent closeout prompt')):
                with self.assertRaises(BlockingIOError):launch.closeout_binding_recovery(launch.BindingRecoveryCapability(self.e,mode='closeout'))
            self.assertTrue((self.root/'recovered-inputs.json').exists())
        finally:os.close(fd)
    def test_clock_rollback_refuses_reads_and_guard_purges(self):
        launch.initialize_recovery(self.cap)
        original=self.cap.clock;self.cap.clock=lambda:self.cap.last-1
        with self.assertRaisesRegex(model.Stop,'CLOCK_ROLLBACK'):self.cap.gate('cli','owner')
        self.cap.clock=original
        with launch.recovery_lock(self.cap):launch.record_private_file(self.cap,'recovered',{'projectNumber':'123456789012','targetId':UID})
        now=original();values=iter([now,now-1]);self.cap.clock=lambda:next(values,now-1)
        result=launch.binding_purge_guard(self.cap)
        self.assertTrue(result['rawFilesAbsent']);self.assertFalse((self.root/'recovered-inputs.json').exists())
    def test_lost_resource_history_never_claims_closeout(self):
        launch.initialize_recovery(self.cap)
        r=launch.closeout_binding_recovery(launch.BindingRecoveryCapability(self.e,mode='closeout'))
        self.assertFalse(r['resourceCloseout']['verified']);self.assertIn('OWNED_PROCESS_HISTORY_UNKNOWN',r['resourceCloseout']['residuals'])
        self.assertIsNone(r['candidate'])


    def test_cli_closeout_does_not_confuse_private_purge_with_resource_closeout(self):
        launch.initialize_recovery(self.cap);out=io.StringIO()
        with contextlib.redirect_stdout(out):code=launch.recovery_main(['--closeout-binding-inputs',str(self.root)])
        self.assertEqual(code,2);self.assertEqual(out.getvalue().strip(),'BINDING_RECOVERY_CLOSEOUT_UNCONFIRMED')
        self.assertTrue(launch.private_json(self.root/'purge-result.json')['rawFilesAbsent'])


class BindingRecoveryAuthorityTests(unittest.TestCase):
    def setUp(self):
        import shutil
        self.base=ExternalBindingTests();self.base.setUp();self.addCleanup(self.base.doCleanups)
        helper=BindingRecoveryTests();helper.raw=copy.deepcopy(self.base.case.raw)
        self.e=helper.envelope(self.base.case.now);self.e['execution']='EXTERNAL_READ_ONLY';self.e['sourceCommit']=self.base.e['sourceCommit']
        self.bind()
        self.root=Path('/private/tmp/p08-binding-recovery-'+self.e['operationId']);self.addCleanup(lambda:shutil.rmtree(self.root,ignore_errors=True))
    def bind(self,action='APPROVE_EXACT_P08_BINDING_INPUT_RECOVERY'):
        self.e.pop('decision',None);raw=json.dumps({'owner':'Debynyhan Banks','decision':action,'externalReadAuthorized':True,'scopeSha256':model.digest(self.e)},sort_keys=True).encode()
        name='APP013_P08_BINDING_RECOVERY_OPERATION_20261103.json';(self.base.repo/name).write_bytes(raw)
        self.base.git('add',name);self.base.git('-c','core.hooksPath=/dev/null','commit','--allow-empty','-qm','synthetic recovery decision')
        self.e['decision']={'commit':self.base.git('rev-parse','HEAD'),'path':name,'sha256':model.digest(raw)}
    def cap(self):return launch.BindingRecoveryCapability(self.e,read_commit=self.base.read_commit)
    def test_actual_committed_recovery_decision_is_distinct(self):
        cap=self.cap();self.assertTrue(cap.external);self.assertFalse(self.root.exists())
        self.bind('APPROVE_EXACT_P08_CURRENT_QUALIFICATION')
        with self.assertRaisesRegex(model.Stop,'RECOVERY_OWNER_APPROVAL'):self.cap()
    def test_uncommitted_forged_foreign_fingerprints_and_source_refuse(self):
        saved=copy.deepcopy(self.e)
        for mutate in [lambda e:e['decision'].update(commit='0'*40),lambda e:e['decision'].update(sha256='0'*64),
                       lambda e:e.update(targetSha256='0'*64),lambda e:e.update(projectNumberSha256='0'*64)]:
            mutate(self.e)
            with self.assertRaises(Exception):self.cap()
            self.e=copy.deepcopy(saved)
        self.e['sourceCommit']='0'*40;self.bind()
        with self.assertRaises(Exception):self.cap()
    def test_actual_serializers_only_two_cli_three_sql_no_https_or_cache(self):
        cap=self.cap();launch.initialize_recovery(cap);cap.prepare();io=launch.BindingRecoveryIO(cap)
        with patch.object(io,'_owned_run',return_value=b'[]') as run:
            io.cli(launch.cli_contract()[0],cap.times['readEnd']);io.cli(launch.cli_contract()[2],cap.times['readEnd'])
            self.assertEqual(run.call_count,2);self.assertEqual(run.call_args.args[1]['CLOUDSDK_CORE_MAX_LOG_DAYS'],'0')
            with self.assertRaises(FileExistsError):io.cli(launch.cli_contract()[0],cap.times['readEnd'])
            token=next(d for d in launch.cli_contract() if d['id']=='token')
            with self.assertRaises(model.Stop):io.cli(token,cap.times['readEnd'])
        with patch.object(io,'_owned_run',return_value=b'{"sessionsAbsent":true}') as run:
            io.sql(launch.sql_contract()[0],'SYNTHETIC',cap.times['readEnd']);io.sql(launch.sql_contract()[1],'SYNTHETIC',cap.times['closeoutEnd'])
            self.assertEqual(run.call_count,2);self.assertEqual(run.call_args.args[1]['PGSSLMODE'],'verify-full')
        fresh=io.independent()
        with patch.object(fresh,'_owned_run',return_value=b'{"sessionsAbsent":true}') as run:
            fresh.sql(launch.sql_contract()[1],'SYNTHETIC',cap.times['closeoutEnd']);self.assertEqual(run.call_count,1)
            with self.assertRaises(FileExistsError):fresh.sql(launch.sql_contract()[1],'SYNTHETIC',cap.times['closeoutEnd'])
            with self.assertRaises(model.Stop):fresh.sql(launch.sql_contract()[0],'SYNTHETIC',cap.times['closeoutEnd'])
        with self.assertRaises(model.Stop):io.https({},'synthetic',cap.times['readEnd'])
        self.assertTrue(io.close(cap.times['closeoutEnd']) and fresh.close(cap.times['closeoutEnd']))
    def test_refused_cli_purges_private_request_before_any_credential(self):
        import shutil
        root=Path('/private/tmp/p08-binding-request-'+self.e['operationId']);root.mkdir(mode=0o700);self.addCleanup(lambda:shutil.rmtree(root,ignore_errors=True))
        path=root/'envelope.json';model.reserve(path,self.e)
        with patch.object(launch,'hidden_password',side_effect=AssertionError('credentials before authority')):
            with self.assertRaises(Exception):launch.recovery_main(['--recover-binding-inputs',str(path)])
        self.assertFalse(path.exists() or root.exists())


if __name__=="__main__":unittest.main()
