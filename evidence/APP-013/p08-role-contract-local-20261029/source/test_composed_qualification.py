import copy,datetime as dt,json,os,signal,subprocess,tempfile,unittest,uuid
from pathlib import Path
import composed_qualification as m

NOW=1793271600
def iso(offset):return dt.datetime.fromtimestamp(NOW+offset,dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
def plan():
 op="12345678-1234-4234-8234-123456789abc";future="87654321-4321-4321-8321-cba987654321"
 p={"mode":"LOCAL_COMPOSED_QUALIFICATION_ONLY","externalReadAuthorized":False,"operationId":op,"prospectiveOperationId":future,"automaticRetryAllowed":False,"allowanceUsd":0,"project":m.PROJECT,"jobId":m.JOB,"tenantId":m.TENANT,"ownerPrincipal":m.OWNER,"runtimeIdentity":m.IDENTITY,"roles":[m.LOOKUP_ROLE,m.SIGNING_ROLE],"services":list(m.SERVICES),"permissions":list(m.PERMISSIONS),"ownershipSha256":m.OWNERSHIP_SHA256,"sourceHashes":copy.deepcopy(m.SOURCE_HASHES),"proposalSha256":m.PROPOSAL_SHA256,"prospectiveKeyId":"signmons-p08-"+future.replace("-",""),"window":{k:iso(v) for k,v in [("start",-10),("cutoff",50),("readEnd",300),("closeoutEnd",700),("purgeEnd",750)]}}
 p["readInventory"]=m.read_inventory(p);return p
def cloud():return {k:True for k in m.CLOUD_KEYS}
def access():return {"rolesExact":True,"bindingsAbsent":True,"services":{k:"ENABLED" for k in m.SERVICES},"permissions":{k:"GRANTED" for k in m.PERMISSIONS},"keyAbsence":"NOT_FOUND"}
def database():return {k:True for k in m.DATABASE_KEYS}
def firebase():return {k:True for k in m.FIREBASE_KEYS}
class Fake:
 def __init__(self):self.values={"cloud":cloud(),"access":access(),"database":database(),"firebase":firebase()};self.calls=[];self.fail=None;self.closed=True
 def read_cloud(self,deadline):return self.call("cloud")
 def read_access(self,deadline):return self.call("access")
 def read_database(self,deadline):return self.call("database")
 def read_firebase(self,deadline):return self.call("firebase")
 def closeout(self,deadline):self.calls.append("closeout");return self.closed
 def call(self,name):self.calls.append(name);(_ for _ in ()).throw(RuntimeError(name)) if self.fail==name else None;return copy.deepcopy(self.values[name])
class Tests(unittest.TestCase):
 def setUp(self):self.p=plan();self.fake=Fake();self.now=NOW;self.tmp=tempfile.TemporaryDirectory(prefix="p08-qualification-");os.chmod(self.tmp.name,0o700)
 def tearDown(self):self.tmp.cleanup()
 def controller(self):return m.Coordinator(self.p,self.fake,self.tmp.name,clock=lambda:self.now)
 def test_sources_ownership_and_native_refusal(self):
  self.assertTrue(m.verify_locked_sources());r=subprocess.run(["/opt/homebrew/bin/python3","-B",str(Path(m.__file__))],capture_output=True,text=True);self.assertEqual(r.returncode,2);self.assertEqual(r.stdout.strip(),"P08_COMPOSED_QUALIFICATION_REFUSED_UNBOUND")
 def test_positive_all_domains_and_private_files(self):
  r=self.controller().run();self.assertEqual(r["status"],"P08_COMPOSED_QUALIFICATION_LOCAL_VERIFIED");self.assertEqual(r["verdict"],"QUALIFIED");self.assertEqual(self.fake.calls,["cloud","access","database","firebase","closeout"]);self.assertEqual((Path(self.tmp.name)/"journal.json").stat().st_mode&0o777,0o600)
 def test_plan_drift_refuses(self):
  changes={"mode":"LIVE","externalReadAuthorized":True,"operationId":"bad","prospectiveOperationId":"bad","automaticRetryAllowed":True,"allowanceUsd":1,"project":"other","jobId":str(uuid.uuid4()),"tenantId":str(uuid.uuid4()),"ownerPrincipal":"other","runtimeIdentity":"other","roles":[],"services":[],"permissions":[],"ownershipSha256":"0"*64,"sourceHashes":{},"proposalSha256":"0"*64,"prospectiveKeyId":"foreign","readInventory":{}}
  for field,value in changes.items():
   changed=copy.deepcopy(self.p);changed[field]=value
   with self.subTest(field=field),self.assertRaises((m.Stop,ValueError)):m.authorize(changed,NOW)
 def test_inventory_has_no_mutation_or_stripe(self):
  v=m.read_inventory(self.p);self.assertEqual(v["mutations"],[]);self.assertFalse(v["stripe"]);self.assertEqual(v["sql"],["EXACT_JOB_TENANT_OPERATOR_ROLE_READ_ONLY","EXACT_SESSION_CLOSEOUT_READ_ONLY"]);self.assertIn("apikeys.keys.getKeyString",v["permissions"]);self.assertNotIn("keyStringRequest",json.dumps(v))
 def test_cloud_each_false_is_drift(self):
  for key in m.CLOUD_KEYS:
   value=cloud();value[key]=False
   with self.subTest(key=key):self.assertEqual(m.classify_cloud(value),"DRIFT")
 def test_cloud_observation_retains_only_allowlisted_false_names_and_counts(self):
  value=cloud();value["billingOpen"]=False;value["candidateReady"]=False
  self.fake.values["cloud"]=value;r=self.controller().run();self.assertEqual(r["failure"],"CLOUD_DRIFT")
  saved=json.loads((Path(self.tmp.name)/"journal.json").read_text());observation=saved["safeObservations"]["cloud"]
  self.assertEqual(observation,{"falseFacts":["billingOpen","candidateReady"],"falseCount":2,"trueCount":len(m.CLOUD_KEYS)-2})
  self.assertEqual(set(observation["falseFacts"])<=m.CLOUD_KEYS,True);self.assertNotIn("signmons",json.dumps(observation));self.assertNotIn("@",json.dumps(observation))
 def test_cloud_observation_rejects_extra_missing_and_non_boolean_values(self):
  values=[]
  extra=cloud();extra["foreign"]=False;values.append(extra)
  missing=cloud();missing.pop("billingOpen");values.append(missing)
  for changed in [None,0,1,"false",[],{}]:
   value=cloud();value["billingOpen"]=changed;values.append(value)
  for value in values:
   with self.subTest(value=value),self.assertRaises(m.Stop):m.cloud_observation(value)
 def test_access_disabled_denied_present_and_unknown(self):
  v=access();v["services"][m.SERVICES[0]]="DISABLED";self.assertEqual(m.classify_access(v),"NOT_READY")
  v=access();v["permissions"][m.PERMISSIONS[0]]="DENIED";self.assertEqual(m.classify_access(v),"NOT_READY")
  v=access();v["keyAbsence"]="PRESENT";self.assertEqual(m.classify_access(v),"NOT_READY")
  v=access();v["keyAbsence"]="DENIED";self.assertEqual(m.classify_access(v),"UNKNOWN")
  v=access();v["services"][m.SERVICES[0]]="UNKNOWN";self.assertEqual(m.classify_access(v),"UNKNOWN")
  v=access();v["rolesExact"]=False;self.assertEqual(m.classify_access(v),"DRIFT")
 def test_access_observation_retains_only_fixed_names_enums_and_counts(self):
  for service in m.SERVICES:
   v=access();v["services"][service]="UNKNOWN"
   with self.subTest(service=service):
    o=m.access_observation(v);self.assertEqual(o["unknownServices"],[service]);self.assertEqual(o["unknownCount"],1)
  for permission in m.PERMISSIONS:
   v=access();v["permissions"][permission]="UNKNOWN"
   with self.subTest(permission=permission):
    o=m.access_observation(v);self.assertEqual(o["unknownPermissions"],[permission]);self.assertEqual(o["unknownCount"],1)
  v=access();v["services"][m.SERVICES[1]]="UNKNOWN";v["services"][m.SERVICES[0]]="DISABLED";v["permissions"][m.PERMISSIONS[1]]="UNKNOWN";v["permissions"][m.PERMISSIONS[0]]="DENIED";v["keyAbsence"]="DENIED";v["rolesExact"]=False
  self.fake.values["access"]=v;r=self.controller().run();self.assertEqual(r["failure"],"ACCESS_UNKNOWN")
  saved=json.loads((Path(self.tmp.name)/"journal.json").read_text());o=saved["safeObservations"]["access"]
  self.assertEqual(o,{"unknownServices":[m.SERVICES[1]],"disabledServices":[m.SERVICES[0]],"unknownPermissions":[m.PERMISSIONS[1]],"deniedPermissions":[m.PERMISSIONS[0]],"keyAbsence":"DENIED","rolesExact":False,"bindingsAbsent":True,"unknownCount":3,"notReadyCount":2})
  self.assertNotIn("Bearer ",json.dumps(saved));self.assertNotIn("private-response",json.dumps(saved));self.assertEqual(self.fake.calls[-1],"closeout")
 def test_access_observation_refuses_foreign_or_malformed_facts(self):
  values=[]
  v=access();v["services"]["foreign.example"]="UNKNOWN";values.append(v)
  v=access();v["services"].pop(m.SERVICES[0]);values.append(v)
  v=access();v["permissions"]["private-response"]="UNKNOWN";values.append(v)
  v=access();v["permissions"][m.PERMISSIONS[0]]="PRIVATE";values.append(v)
  v=access();v["keyAbsence"]="private-response";values.append(v)
  v=access();v["rolesExact"]={"private-response":True};values.append(v)
  v=access();v["bindingsAbsent"]="true";values.append(v)
  for v in values:
   with self.subTest(value=str(v)[:50]),self.assertRaises(m.Stop):m.access_observation(v)
  self.assertEqual(m.access_observation(access())["unknownCount"],0)
  v=access();v["keyAbsence"]="PRESENT";self.assertEqual(m.access_observation(v)["notReadyCount"],1)
 def test_database_and_firebase_each_false_are_drift(self):
  for keys,factory,classifier in [(m.DATABASE_KEYS,database,m.classify_database),(m.FIREBASE_KEYS,firebase,m.classify_firebase)]:
   for key in keys:
    value=factory();value[key]=False
    with self.subTest(key=key):self.assertEqual(classifier(value),"DRIFT")
 def test_extra_missing_malformed_fields_refuse(self):
  for name,value,classifier in [("cloud",cloud(),m.classify_cloud),("access",access(),m.classify_access),("database",database(),m.classify_database),("firebase",firebase(),m.classify_firebase)]:
   changed=copy.deepcopy(value);changed["extra"]=True
   with self.subTest(name=name,kind="extra"),self.assertRaises(m.Stop):classifier(changed)
   changed=copy.deepcopy(value);changed.pop(next(iter(changed)))
   with self.subTest(name=name,kind="missing"),self.assertRaises(m.Stop):classifier(changed)
 def test_domain_stops_do_not_continue_and_closeout_runs(self):
  for domain in ["cloud","access","database","firebase"]:
   self.tearDown();self.setUp()
   if domain=="access":self.fake.values[domain]["keyAbsence"]="PRESENT"
   else:self.fake.values[domain][next(iter(self.fake.values[domain]))]=False
   r=self.controller().run();self.assertNotEqual(r["verdict"],"QUALIFIED");self.assertEqual(self.fake.calls[-1],"closeout");self.assertNotIn("stripe",self.fake.calls)
 def test_adapter_failure_unknown_and_closeout(self):
  self.fake.fail="database";r=self.controller().run();self.assertEqual(r["verdict"],"UNKNOWN");self.assertEqual(r["failure"],"ADAPTER_REFUSED_OR_UNKNOWN");self.assertEqual(self.fake.calls[-1],"closeout")
 def test_closeout_failure_never_qualifies(self):
  self.fake.closed=False;r=self.controller().run();self.assertEqual(r["status"],"CONTAINMENT_UNCONFIRMED");self.assertIn("CLOSEOUT_UNCONFIRMED",r["residuals"])
 def test_exclusive_reservation(self):
  m.reserve(Path(self.tmp.name)/"attempt.json",{"foreign":True})
  with self.assertRaises(FileExistsError):self.controller().run()
 def test_clock_rollback_and_deadline(self):
  c=self.controller();self.now=NOW-1
  with self.assertRaises(m.Stop):c.gate()
  self.tearDown();self.setUp();c=self.controller();self.now=NOW+301
  with self.assertRaises(m.Stop):c.gate()
 def test_signal_stops_normal_reads_but_closeout_runs(self):
  original=self.fake.read_access
  def signaled(deadline):os.kill(os.getpid(),signal.SIGTERM);return original(deadline)
  self.fake.read_access=signaled;r=self.controller().run();self.assertEqual(r["failure"],"INTERRUPTED");self.assertEqual(self.fake.calls[-1],"closeout")
 def test_no_private_values_persisted(self):
  self.controller().run();content="".join(p.read_text() for p in Path(self.tmp.name).iterdir());self.assertNotIn("Bearer ",content);self.assertNotIn("password",content.lower());self.assertNotIn("stripe",content.lower())
if __name__=="__main__":unittest.main()
