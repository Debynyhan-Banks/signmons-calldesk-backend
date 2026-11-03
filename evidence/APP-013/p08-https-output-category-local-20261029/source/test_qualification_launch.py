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


if __name__=="__main__":unittest.main()
