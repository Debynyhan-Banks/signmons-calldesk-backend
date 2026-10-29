import importlib.util
import json
import unittest
from pathlib import Path
from unittest.mock import patch

import composed_qualification as model
import qualification_launch as launch
from test_composed_qualification import NOW, plan
from test_qualification_launch import FakeIO, UID, binding, database_raw

ROOT = Path(__file__).resolve().parent
FIXTURE = ROOT.parent.parent / "p08-access-resolution-local-20261028/source/reuse/auth/reuse/test_postgres_contract.py"
spec = importlib.util.spec_from_file_location("p08_owned_socket_fixture", FIXTURE)
fixture = importlib.util.module_from_spec(spec); spec.loader.exec_module(fixture)


class QualificationLaunchPostgreSQL(fixture.PostgreSQLContract):
    def setUp(self):
        self.command('''DROP TABLE IF EXISTS "CalendarOperation","User","Job","TenantOrganization" CASCADE; DROP ROLE IF EXISTS p07_payment_runtime;
CREATE TABLE "TenantOrganization"(id uuid,status text);
CREATE TABLE "User"(id uuid,"tenantId" uuid,email text,"fullName" text,role text,status text);
CREATE TABLE "Job"(id uuid,"tenantId" uuid,"policySnapshot" jsonb,"calendarEventId" text);
CREATE TABLE "CalendarOperation"("jobId" uuid,"tenantId" uuid);
INSERT INTO "TenantOrganization" VALUES ('%s','ACTIVE');
INSERT INTO "User" VALUES ('%s','%s','%s','%s','ADMIN','DISABLED');
INSERT INTO "Job" VALUES ('%s','%s','{"intakeAdmission":{"humanReviewed":true}}',NULL);''' % (model.TENANT, UID, model.TENANT, launch.TARGET_EMAIL, launch.TARGET_NAME, model.JOB, model.TENANT))

    def raw(self):
        return json.loads(self.command(launch.QUALIFICATION_SQL))

    def adapter(self):
        p = plan(); b = binding(p); io = FakeIO(b, p); io.override["qualification"] = self.raw()
        return launch.Adapter(b, p, io, lambda: NOW), io

    def test_actual_repeatable_read_projection_qualifies_each_observed_fact(self):
        expected_hash = launch.hashlib.sha256(json.dumps(database_raw()["operator"], separators=(",", ":")).encode()).hexdigest()
        with patch.object(launch, "TARGET_SHA256", expected_hash):
            adapter, _ = self.adapter(); value = adapter.read_database(adapter.times["readEnd"])
        self.assertEqual(set(value), model.DATABASE_KEYS); self.assertTrue(all(value.values())); self.assertEqual(adapter.firebase_uid, UID)

    def test_absence_duplicate_foreign_and_changed_rows_never_qualify(self):
        cases = ['DELETE FROM "User"', 'INSERT INTO "User" SELECT * FROM "User"', 'UPDATE "User" SET role=\'OWNER\'', 'UPDATE "User" SET status=\'ACTIVE\'', 'UPDATE "TenantOrganization" SET status=\'INACTIVE\'', 'UPDATE "Job" SET "policySnapshot"=\'{}\'', 'INSERT INTO "CalendarOperation" VALUES (\'%s\',\'%s\')' % (model.JOB, model.TENANT)]
        expected_hash = launch.hashlib.sha256(json.dumps(database_raw()["operator"], separators=(",", ":")).encode()).hexdigest()
        for sql in cases:
            with self.subTest(sql=sql):
                self.setUp(); self.command(sql)
                with patch.object(launch, "TARGET_SHA256", expected_hash):
                    try:
                        adapter, _ = self.adapter(); value = adapter.read_database(adapter.times["readEnd"]); qualified = all(value.values())
                    except (model.Stop, AssertionError): qualified = False
                self.assertFalse(qualified)

    def test_query_is_read_only_and_leaves_no_session(self):
        before = self.command('SELECT count(*) FROM "User";'); self.raw(); after = self.command('SELECT count(*) FROM "User";')
        self.assertEqual(before, after); self.assertEqual(self.command("SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'signmons_p08_qualification_%'"), '0')


for name in list(fixture.PostgreSQLContract.__dict__):
    if name.startswith("test_"): setattr(QualificationLaunchPostgreSQL, name, None)

if __name__ == "__main__": unittest.main()
