// Approved APP-013/3A/P07 local-only proof. Synthetic data; real restricted PG18
// sessions and application services; Checkout transport only is mocked.
// Owns its private Unix-socket cluster. Never reads DATABASE_URL or credentials.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import { qualifyRuntimeRole } from "./verify-p06-runtime-role.mjs";

const require = createRequire(import.meta.url);
for (const key of Object.keys(process.env))
  if (key === "DATABASE_URL" || key.startsWith("PG")) delete process.env[key];
const { Client, Pool } = require("pg");
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const {
  JobPaymentPolicyService,
} = require("../dist/jobs/job-payment-policy.service.js");
const {
  PaymentRequestsService,
} = require("../dist/payments/payment-requests.service.js");
const {
  StripeWebhooksService,
} = require("../dist/payments/stripe-webhooks.service.js");
const {
  DispatchBoardService,
} = require("../dist/jobs/dispatch-board.service.js");
const { RoutingService } = require("../dist/jobs/routing.service.js");
const {
  PaymentOperationsAccessGuard,
} = require("../dist/payments/payment-operations-access.guard.js");
const { TenantGuard } = require("../dist/common/guards/tenant.guard.js");
const {
  requestContextMiddleware,
  setAuthContext,
} = require("../dist/common/context/request-context.js");

assert.ok(process.argv.slice(2).every((x) => x === "--prove-interruption"));
const interruption = process.argv.includes("--prove-interruption");
const bin = "/opt/homebrew/opt/postgresql@18/bin/";
const role = "p07_payment_runtime";
const dir = await mkdtemp("/private/tmp/signmons-runtime-role-");
const socket = dir + "/socket",
  data = dir + "/data";
await mkdir(socket, { mode: 0o700 });
const database = "calldesk_org_" + randomBytes(6).toString("hex");
const local = {
  host: socket,
  port: 5432,
  user: userInfo().username,
  connectionTimeoutMillis: 5000,
  query_timeout: 15000,
  options: "-c statement_timeout=10s -c lock_timeout=5s",
};
const fixtureUrl = new URL(
  "./fixtures/p07-payment-runtime-role-review.sql",
  import.meta.url,
);
const originalFiles = [
  "fixtures/p06-runtime-role-review.sql",
  "verify-p06-runtime-role.mjs",
];
const digest = (value) => createHash("sha256").update(value).digest("hex");
const originalHashes = await Promise.all(
  originalFiles.map(async (file) =>
    digest(await readFile(new URL(file, import.meta.url))),
  ),
);
const checks = [],
  failures = [],
  sqlShapes = new Set();
const cleanup = {
  roleClosed: false,
  roleSessions: null,
  roleRemoved: false,
  databaseRemoved: false,
  clusterStopped: false,
  scratchRemoved: false,
};
let started = false,
  startupAttempted = false,
  databaseCreated = false,
  roleCreated = false;
let admin,
  raw,
  ownerPool,
  owner,
  runtimePool,
  runtime,
  aborted = false;
let phase = "LOCAL_CLUSTER",
  caught,
  aclHash,
  fixtureHash,
  mockCheckoutCalls = 0,
  mockRecoverCalls = 0;
process.once("SIGINT", () => {
  aborted = true;
});
process.once("SIGTERM", () => {
  aborted = true;
});
globalThis.fetch = async () => {
  throw Error("EXTERNAL_FETCH_FORBIDDEN");
};

const pass = (name) => {
  checks.push(name);
  if (!interruption) console.log("PASS " + name);
};
async function check(name, fn) {
  phase = name;
  await fn();
  if (aborted) throw Error("LOCAL_INTERRUPTED");
  pass(name);
}
async function observe(name, fn) {
  phase = name;
  try {
    await fn();
    pass(name);
  } catch (error) {
    const failure = { case: name, code: error.code ?? error.name };
    if (error.getStatus) failure.httpStatus = error.getStatus();
    if (typeof error.actual === "string" && /^[A-Z_]+$/.test(error.actual))
      failure.actual = error.actual;
    if (typeof error.expected === "string" && /^[A-Z_]+$/.test(error.expected))
      failure.expected = error.expected;
    failures.push(failure);
    console.log("FAIL " + JSON.stringify(failure));
  }
}
function actor(context, fn) {
  return new Promise((resolve, reject) =>
    requestContextMiddleware({ headers: {} }, {}, () => {
      setAuthContext(context, context.impersonatedTenantId);
      Promise.resolve().then(fn).then(resolve, reject);
    }),
  );
}
async function rejectStatus(fn, status) {
  await assert.rejects(fn, (error) => error.getStatus?.() === status);
}
async function deny(sql) {
  await assert.rejects(
    runtimePool.query(sql),
    (error) => error.code === "42501",
  );
}
async function counts(jobId) {
  return {
    payment: await owner.payment.findFirst({ where: { jobId } }),
    events: await owner.stripeEvent.count(),
    audits: await owner.auditLog.count(),
  };
}

try {
  execFileSync(
    bin + "initdb",
    ["-D", data, "-A", "trust", "--no-locale", "-E", "UTF8"],
    { stdio: "ignore" },
  );
  startupAttempted = true;
  execFileSync(
    bin + "pg_ctl",
    [
      "-D",
      data,
      "-o",
      `-k ${socket} -h '' -p 5432`,
      "-l",
      dir + "/postgres.log",
      "-w",
      "start",
    ],
    { stdio: "ignore", timeout: 20000 },
  );
  started = true;
  admin = new Client({ ...local, database: "postgres" });
  await admin.connect();
  const info = (
    await admin.query(
      "SELECT inet_server_addr() AS address,current_setting('unix_socket_directories') AS socket,current_setting('listen_addresses') AS tcp,current_setting('server_version_num')::int AS version",
    )
  ).rows[0];
  assert.equal(info.address, null);
  assert.equal(info.socket, socket);
  assert.equal(info.tcp, "");
  assert.ok(info.version >= 180000 && info.version < 190000);
  assert.equal(
    (await admin.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [role]))
      .rowCount,
    0,
  );
  assert.equal(
    (
      await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [
        database,
      ])
    ).rowCount,
    0,
  );
  await admin.query(`CREATE DATABASE "${database}"`);
  databaseCreated = true;
  await admin.query(`REVOKE ALL ON DATABASE "${database}" FROM PUBLIC`);
  raw = new Client({ ...local, database });
  await raw.connect();
  phase = "CURRENT_MIGRATIONS";
  for (const name of (
    await readdir(new URL("../prisma/migrations/", import.meta.url))
  ).sort()) {
    if (name === "migration_lock.toml") continue;
    await raw.query(
      await readFile(
        new URL(`../prisma/migrations/${name}/migration.sql`, import.meta.url),
        "utf8",
      ),
    );
  }
  await raw.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
  ownerPool = new Pool({ ...local, database });
  owner = new PrismaClient({ adapter: new PrismaPg(ownerPool), log: [] });
  pass(
    "owned PG18 Unix socket; TCP disabled; current migrations; no environment credentials",
  );
  const fixture = await readFile(fixtureUrl, "utf8");
  fixtureHash = digest(fixture);
  await raw.query("BEGIN");
  try {
    await raw.query(fixture);
    await raw.query("COMMIT");
    roleCreated = true;
  } catch (error) {
    await raw.query("ROLLBACK");
    throw error;
  }
  const initial = (
    await raw.query(
      "SELECT rolcanlogin,rolinherit,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolconnlimit,rolvaliduntil<now() AS expired FROM pg_roles WHERE rolname=$1",
      [role],
    )
  ).rows[0];
  assert.deepEqual(initial, {
    rolcanlogin: false,
    rolinherit: false,
    rolsuper: false,
    rolcreatedb: false,
    rolcreaterole: false,
    rolreplication: false,
    rolbypassrls: false,
    rolconnlimit: 0,
    expired: true,
  });
  await raw.query(`GRANT CONNECT ON DATABASE "${database}" TO ${role}`);
  await raw.query(
    `ALTER ROLE ${role} LOGIN CONNECTION LIMIT 6 VALID UNTIL '${new Date(Date.now() + 10 * 60000).toISOString()}'`,
  );
  runtimePool = new Pool({
    ...local,
    database,
    user: role,
    max: 4,
    connectionTimeoutMillis: 5000,
  });
  runtime = new PrismaClient({
    adapter: new PrismaPg(runtimePool),
    log: [{ emit: "event", level: "query" }],
  });
  runtime.$on("query", (event) => {
    const insert = event.query.match(
      /INSERT INTO\s+"[^"]+"\."([^"]+)"\s*\(([^)]+)\)/i,
    );
    if (insert)
      sqlShapes.add(
        insert[1] +
          "(" +
          insert[2].replaceAll('"', "").replace(/\s+/g, "") +
          ")",
      );
  });
  await check(
    "direct restricted session; zero elevation/memberships/ownership and PUBLIC write rights",
    async () => {
      const [identity] = await runtime.$queryRawUnsafe(
        "SELECT current_user AS role,session_user AS session,current_database() AS database",
      );
      assert.deepEqual(identity, { role, session: role, database });
      assert.equal(
        (
          await raw.query(
            "SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=$1)",
            [role],
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await raw.query(
            "SELECT 1 FROM pg_class WHERE relowner=(SELECT oid FROM pg_roles WHERE rolname=$1)",
            [role],
          )
        ).rowCount,
        0,
      );
      const effective = (
        await raw.query(
          "SELECT has_schema_privilege($1,'public','CREATE') AS schema_create,has_database_privilege($1,current_database(),'TEMP') AS temp",
          [role],
        )
      ).rows[0];
      assert.deepEqual(effective, { schema_create: false, temp: false });
      const acl = await raw.query(
        "SELECT table_name,column_name,privilege_type FROM information_schema.column_privileges WHERE grantee=$1 ORDER BY table_name,column_name,privilege_type",
        [role],
      );
      aclHash = digest(JSON.stringify(acl.rows));
    },
  );
  if (interruption) {
    phase = "INTERRUPTION_AFTER_ROLE_OPEN";
    await new Promise((resolve) => {
      process.once("SIGINT", resolve);
      setTimeout(() => process.kill(process.pid, "SIGINT"), 20);
    });
    assert.equal(aborted, true);
    throw Error("EXPECTED_LOCAL_INTERRUPTION");
  }

  await check(
    "accepted P06 fixture and its 13 original permission denials preserved",
    async () => {
      const p06 = await qualifyRuntimeRole(owner);
      await p06.close();
      assert.equal(
        (
          await raw.query(
            "SELECT 1 FROM pg_roles WHERE rolname='p06_intake_runtime'",
          )
        ).rowCount,
        0,
      );
    },
  );

  phase = "SYNTHETIC_SEED";
  const terms = {
    currency: "usd",
    serviceFeeRequired: false,
    serviceFeeCents: null,
    depositRequired: true,
    depositPolicy: { kind: "fixed", amountCents: 12500 },
    emergencyFeePolicy: { kind: "none" },
    paymentGateMode: "fail_closed",
    webhookValidationRequired: true,
  };
  const approvedAt = new Date(Date.now() - 60000).toISOString();
  const ownerId = randomUUID();
  const approved = { draft: terms, actorId: ownerId, approvedAt };
  const tenant = await owner.tenantOrganization.create({
    data: {
      name: "Fictional P07 role proof",
      timezone: "America/New_York",
      stripeConnectAccountId: "acct_local_p07_only",
      chargesEnabled: true,
      settings: {
        organizationPaymentPolicyV1: { version: 1, draft: terms, approved },
      },
    },
  });
  const otherTenant = await owner.tenantOrganization.create({
    data: {
      name: "Fictional other tenant",
      timezone: "UTC",
      stripeConnectAccountId: "acct_local_foreign_only",
    },
  });
  await owner.user.create({
    data: {
      id: ownerId,
      tenantId: tenant.id,
      email: "owner@fixture.invalid",
      fullName: "Fictional owner",
      role: "OWNER",
    },
  });
  const tech = await owner.user.create({
    data: {
      tenantId: tenant.id,
      email: "tech@fixture.invalid",
      fullName: "Fictional technician",
      role: "TECH",
      isAvailable: true,
    },
  });
  const category = await owner.serviceCategory.create({
    data: { tenantId: tenant.id, name: "Fictional repair" },
  });
  const customer = await owner.customer.create({
    data: {
      tenantId: tenant.id,
      fullName: "Fictional customer",
      phone: "+12025550123",
    },
  });
  const address = await owner.propertyAddress.create({
    data: {
      tenantId: tenant.id,
      customerId: customer.id,
      customerTenantId: tenant.id,
      formattedAddress: "Fictional local address 44101",
      addressComponents: [
        { types: ["postal_code"], long_name: "44101", short_name: "44101" },
      ],
    },
  });
  const area = await owner.serviceArea.create({
    data: {
      tenantId: tenant.id,
      name: "Fictional ZIP",
      type: "ZIP",
      definition: { zipCodes: ["44101"] },
    },
  });
  await owner.routingRule.create({
    data: {
      tenantId: tenant.id,
      name: "Fictional rule",
      serviceCategoryId: category.id,
      serviceCategoryTenantId: tenant.id,
      serviceAreaId: area.id,
      serviceAreaTenantId: tenant.id,
      requireAvailable: false,
    },
  });
  await owner.userServiceCapability.create({
    data: {
      tenantId: tenant.id,
      userId: tech.id,
      userTenantId: tenant.id,
      serviceCategoryId: category.id,
      serviceCategoryTenantId: tenant.id,
      proficiency: "EXPERT",
    },
  });
  await owner.userAvailabilityBlock.create({
    data: {
      tenantId: tenant.id,
      userId: tech.id,
      userTenantId: tenant.id,
      type: "AVAILABLE_OVERRIDE",
      startAt: new Date(Date.now() - 60000),
      endAt: new Date(Date.now() + 3600000),
    },
  });
  const context = { tenantId: tenant.id, userId: ownerId, role: "owner" };
  const policy = new JobPaymentPolicyService(runtime);
  const sessions = new Map();
  const provider = {
    async createCheckout(input) {
      mockCheckoutCalls++;
      if (!sessions.has(input.idempotencyKey))
        sessions.set(input.idempotencyKey, {
          sessionId: "cs_local_" + randomBytes(8).toString("hex"),
          paymentIntentId: "pi_local_" + randomBytes(8).toString("hex"),
          checkoutUrl: "https://checkout.stripe.com/c/pay/local-fixture",
          expiresAt: new Date(Date.now() + 3600000),
        });
      return sessions.get(input.idempotencyKey);
    },
    async recoverCheckout(input) {
      mockRecoverCalls++;
      return (
        [...sessions.values()].find(
          (row) => row.sessionId === input.sessionId,
        ) ?? null
      );
    },
  };
  const payments = new PaymentRequestsService(runtime, provider);
  const webhookSecret = "FICTIONAL_LOCAL_WEBHOOK_KEY_ONLY";
  const hooks = new StripeWebhooksService(runtime, {
    stripeWebhookSecret: webhookSecret,
    stripeWebhookLivemode: false,
  });
  const dispatch = new DispatchBoardService(
    runtime,
    new RoutingService(runtime),
  );
  async function job(overrides = {}) {
    return owner.job.create({
      data: {
        tenantId: tenant.id,
        customerId: customer.id,
        customerTenantId: tenant.id,
        propertyAddressId: address.id,
        propertyAddressTenantId: tenant.id,
        serviceCategoryId: category.id,
        serviceCategoryTenantId: tenant.id,
        status: "CREATED",
        urgency: "STANDARD",
        pricingSnapshot: {},
        policySnapshot: {
          intakeAdmission: {
            version: 2,
            actorId: "signmons-intake-admission-v1",
            paymentApprovedAt: approvedAt,
            paymentDigest: digest(JSON.stringify(approved)),
          },
        },
        ...overrides,
      },
    });
  }
  const binding = (row) => ({
    jobId: row.id,
    expectedUpdatedAt: row.updatedAt.toISOString(),
    approvedAt,
    acknowledged: true,
  });
  const createInput = (row) => ({
    tenantId: tenant.id,
    jobId: row.id,
    actorId: ownerId,
    traceId: randomUUID(),
    idempotencyKey: randomUUID(),
    expectedJobUpdatedAt: row.updatedAt.toISOString(),
  });
  async function boundJob() {
    const row = await job();
    await actor(context, () => policy.apply(binding(row)));
    return owner.job.findUniqueOrThrow({ where: { id: row.id } });
  }
  function signed(
    payment,
    type = "checkout.session.completed",
    changes = {},
    envelope = {},
  ) {
    const t = Math.floor(Date.now() / 1000);
    const object = {
      id:
        type === "payment_intent.payment_failed"
          ? payment.stripePaymentIntentId
          : payment.stripeCheckoutSessionId,
      payment_status: "paid",
      payment_intent: payment.stripePaymentIntentId,
      amount_total: payment.amountTotalCents,
      currency: payment.currency,
      metadata: {
        paymentRequestId: payment.id,
        jobId: payment.jobId,
        tenantId: payment.tenantId,
      },
      ...changes,
    };
    const body = Buffer.from(
      JSON.stringify({
        id: "evt_local_" + randomBytes(8).toString("hex"),
        type,
        account: tenant.stripeConnectAccountId,
        livemode: false,
        created: t,
        data: { object },
        ...envelope,
      }),
    );
    return {
      body,
      signature: `t=${t},v1=${createHmac("sha256", webhookSecret).update(`${t}.`).update(body).digest("hex")}`,
    };
  }
  const receive = (service, event) =>
    service.receive(event.body, event.signature);
  async function auditFault(action, jobId, fn) {
    await raw.query(
      `CREATE FUNCTION p07_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='${action}' AND (NEW."entityId"='${jobId}' OR NEW.metadata->>'jobId'='${jobId}') THEN RAISE EXCEPTION 'LOCAL_AUDIT_FAULT'; END IF; RETURN NEW; END $$`,
    );
    await raw.query(
      'CREATE TRIGGER p07_reject_audit BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION p07_reject_audit()',
    );
    try {
      await fn();
    } finally {
      await raw.query('DROP TRIGGER p07_reject_audit ON "AuditLog"');
      await raw.query("DROP FUNCTION p07_reject_audit()");
    }
  }

  await check(
    "actual role guards and missing/foreign/stale controlled policy refuse",
    async () => {
      for (const allowed of ["owner", "admin", "dispatcher"])
        await actor({ ...context, role: allowed }, () =>
          assert.equal(new PaymentOperationsAccessGuard().canActivate(), true),
        );
      for (const denied of ["tech", "customer", undefined])
        await actor({ ...context, role: denied }, () =>
          assert.throws(
            () => new PaymentOperationsAccessGuard().canActivate(),
            (error) => error.getStatus?.() === 403,
          ),
        );
      await actor(context, () =>
        assert.equal(new TenantGuard().canActivate(), true),
      );
      await actor({ userId: ownerId, role: "owner" }, () =>
        assert.throws(
          () => new TenantGuard().canActivate(),
          (error) => error.getStatus?.() === 401,
        ),
      );
      const row = await job();
      await rejectStatus(
        () =>
          actor({ ...context, role: "dispatcher" }, () =>
            policy.apply(binding(row)),
          ),
        403,
      );
      await rejectStatus(
        () =>
          actor({ ...context, tenantId: otherTenant.id }, () =>
            policy.apply(binding(row)),
          ),
        409,
      );
      await rejectStatus(
        () =>
          actor(context, () =>
            policy.apply({
              ...binding(row),
              expectedUpdatedAt: new Date(0).toISOString(),
            }),
          ),
        409,
      );
      const bad = await job({
        policySnapshot: { intakeAdmission: { version: 2 } },
      });
      await rejectStatus(
        () => actor(context, () => policy.apply(binding(bad))),
        409,
      );
      assert.equal(
        await owner.auditLog.count({
          where: { action: "job.payment_policy_bound" },
        }),
        0,
      );
    },
  );
  let mainJob, mainInput, mainPayment;
  await check(
    "controlled-v2 binding concurrent replay persists once without human-review fabrication",
    async () => {
      const row = await job();
      const replies = await Promise.all([
        actor(context, () => policy.apply(binding(row))),
        actor(context, () => policy.apply(binding(row))),
      ]);
      assert.deepEqual(replies[0], replies[1]);
      assert.equal(
        await owner.auditLog.count({
          where: { entityId: row.id, action: "job.payment_policy_bound" },
        }),
        1,
      );
      mainJob = await owner.job.findUniqueOrThrow({ where: { id: row.id } });
      assert.equal(
        mainJob.policySnapshot.intakeAdmission.humanReviewed,
        undefined,
      );
      assert.equal(
        mainJob.policySnapshot.paymentPolicyBinding.admissionSource,
        "CONTROLLED_V2",
      );
    },
  );
  await check(
    "policy audit failure rolls back policy/pricing and exact retry succeeds",
    async () => {
      const row = await job();
      await auditFault("job.payment_policy_bound", row.id, () =>
        assert.rejects(actor(context, () => policy.apply(binding(row)))),
      );
      const after = await owner.job.findUniqueOrThrow({
        where: { id: row.id },
      });
      assert.deepEqual(after.policySnapshot, row.policySnapshot);
      assert.deepEqual(after.pricingSnapshot, {});
      assert.equal(after.updatedAt.toISOString(), row.updatedAt.toISOString());
      await actor(context, () => policy.apply(binding(row)));
    },
  );
  await check(
    "real request reservation; post-provider persistence; stable replay and active recovery",
    async () => {
      mainInput = createInput(mainJob);
      const first = await payments.create(mainInput),
        replay = await payments.create(mainInput);
      assert.equal(first.paymentRequestId, replay.paymentRequestId);
      assert.equal(sessions.size, 1);
      mainPayment = await owner.payment.findFirstOrThrow({
        where: { jobId: mainJob.id },
      });
      assert.ok(mainPayment.stripeCheckoutSessionId);
      assert.ok(mainPayment.stripePaymentIntentId);
      assert.equal(
        await owner.auditLog.count({
          where: {
            entityId: mainPayment.id,
            action: "payment.request_created",
          },
        }),
        1,
      );
      const recovered = await payments.recoverForOperator({
        tenantId: tenant.id,
        jobId: mainJob.id,
        actorId: ownerId,
        traceId: randomUUID(),
      });
      assert.equal(recovered.checkoutUrl, first.checkoutUrl);
      assert.equal(mockRecoverCalls, 1);
      assert.equal(
        (await payments.get(tenant.id, mainJob.id)).status,
        "PENDING",
      );
    },
  );
  await check(
    "concurrent different request keys reserve one payment and one logical Checkout",
    async () => {
      const row = await boundJob(),
        before = sessions.size;
      const results = await Promise.allSettled([
        payments.create(createInput(row)),
        payments.create(createInput(row)),
      ]);
      assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
      assert.equal(
        results.filter(
          (x) => x.status === "rejected" && x.reason.getStatus?.() === 409,
        ).length,
        1,
      );
      assert.equal(await owner.payment.count({ where: { jobId: row.id } }), 1);
      assert.equal(sessions.size, before + 1);
    },
  );
  let interruptedRequest;
  await observe(
    "post-provider audit failure must allow immediate same-key recovery without second logical Checkout",
    async () => {
      const row = await boundJob(),
        input = createInput(row),
        before = sessions.size;
      interruptedRequest = { row, input, before };
      await auditFault("payment.request_created", row.id, () =>
        assert.rejects(payments.create(input)),
      );
      const reserved = await owner.payment.findFirstOrThrow({
        where: { jobId: row.id },
      });
      assert.equal(reserved.status, "PENDING");
      assert.equal(reserved.stripeCheckoutSessionId, null);
      await payments.create(input);
      assert.equal(sessions.size, before + 1);
      assert.ok(
        (await owner.payment.findFirstOrThrow({ where: { jobId: row.id } }))
          .stripeCheckoutSessionId,
      );
    },
  );
  await check(
    "abandoned-reservation recovery retains the same mocked provider operation after the existing timeout",
    async () => {
      const { row, input, before } = interruptedRequest;
      // Admin fixture time advance only; the immediate recovery failure above stays failed.
      await owner.payment.updateMany({
        where: { jobId: row.id },
        data: { requestedAt: new Date(Date.now() - 6 * 60000) },
      });
      await payments.create(input);
      assert.equal(sessions.size, before + 1);
      assert.ok(
        (await owner.payment.findFirstOrThrow({ where: { jobId: row.id } }))
          .stripeCheckoutSessionId,
      );
    },
  );
  await check(
    "pre-provider foreign/missing/stale/pricing/account/closed-state refusals",
    async () => {
      const before = mockCheckoutCalls;
      await rejectStatus(
        () => payments.create({ ...mainInput, tenantId: otherTenant.id }),
        404,
      );
      await rejectStatus(
        () => payments.create({ ...mainInput, jobId: randomUUID() }),
        404,
      );
      await rejectStatus(
        () =>
          payments.create({
            ...mainInput,
            expectedJobUpdatedAt: new Date(0).toISOString(),
          }),
        409,
      );
      const noPolicy = await job();
      await rejectStatus(() => payments.create(createInput(noPolicy)), 409);
      const noPrice = await job({ policySnapshot: { depositRequired: true } });
      await rejectStatus(() => payments.create(createInput(noPrice)), 422);
      const closed = await boundJob();
      await owner.job.update({
        where: { id: closed.id },
        data: { status: "CANCELLED" },
      });
      const current = await owner.job.findUniqueOrThrow({
        where: { id: closed.id },
      });
      await rejectStatus(() => payments.create(createInput(current)), 409);
      await owner.tenantOrganization.update({
        where: { id: tenant.id },
        data: { chargesEnabled: false },
      });
      try {
        await rejectStatus(() => payments.create(mainInput), 503);
      } finally {
        await owner.tenantOrganization.update({
          where: { id: tenant.id },
          data: { chargesEnabled: true },
        });
      }
      assert.equal(mockCheckoutCalls, before);
    },
  );
  await check(
    "populated existing operator dispatch/routing/payment/event read dependencies",
    async () => {
      assert.ok(
        (await dispatch.list(tenant.id)).some(
          (row) => row.jobId === mainJob.id,
        ),
      );
      const detail = await dispatch.get(tenant.id, mainJob.id);
      assert.equal(detail.jobId, mainJob.id);
      assert.ok(detail.candidates.some((row) => row.userId === tech.id));
      assert.equal(detail.paymentGate.state, "LOCKED");
      assert.deepEqual(await payments.events(tenant.id, mainJob.id), []);
    },
  );
  await check(
    "signature/mode/account/resource/metadata/money refusals leave persisted state unchanged",
    async () => {
      const before = await counts(mainJob.id);
      const events = [
        { ...signed(mainPayment), signature: "t=0,v1=" + "0".repeat(64) },
        signed(mainPayment, undefined, {}, { livemode: true }),
        signed(
          mainPayment,
          undefined,
          {},
          { account: otherTenant.stripeConnectAccountId },
        ),
        signed(mainPayment, undefined, { id: "cs_local_foreign" }),
        signed(mainPayment, undefined, {
          metadata: { paymentRequestId: randomUUID() },
        }),
        signed(mainPayment, undefined, { amount_total: 1 }),
        signed(mainPayment, undefined, { currency: "eur" }),
      ];
      for (const event of events) await assert.rejects(receive(hooks, event));
      assert.deepEqual(await counts(mainJob.id), before);
    },
  );
  await check(
    "webhook audit failure atomically rolls back event reservation and payment",
    async () => {
      const before = await counts(mainJob.id),
        event = signed(mainPayment);
      await auditFault("payment.webhook_transitioned", mainJob.id, () =>
        assert.rejects(receive(hooks, event)),
      );
      assert.deepEqual(await counts(mainJob.id), before);
    },
  );
  await check(
    "signed matching settlement; concurrent exact-event duplicate; persisted gate clears",
    async () => {
      const event = signed(mainPayment);
      const replies = await Promise.all([
        receive(hooks, event),
        receive(hooks, event),
      ]);
      assert.equal(replies.filter((x) => x.duplicate === false).length, 1);
      assert.equal(replies.filter((x) => x.duplicate === true).length, 1);
      assert.equal(
        (await payments.get(tenant.id, mainJob.id)).status,
        "SUCCEEDED",
      );
      assert.equal(
        (await dispatch.get(tenant.id, mainJob.id)).paymentGate.state,
        "UNLOCKED",
      );
      assert.equal(
        await owner.auditLog.count({
          where: {
            entityId: mainPayment.id,
            action: "payment.webhook_transitioned",
          },
        }),
        1,
      );
      assert.equal((await payments.events(tenant.id, mainJob.id)).length, 1);
    },
  );
  await check(
    "sequential late failure/expiry and redirect-only evidence cannot undo settlement",
    async () => {
      await receive(
        hooks,
        signed(mainPayment, "payment_intent.payment_failed"),
      );
      await receive(hooks, signed(mainPayment, "checkout.session.expired"));
      assert.equal(
        (await payments.get(tenant.id, mainJob.id)).status,
        "SUCCEEDED",
      );
      const pending = await owner.payment.findFirstOrThrow({
        where: { jobId: { not: mainJob.id }, status: "PENDING" },
      });
      assert.equal(
        (await payments.get(tenant.id, pending.jobId)).status,
        "PENDING",
      );
    },
  );

  await check(
    "real permission denials preserve excluded tables/columns and immutable identities",
    async () => {
      const denied = [
        ...[
          "id",
          "tenantId",
          "jobId",
          "jobTenantId",
          "createdAt",
          "transferGroup",
          "transferId",
        ].map((col) => `UPDATE "Payment" SET "${col}"="${col}" WHERE false`),
        ...[
          "id",
          "tenantId",
          "status",
          "assignedUserId",
          "calendarEventId",
          "serviceWindowStart",
          "completedAt",
        ].map((col) => `UPDATE "Job" SET "${col}"="${col}" WHERE false`),
        ...["id", "tenantId", "stripeEventId", "type", "payload"].map(
          (col) => `UPDATE "StripeEvent" SET "${col}"="${col}" WHERE false`,
        ),
        'UPDATE "AuditLog" SET action=action WHERE false',
        'UPDATE "TenantOrganization" SET settings=settings WHERE false',
        ...[
          "CalendarOperation",
          "Customer",
          "User",
          "ServiceCategory",
          "RoutingRule",
          "ServiceArea",
          "UserServiceCapability",
          "UserAvailabilityBlock",
          "PropertyAddress",
          "TenantSubscription",
          "LedgerEntry",
          "CommunicationEvent",
          "CommunicationContent",
          "SmsEnqueueIntent",
          "AppointmentEmailIntent",
        ].map((table) => `DELETE FROM "${table}" WHERE false`),
        ...["Job", "Payment", "StripeEvent", "AuditLog"].map(
          (table) => `DELETE FROM "${table}" WHERE false`,
        ),
        'INSERT INTO "Job" SELECT * FROM "Job" WHERE false',
        'SELECT * FROM "TenantSubscription" LIMIT 0',
        "SELECT * FROM pg_authid LIMIT 0",
        "CREATE TABLE public.p07_forbidden(id int)",
        "CREATE SCHEMA p07_forbidden",
        "CREATE ROLE p07_forbidden",
        "CREATE DATABASE p07_forbidden",
        `SET ROLE "${local.user}"`,
        "CREATE TEMP TABLE p07_forbidden(id int)",
      ];
      for (const sql of denied) await deny(sql);
      assert.equal(
        (
          await raw.query(
            "SELECT 1 FROM pg_roles WHERE rolname='p07_forbidden'",
          )
        ).rowCount,
        0,
      );
      pass("negative SQL cases: " + denied.length);
    },
  );

  await observe(
    "different concurrent event types must not regress a committed settlement",
    async () => {
      const row = await boundJob();
      await payments.create(createInput(row));
      const payment = await owner.payment.findFirstOrThrow({
        where: { jobId: row.id },
      });
      let releaseSuccess, releaseFailure, announceBoth;
      const successGate = new Promise((resolve) => {
        releaseSuccess = resolve;
      });
      const failureGate = new Promise((resolve) => {
        releaseFailure = resolve;
      });
      const both = new Promise((resolve) => {
        announceBoth = resolve;
      });
      let arrived = 0;
      // Scheduling hook around real queries, never synthetic database responses.
      const scheduled = runtime.$extends({
        query: {
          payment: {
            async findFirst({ args, query }) {
              const actual = await query(args);
              if (actual?.id === payment.id) {
                if (++arrived === 2) announceBoth();
                await (args.where.stripeCheckoutSessionId
                  ? successGate
                  : failureGate);
              }
              return actual;
            },
          },
        },
      });
      const concurrentHooks = new StripeWebhooksService(scheduled, {
        stripeWebhookSecret: webhookSecret,
        stripeWebhookLivemode: false,
      });
      const success = receive(concurrentHooks, signed(payment));
      const failure = receive(
        concurrentHooks,
        signed(payment, "payment_intent.payment_failed"),
      );
      success.catch(() => {});
      failure.catch(() => {});
      try {
        await Promise.race([
          both,
          new Promise((_, reject) =>
            setTimeout(
              () => reject(Error("RACE_BARRIER_TIMEOUT")),
              5000,
            ).unref(),
          ),
        ]);
        releaseSuccess();
        await success;
        assert.equal(
          (await payments.get(tenant.id, row.id)).status,
          "SUCCEEDED",
        );
        releaseFailure();
        await failure;
        assert.equal(
          (await payments.get(tenant.id, row.id)).status,
          "SUCCEEDED",
        );
      } finally {
        releaseSuccess();
        releaseFailure();
        await Promise.allSettled([success, failure]);
      }
    },
  );
} catch (error) {
  if (interruption && error.message === "EXPECTED_LOCAL_INTERRUPTION")
    caught = "EXPECTED_LOCAL_INTERRUPTION";
  else {
    caught = error;
    failures.push({
      case: phase,
      code: error.code ?? error.name,
      detail: error.meta?.code,
    });
    console.error("FAIL " + JSON.stringify(failures.at(-1)));
  }
} finally {
  async function cleanStep(name, fn) {
    try {
      await fn();
    } catch (error) {
      failures.push({ case: name, code: error.code ?? error.name });
    }
  }
  await cleanStep("RUNTIME_CLIENT_CLOSE", async () => {
    if (runtime) await runtime.$disconnect();
  });
  await cleanStep("RUNTIME_POOL_CLOSE", async () => {
    if (runtimePool && !runtimePool.ended) await runtimePool.end();
  });
  await cleanStep("ROLE_CONTAINMENT", async () => {
    if (raw && roleCreated) {
      await raw.query(
        `ALTER ROLE ${role} NOLOGIN CONNECTION LIMIT 0 VALID UNTIL '1970-01-01 00:00:00+00'`,
      );
      await raw.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND usename=$2 AND pid<>pg_backend_pid()",
        [database, role],
      );
      const state = (
        await raw.query(
          "SELECT rolcanlogin,rolconnlimit,rolvaliduntil<now() AS expired,(SELECT count(*)::int FROM pg_stat_activity WHERE datname=$1 AND usename=$2) AS sessions FROM pg_roles WHERE rolname=$2",
          [database, role],
        )
      ).rows[0];
      assert.deepEqual(state, {
        rolcanlogin: false,
        rolconnlimit: 0,
        expired: true,
        sessions: 0,
      });
      cleanup.roleClosed = true;
      cleanup.roleSessions = 0;
      await raw.query(`DROP OWNED BY ${role}`);
      await raw.query(`DROP ROLE ${role}`);
      assert.equal(
        (await raw.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [role]))
          .rowCount,
        0,
      );
      cleanup.roleRemoved = true;
    }
  });
  await cleanStep("OWNER_CLIENT_CLOSE", async () => {
    if (owner) await owner.$disconnect();
  });
  await cleanStep("OWNER_POOL_CLOSE", async () => {
    if (ownerPool && !ownerPool.ended) await ownerPool.end();
  });
  await cleanStep("RAW_CLIENT_CLOSE", async () => {
    if (raw) await raw.end();
  });
  await cleanStep("DATABASE_CLEANUP", async () => {
    if (admin && databaseCreated) {
      await admin.query(`DROP DATABASE "${database}"`);
      assert.equal(
        (
          await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [
            database,
          ])
        ).rowCount,
        0,
      );
      cleanup.databaseRemoved = true;
    }
  });
  await cleanStep("ADMIN_CLIENT_CLOSE", async () => {
    if (admin) await admin.end();
  });
  try {
    // A failed start acknowledgement does not establish that no server exists.
    // Probe only our own new data directory, regardless of the started flag.
    if (startupAttempted) {
      const status = spawnSync(bin + "pg_ctl", ["-D", data, "status"], {
        stdio: "ignore",
        timeout: 5000,
      });
      if (status.status === 0)
        execFileSync(
          bin + "pg_ctl",
          ["-D", data, "-m", "fast", "-t", "10", "-w", "stop"],
          { stdio: "ignore", timeout: 15000 },
        );
      else
        assert.equal(status.status, 3, "Owned postmaster state is unconfirmed");
      assert.equal(
        spawnSync(bin + "pg_ctl", ["-D", data, "status"], {
          stdio: "ignore",
          timeout: 5000,
        }).status,
        3,
      );
      cleanup.clusterStopped = true;
    }
    if (cleanup.clusterStopped || !startupAttempted) {
      await rm(dir, { recursive: true });
      cleanup.scratchRemoved = true;
    }
  } catch (error) {
    failures.push({
      case: "OWNED_CLUSTER_CLEANUP",
      code: error.code ?? error.name,
    });
  }
}

assert.deepEqual(
  await Promise.all(
    originalFiles.map(async (file) =>
      digest(await readFile(new URL(file, import.meta.url))),
    ),
  ),
  originalHashes,
);
let interruptionProof = null;
if (!interruption && cleanup.clusterStopped && cleanup.roleClosed) {
  try {
    const output = execFileSync(
      process.execPath,
      [fileURLToPath(import.meta.url), "--prove-interruption"],
      { encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"] },
    );
    interruptionProof = JSON.parse(output.trim().split("\n").at(-1));
    assert.equal(interruptionProof.status, "INTERRUPTION_CONTAINED");
    assert.ok(
      Object.entries(interruptionProof.cleanup).every(([key, value]) =>
        key === "roleSessions" ? value === 0 : value === true,
      ),
    );
    pass(
      "actual SIGINT after restricted-role activation unwinds through verified cleanup",
    );
  } catch (error) {
    failures.push({
      case: "SIGINT_RECOVERY_PROOF",
      code: error.code ?? error.name,
    });
  }
}
const summary = {
  status: failures.length
    ? "LOCAL_PROOF_BLOCKED"
    : interruption
      ? "INTERRUPTION_CONTAINED"
      : "LOCAL_PERMISSION_PROOF_PASSED",
  passedChecks: checks.length,
  failures,
  fixtureSha256: fixtureHash,
  aclSha256: aclHash,
  generatedInsertShapes: [...sqlShapes].sort(),
  mockCheckoutCalls,
  mockRecoverCalls,
  providerCalls: 0,
  secretCalls: 0,
  p06SourceUnchanged: true,
  cleanup,
  interruptionProof: interruptionProof?.status ?? null,
};
console.log(JSON.stringify(summary));
if (
  failures.length ||
  (interruption && caught !== "EXPECTED_LOCAL_INTERRUPTION")
)
  process.exitCode = 1;
