import contextlib,copy,datetime as dt,hashlib,io,json,os,socket,subprocess,tempfile,unittest
from pathlib import Path
from unittest.mock import patch

import composed_qualification as model
import qualification_launch as launch
from test_composed_qualification import NOW,access,cloud,database,firebase,plan


def binding(p):
    environment=[{"name":"A"},{"name":"B"}]
    b={"mode":"P08_READ_ONLY_QUALIFICATION_LAUNCH","proposalSha256":launch.APPROVAL_SHA256,"planSha256":model.digest(p),"sourceManifestSha256":launch.source_manifest_sha256(),"externalReadAuthorized":True,"mutationsAuthorized":False,"allowanceUsd":0,"automaticRetryAllowed":False,"operationId":p["operationId"],"prospectiveOperationId":p["prospectiveOperationId"],"cliLimit":26,"httpsLimit":10,"sqlLimit":2,"projectNumber":"123456789012","billingAccountResource":"billingAccounts/ABCDEF-123456","firebaseUid":"11111111-2222-4333-8444-555555555555","candidateImage":"us-east5-docker.pkg.dev/signmons/signmons/signmons-calldesk-backend@sha256:"+"a"*64,"environmentSha256":model.digest(environment),"normalRevision":"signmons-calldesk-staging-app013dbrot2","databasePassword":"private-password","firebase":{"email":"debynyhan@signmons.com","displayName":"Debynyhan Banks","customAttributes":"{\"role\":\"admin\",\"testOnly\":true,\"tenantId\":\"a1adcfd4-15be-404b-9ac3-5edb1fda20f0\"}","tokensValidAfterTime":"2026-10-26T13:15:00Z"}}
    b["ownerApproval"]={"decision":"APPROVE_EXACT_P08_READ_ONLY_QUALIFICATION","owner":"Debynyhan Banks","operationId":p["operationId"],"bindingSha256":model.digest({k:v for k,v in b.items() if k!="databasePassword"})}
    return b


class FakeIO:
    def __init__(self,b,p):self.b=b;self.p=p;self.calls=[];self.closed=False;self.override={}
    def cli(self,d,deadline):
        self.calls.append(("cli",d));i=d["id"]
        values={"owner":[{"account":model.OWNER,"status":"ACTIVE"}],"config":{"core":{"project":model.PROJECT},"auth":{}},"project":{"projectId":model.PROJECT,"projectNumber":self.b["projectNumber"],"lifecycleState":"ACTIVE"},"billing_project":{"billingAccountName":"private","billingEnabled":True,"projectId":model.PROJECT},"billing_account":{"open":True},"service":{"status":{"latestReadyRevisionName":launch.REVISION,"traffic":[{"revisionName":self.b["normalRevision"],"percent":100},{"revisionName":launch.REVISION,"percent":0}]}},"revision":{"metadata":{"name":launch.REVISION},"spec":{"serviceAccountName":model.IDENTITY,"containers":[{"image":self.b["candidateImage"],"env":[{"name":"A"},{"name":"B"}]}]},"status":{"conditions":[{"type":"Ready","status":"True"}]}},"identity":{"email":model.IDENTITY,"disabled":True,"uniqueId":"123"},"project_policy":{"bindings":[]},"identity_policy":{"bindings":[]},"lookup_role":{"name":model.LOOKUP_ROLE,"includedPermissions":["firebaseauth.users.get"],"stage":"GA","deleted":False},"signing_role":{"name":model.SIGNING_ROLE,"includedPermissions":["iam.serviceAccounts.signBlob"],"stage":"GA","deleted":False},"token":{"accessToken":"x"*32}}
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
        else:v={"status":200,"body":{"users":[{"localId":self.b["firebaseUid"],"disabled":True,**self.b["firebase"]}]}}
        return copy.deepcopy(self.override.get(i,v))
    def sql(self,d,password,deadline):
        self.calls.append(("sql",d));v=database() if d["id"]=="qualification" else {"sessionsAbsent":True};return copy.deepcopy(self.override.get(d["id"],v))
    def close(self,deadline):self.calls.append(("close",None));self.closed=True;return True


class Tests(unittest.TestCase):
    def setUp(self):
        self.p=plan();self.b=binding(self.p);self.io=FakeIO(self.b,self.p);self.tmp=tempfile.TemporaryDirectory(prefix="p08-launch-");os.chmod(self.tmp.name,0o700)
    def tearDown(self):self.tmp.cleanup()
    def adapter(self):return launch.Adapter(self.b,self.p,self.io,lambda:NOW)
    def test_exact_serialized_contracts_are_read_only(self):
        cli=launch.cli_contract(self.b["billingAccountResource"]);self.assertEqual(len(cli),26);self.assertTrue(all(x["argv"][0]==launch.GCLOUD for x in cli));self.assertFalse(any(a in {"create","delete","enable","disable","add-iam-policy-binding","remove-iam-policy-binding","set-iam-policy"} for x in cli for a in x["argv"]))
        http=launch.https_contract(self.b["projectNumber"],self.p["prospectiveKeyId"],self.b["firebaseUid"]);self.assertEqual(len(http),10);self.assertTrue(all(x["method"] in {"GET","POST"} for x in http));self.assertFalse(any(s in x["url"] for x in http for s in (":enable",":signBlob","keyString","accounts:update")))
        sql=launch.sql_contract();self.assertEqual(len(sql),2);self.assertTrue(all(x["readOnly"] for x in sql));self.assertNotIn("UPDATE",json.dumps(sql));self.assertNotIn("DELETE FROM",json.dumps(sql));self.assertNotIn("INSERT",json.dumps(sql))
    def test_fake_transport_proves_exact_counts_and_positive_model(self):
        a=self.adapter();result=model.Coordinator(self.p,a,self.tmp.name,clock=lambda:NOW).run();self.assertEqual(result["status"],"P08_COMPOSED_QUALIFICATION_LOCAL_VERIFIED")
        self.assertEqual(sum(k=="cli" for k,_ in self.io.calls),26);self.assertEqual(sum(k=="https" for k,_ in self.io.calls),10);self.assertEqual(sum(k=="sql" for k,_ in self.io.calls),2);self.assertTrue(self.io.closed);self.assertIsNone(a.token);self.assertIsNone(a.binding["databasePassword"])
    def test_native_refuses_before_process_network_or_environment(self):
        output=io.StringIO()
        with patch("subprocess.Popen",side_effect=AssertionError("no process")),patch("socket.socket",side_effect=AssertionError("no network")),patch.dict(os.environ,{"GOOGLE_APPLICATION_CREDENTIALS":"do-not-read"}),contextlib.redirect_stdout(output):
            code=launch.native()
        self.assertEqual(code,2);self.assertEqual(output.getvalue().strip(),"P08_COMPOSED_QUALIFICATION_LAUNCH_REFUSED_UNBOUND")
    def test_binding_drift_refuses_before_transport(self):
        changes={"mode":"bad","proposalSha256":"0"*64,"planSha256":"0"*64,"sourceManifestSha256":"0"*64,"externalReadAuthorized":False,"mutationsAuthorized":True,"allowanceUsd":1,"automaticRetryAllowed":True,"operationId":"bad","prospectiveOperationId":"bad","cliLimit":27,"httpsLimit":11,"sqlLimit":3}
        for key,value in changes.items():
            b=copy.deepcopy(self.b);b[key]=value
            with self.subTest(key=key),self.assertRaises(model.Stop):launch.Adapter(b,self.p,self.io,lambda:NOW)
        self.assertEqual(self.io.calls,[])
    def test_each_domain_drift_and_denial_stops_with_closeout(self):
        cases=[("project",{"projectId":"other","projectNumber":self.b["projectNumber"],"lifecycleState":"ACTIVE"},"DRIFT"),("service_0",{"status":403,"body":{"error":{"status":"PERMISSION_DENIED"}}},"UNKNOWN"),("key_absence",{"status":200,"body":{"name":"collision"}},"NOT_READY"),("qualification",{**database(),"jobExact":False},"DRIFT"),("firebase",{"status":403,"body":{"error":{"status":"PERMISSION_DENIED"}}},"UNKNOWN")]
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
    def test_disabled_service_and_role_definition_drift_are_not_ready_or_drift(self):
        self.io.override["service_0"]={"status":200,"body":{"state":"DISABLED"}}
        result=model.Coordinator(self.p,self.adapter(),self.tmp.name,clock=lambda:NOW).run();self.assertEqual(result["verdict"],"NOT_READY")
        self.tearDown();self.setUp();self.io.override["lookup_role"]={"name":model.LOOKUP_ROLE,"includedPermissions":["foreign.permission"],"stage":"GA","deleted":False}
        result=model.Coordinator(self.p,self.adapter(),self.tmp.name,clock=lambda:NOW).run();self.assertEqual(result["verdict"],"DRIFT")
    def test_no_private_values_in_journal(self):
        model.Coordinator(self.p,self.adapter(),self.tmp.name,clock=lambda:NOW).run();data="".join(x.read_text() for x in Path(self.tmp.name).iterdir());self.assertNotIn("private-password",data);self.assertNotIn("Bearer ",data);self.assertNotIn("x"*32,data)


if __name__=="__main__":unittest.main()
