// Disposable parent database only; no provider calls, production data or settlement.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, realpath, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { createCleanupConnection } from "./p06-cleanup-connector.mjs";
import { runCleanup, planHash } from "./p06-cleanup-maintenance.mjs";
import { localCorrectionPort } from "./local-correction-port.mjs";
const require = createRequire(import.meta.url);
const {
  VerificationCleanupService,
} = require("../dist/communications/verification-cleanup.service.js");
const {
  lockCustomerConsentSession,
} = require("../dist/communications/customer-consent-session-lock.js");
const {
  requestContextMiddleware,
  setAuthContext,
} = require("../dist/common/context/request-context.js");

export async function verifyVerificationCleanup({
  prisma,
  credentials,
  responses,
}) {
  const [db] = await prisma.$queryRawUnsafe(
    "SELECT current_database() AS name, inet_server_addr() AS address",
  );
  assert.match(db.name, /^calldesk_org_[0-9a-f]{12}$/);
  assert.equal(db.address, null);
  const tenant = await prisma.tenantOrganization.create({
    data: { name: "Fictional cleanup", timezone: "UTC", settings: {} },
  });
  const tenantId = tenant.id;
  const fixture = (fn) =>
    new Promise((resolve, reject) =>
      requestContextMiddleware({ headers: {} }, {}, () => {
        setAuthContext({
          tenantId,
          userId: "integration:cleanup-fixture",
          role: "webchat_integration",
        });
        Promise.resolve().then(fn).then(resolve, reject);
      }),
    );
  const service = new VerificationCleanupService(
    prisma,
    credentials,
    "FIXTURE_ONLY",
  );
  const begin = async () => {
    const r = await fixture(() => responses.start());
    return {
      token: r.sessionToken,
      scope: credentials.verifySession(r.sessionToken),
    };
  };
  const row = async (s) =>
    prisma.conversation.findUnique({ where: { id: s.scope.conversationId } });
  const edit = async (s, fn) => {
    const r = await row(s);
    const data = structuredClone(r.collectedData);
    fn(data);
    await prisma.conversation.update({
      where: { id: r.id },
      data: { collectedData: data },
    });
  };
  async function content(
    s,
    type = "protected_intake_turn_v1",
    sessionId = s.scope.sessionId,
  ) {
    return prisma.communicationEvent.create({
      data: {
        tenantId,
        conversationId: s.scope.conversationId,
        conversationTenantId: tenantId,
        channel: "WEBCHAT",
        direction: "INBOUND",
        provider: "OTHER",
        status: "RECEIVED",
        content: {
          create: {
            tenantId,
            payload: {
              type,
              sessionId,
              version: 1,
              encryptedInput: "fictional ciphertext",
            },
          },
        },
      },
      include: { content: true },
    });
  }
  const a = await begin(),
    b = await begin();
  await edit(a, (d) => {
    d.verificationOperations = "private fixture";
    d.localPhone = "private fixture";
    d.localAddress = "private fixture";
    d.unrelated = { keep: true };
  });
  const abandoned = await content(a);
  const unrelated = await content(a, "unrelated_business_record");
  const foreignPayload = await content(
    a,
    "protected_intake_turn_v1",
    randomUUID(),
  );
  const policy = {
    mode: "FIXTURE_ONLY",
    version: "1A",
    lifetimeMs: 1800000,
    noticeVersion: "fixture",
    sourceVersion: "mock",
    businessPolicyVersion: "approved",
  };
  let calls = 0;
  const options = {
    prisma,
    credentials,
    readPolicy: async () => policy,
    adapter: {
      preview: async () => {
        calls++;
        return {
          candidate: {
            addressLines: ["123 Fictional Street"],
            locality: "Example",
            administrativeArea: "OH",
            postalCode: "44101",
            regionCode: "US",
          },
        };
      },
    },
  };
  let correction = localCorrectionPort(options);
  const propose = (s) => ({
    sessionToken: s.token,
    action: "propose",
    requestId: randomUUID(),
    input: {
      street: "123 Fictional St",
      city: "Example",
      postalCode: "44101",
      unit: "",
    },
    candidateId: "",
    confirmed: false,
    revision: 0,
  });
  const pa = propose(a),
    pb = propose(b);
  const [ca, cb] = await Promise.all([
    fixture(() => correction.handle(pa)),
    fixture(() => correction.handle(pb)),
  ]);
  assert.equal(ca.status, "CONFIRMATION_REQUIRED");
  assert.equal(cb.status, "CONFIRMATION_REQUIRED");
  assert.equal(correction.size(), 2);
  const confirm = (p, c) => ({
    ...p,
    action: "confirm",
    requestId: "",
    candidateId: c.candidateId,
    revision: c.revision,
    confirmed: true,
  });
  assert.equal(
    (await fixture(() => correction.handle(confirm(pb, ca)))).status,
    "REFUSED",
  );
  assert.equal(
    (await fixture(() => correction.handle(confirm(pa, ca)))).status,
    "CUSTOMER_CONFIRMED",
  );
  // Close commits, but make first physical purge audit fail and roll back deletion.
  const fail = new VerificationCleanupService(
    {
      $transaction: (fn) =>
        prisma.$transaction((tx) =>
          fn(
            new Proxy(tx, {
              get(target, key) {
                if (key === "auditLog")
                  return {
                    ...target.auditLog,
                    create: (args) => {
                      if (
                        args.data.action ===
                          "conversation.verification_session_purged" ||
                        args.data.action ===
                          "conversation.address_references_purged"
                      )
                        throw Error("fictional cleanup fault");
                      return target.auditLog.create(args);
                    },
                  };
                const value = target[key];
                return typeof value === "function" ? value.bind(target) : value;
              },
            }),
          ),
        ),
    },
    credentials,
    "FIXTURE_ONLY",
  );
  const closed = await fail.end(a.token);
  assert.equal(closed.cleanupPending, true);
  assert.notEqual(
    (await row(a)).collectedData.verificationLifecycle.closedAt,
    null,
  );
  assert.equal(
    (await row(a)).collectedData.verificationLifecycle.purgedAt,
    null,
  );
  assert.equal(
    (await row(a)).collectedData.verificationOperations,
    "private fixture",
  );
  await assert.rejects(
    prisma.$transaction((tx) => lockCustomerConsentSession(tx, a.scope)),
  );
  await correction.sweep();
  assert.equal(correction.size(), 1);
  assert.equal(
    (await fixture(() => correction.handle(confirm(pb, cb)))).status,
    "CUSTOMER_CONFIRMED",
  );
  await new VerificationCleanupService(
    prisma,
    credentials,
    "FIXTURE_ONLY",
  ).sweep(tenantId);
  const cleaned = (await row(a)).collectedData;
  for (const key of ["verificationOperations", "localPhone", "localAddress"])
    assert.equal(key in cleaned, false);
  assert.deepEqual(cleaned.unrelated, { keep: true });
  assert.equal(
    await prisma.communicationContent.count({
      where: { id: abandoned.content.id },
    }),
    0,
  );
  assert.equal(
    await prisma.communicationContent.count({
      where: { id: unrelated.content.id },
    }),
    1,
  );
  assert.equal(
    await prisma.communicationContent.count({
      where: { id: foreignPayload.content.id },
    }),
    1,
  );
  // Process reconstruction has no cached candidate and cannot redispatch old observed request.
  correction.clear();
  correction = localCorrectionPort(options);
  const before = calls;
  assert.notEqual(
    (await fixture(() => correction.handle(pb))).status,
    "CONFIRMATION_REQUIRED",
  );
  assert.equal(calls, before);
  // Restored expired transient snapshot remains inaccessible, then purges again.
  await edit(a, (d) => {
    d.verificationLifecycle = {
      version: 1,
      expiresAt: Date.now() - 1,
      closedAt: null,
      purgedAt: null,
    };
    d.localAddress = "restored expired fixture";
  });
  await assert.rejects(
    prisma.$transaction((tx) => lockCustomerConsentSession(tx, a.scope)),
  );
  await service.sweep(tenantId);
  assert.equal("localAddress" in (await row(a)).collectedData, false);
  const submitted = await begin();
  const saved = await content(submitted, "protected_intake_review_v1");
  const turn = await content(submitted);
  await service.end(submitted.token);
  assert.equal(
    await prisma.communicationContent.count({
      where: { id: { in: [saved.content.id, turn.content.id] } },
    }),
    2,
  );
  const aged = await begin();
  await content(aged);
  await edit(aged, (d) => {
    d.verificationLifecycle.expiresAt = Date.now() - 7 * 86400000;
  });
  const concurrent = await Promise.all([
    service.sweep(tenantId),
    service.sweep(tenantId),
  ]);
  assert.equal(concurrent.length, 2);
  assert.equal(
    await prisma.communicationContent.count({
      where: {
        communicationEvent: { conversationId: aged.scope.conversationId },
      },
    }),
    0,
  );
  assert.equal(
    await prisma.auditLog.count({
      where: {
        entityId: aged.scope.conversationId,
        action: "conversation.verification_session_purged",
      },
    }),
    1,
  );
  const legacy = await begin();
  await edit(legacy, (d) => {
    delete d.verificationLifecycle;
    d.unrelated = "legacy do not adopt";
  });
  await service.sweep(tenantId);
  assert.equal(
    (await row(legacy)).collectedData.unrelated,
    "legacy do not adopt",
  );
  const malformed = await begin();
  await edit(malformed, (d) => {
    d.verificationLifecycle.expiresAt = "invalid";
  });
  assert.ok((await service.sweep(tenantId)).pending >= 1);
  await assert.rejects(
    prisma.$transaction((tx) =>
      lockCustomerConsentSession(tx, malformed.scope),
    ),
  );
  // Supported resolved references: only aliases of never-dispatched cancellations.
  const accountId = randomUUID();
  async function operation(state, days, held = 0n) {
    const id = randomUUID();
    const attemptId = state === "UNCERTAIN" ? randomUUID() : null;
    await prisma.addressVerificationOperation.create({
      data: {
        id,
        accountId,
        tenantId,
        conversationId: aged.scope.conversationId,
        sessionId: aged.scope.sessionId,
        intentId: randomUUID(),
        revision: 1,
        policyHash: "fixture",
        state,
        heldMicros: held,
        attemptId,
      },
    });
    await prisma.addressVerificationRequest.create({
      data: { id: randomUUID(), operationId: id },
    });
    await prisma.auditLog.create({
      data: {
        tenantId,
        entityType: "Conversation",
        entityId: aged.scope.conversationId,
        actorType: "CUSTOMER",
        actorId: "address-operation-session",
        action: "conversation.address_operation_cancelled",
        metadata: { operationId: id },
        createdAt: new Date(Date.now() - days * 86400000),
      },
    });
    return id;
  }
  const old = await operation("CANCELLED", 91),
    young = await operation("CANCELLED", 89),
    uncertain = await operation("UNCERTAIN", 100, 10n);
  const holdsBefore = await prisma.addressVerificationOperation.aggregate({
    where: { tenantId },
    _sum: { heldMicros: true },
    _count: true,
  });
  assert.equal(
    (await service.purgeResolvedReferences(randomUUID())).removed,
    0,
  );
  await assert.rejects(fail.purgeResolvedReferences(tenantId));
  assert.equal(
    await prisma.addressVerificationRequest.count({
      where: { operationId: old },
    }),
    1,
  );
  assert.equal((await service.purgeResolvedReferences(tenantId)).removed, 1);
  assert.equal(
    await prisma.addressVerificationRequest.count({
      where: { operationId: old },
    }),
    0,
  );
  assert.equal(
    await prisma.addressVerificationRequest.count({
      where: { operationId: { in: [young, uncertain] } },
    }),
    2,
  );
  assert.deepEqual(
    await prisma.addressVerificationOperation.aggregate({
      where: { tenantId },
      _sum: { heldMicros: true },
      _count: true,
    }),
    holdsBefore,
  );
  assert.equal((await service.purgeResolvedReferences(tenantId)).removed, 0);
  // Exact maintenance uses the same transactions with a distinct, expired-only binding.
  const maintenanceSessions = await Promise.all([begin(), begin(), begin()]);
  const maintenanceAccount = randomUUID(),
    expiresAt = Date.now() - 60000;
  const maintenanceTargets = [];
  for (const session of maintenanceSessions) {
    await edit(session, (d) => {
      d.verificationLifecycle.expiresAt = expiresAt;
      d.verificationOperations = { private: "synthetic" };
    });
    const operations = [];
    for (let i = 0; i < 2; i++) {
      const operation = {
        id: randomUUID(),
        attemptId: randomUUID(),
        createdAt: expiresAt - 10000,
        executionDeadline: expiresAt - 2000,
        heldMicros: 100000,
        aliasCount: 1,
        state: "OBSERVED",
      };
      await prisma.addressVerificationOperation.create({
        data: {
          id: operation.id,
          attemptId: operation.attemptId,
          accountId: maintenanceAccount,
          tenantId,
          conversationId: session.scope.conversationId,
          sessionId: session.scope.sessionId,
          intentId: randomUUID(),
          revision: 1,
          policyHash: "synthetic",
          state: "OBSERVED",
          heldMicros: 100000n,
          createdAt: new Date(operation.createdAt),
          executionDeadline: new Date(operation.executionDeadline),
          requests: { create: { id: randomUUID() } },
        },
      });
      operations.push(operation);
    }
    maintenanceTargets.push({
      conversationId: session.scope.conversationId,
      sessionId: session.scope.sessionId,
      expiresAt,
      operations,
    });
  }
  const drafts = await Promise.all(maintenanceSessions.map((s) => content(s)));
  const preservedReview = await content(
    maintenanceSessions[1],
    "protected_intake_review_v1",
  );
  const otherVersion = await content(maintenanceSessions[0]);
  await prisma.communicationContent.update({
    where: { id: otherVersion.content.id },
    data: {
      payload: {
        type: "protected_intake_turn_v1",
        sessionId: maintenanceSessions[0].scope.sessionId,
        version: 3,
        encryptedInput: "synthetic",
      },
    },
  });
  const otherSession = await content(
    maintenanceSessions[0],
    "protected_intake_turn_v1",
    randomUUID(),
  );
  const customer = await prisma.customer.create({
    data: {
      tenantId,
      phone: "+12025550198",
      fullName: "Synthetic maintenance",
    },
  });
  const address = await prisma.propertyAddress.create({
    data: {
      tenantId,
      customerId: customer.id,
      customerTenantId: tenantId,
      formattedAddress: "Synthetic only",
      addressComponents: {},
    },
  });
  const category = await prisma.serviceCategory.create({
    data: { tenantId, name: "Synthetic maintenance" },
  });
  const job = await prisma.job.create({
    data: {
      tenantId,
      customerId: customer.id,
      customerTenantId: tenantId,
      propertyAddressId: address.id,
      propertyAddressTenantId: tenantId,
      serviceCategoryId: category.id,
      serviceCategoryTenantId: tenantId,
      status: "CREATED",
      urgency: "STANDARD",
      pricingSnapshot: {},
      policySnapshot: {},
    },
  });
  await prisma.conversationJobLink.create({
    data: {
      tenantId,
      conversationId: maintenanceSessions[2].scope.conversationId,
      conversationTenantId: tenantId,
      jobId: job.id,
      jobTenantId: tenantId,
      relationType: "ABOUT",
    },
  });
  await prisma.auditLog.create({
    data: {
      tenantId,
      entityType: "Conversation",
      entityId: maintenanceSessions[0].scope.conversationId,
      actorType: "SYSTEM_AI",
      actorId: "synthetic-maintenance-fixture",
      action: "conversation.controlled_phone_held",
      metadata: {
        accountSid: "synthetic-cleanup-account",
        state: "HELD",
        reservedMicros: 500000,
        version: 1,
        currency: "USD",
      },
    },
  });
  const inventory = () =>
    prisma.addressVerificationOperation.findMany({
      where: { tenantId },
      include: { requests: true },
      orderBy: { id: "asc" },
    });
  const beforeInventory = await inventory(),
    beforeAudits = await prisma.auditLog.findMany({
      where: { tenantId },
      orderBy: { id: "asc" },
    });
  const mode = {
    mode: "EXACT_SESSION_MAINTENANCE_V1",
    tenantId,
    accountId: maintenanceAccount,
    approvalId: randomUUID(),
    operationId: randomUUID(),
    validFrom: Date.now() - 1000,
    validUntil: Date.now() + 600000,
    targets: maintenanceTargets,
  };
  const maint = new VerificationCleanupService(prisma, credentials, mode);
  assert.deepEqual(await maint.inspectMaintenance(), { eligible: 3 });
  const target = (i) => ({
    conversationId: maintenanceTargets[i].conversationId,
    sessionId: maintenanceTargets[i].sessionId,
  });
  const failMaintenance = (action) =>
    new VerificationCleanupService(
      {
        $transaction: (fn) =>
          prisma.$transaction((tx) =>
            fn(
              new Proxy(tx, {
                get(obj, key) {
                  if (key === "auditLog")
                    return {
                      ...obj.auditLog,
                      create: (args) => {
                        if (args.data.action === action)
                          throw Error("synthetic rollback");
                        return obj.auditLog.create(args);
                      },
                    };
                  const v = obj[key];
                  return typeof v === "function" ? v.bind(obj) : v;
                },
              }),
            ),
          ),
      },
      credentials,
      mode,
    );
  await assert.rejects(
    failMaintenance("conversation.verification_session_closed").maintain(
      target(0),
    ),
  );
  assert.equal(
    (await row(maintenanceSessions[0])).collectedData.verificationLifecycle
      .closedAt,
    null,
  );
  const pending = await failMaintenance(
    "conversation.verification_session_purged",
  ).maintain(target(0));
  assert.equal(pending.cleanupPending, true);
  assert.notEqual(
    (await row(maintenanceSessions[0])).collectedData.verificationLifecycle
      .closedAt,
    null,
  );
  assert.equal(
    (await row(maintenanceSessions[0])).collectedData.verificationLifecycle
      .purgedAt,
    null,
  );
  assert.equal(
    await prisma.communicationContent.count({
      where: { id: drafts[0].content.id },
    }),
    1,
  );
  const concurrentMaintenance = await Promise.all([
    maint.maintain(target(0)),
    maint.maintain(target(0)),
  ]);
  assert.ok(concurrentMaintenance.every((r) => !r.cleanupPending));
  await maint.maintain(target(1));
  await maint.maintain(target(2));
  for (const session of maintenanceSessions) {
    const r = await row(session);
    assert.equal(r.status, "ONGOING");
    assert.ok(r.collectedData.verificationLifecycle.closedAt > 0);
    assert.ok(r.collectedData.verificationLifecycle.purgedAt > 0);
    assert.equal("verificationOperations" in r.collectedData, false);
    for (const action of ["closed", "purged"])
      assert.equal(
        await prisma.auditLog.count({
          where: {
            entityId: session.scope.conversationId,
            action: "conversation.verification_session_" + action,
          },
        }),
        1,
      );
  }
  assert.equal(
    await prisma.communicationContent.count({
      where: { id: drafts[0].content.id },
    }),
    0,
  );
  for (const c of [
    drafts[1],
    drafts[2],
    preservedReview,
    otherVersion,
    otherSession,
  ])
    assert.equal(
      await prisma.communicationContent.count({ where: { id: c.content.id } }),
      1,
    );
  assert.deepEqual(await inventory(), beforeInventory);
  for (const audit of beforeAudits)
    assert.deepEqual(
      await prisma.auditLog.findUnique({ where: { id: audit.id } }),
      audit,
    );
  assert.deepEqual(await prisma.job.findUnique({ where: { id: job.id } }), job);
  // Reopen only disposable synthetic fixtures for connector + runner integration.
  for (const session of maintenanceSessions)
    await edit(session, (d) => {
      d.verificationLifecycle.closedAt = null;
      d.verificationLifecycle.purgedAt = null;
      d.verificationOperations = { private: "synthetic" };
    });
  await content(maintenanceSessions[0]);
  await prisma.tenantOrganization.update({
    where: { id: tenantId },
    data: {
      settings: {
        controlledPhoneApproval: { enabled: false },
        controlledRuntimeApproval: { enabled: false },
      },
    },
  });
  const roles = await prisma.$queryRawUnsafe(
    "SELECT rolname FROM pg_roles WHERE rolname='p06_intake_runtime'",
  );
  if (!roles.length)
    await prisma.$executeRawUnsafe(
      "CREATE ROLE p06_intake_runtime NOLOGIN CONNECTION LIMIT 0 VALID UNTIL '2000-01-01'",
    );
  const [identity] = await prisma.$queryRawUnsafe(
    "SELECT current_database() AS database,current_user AS user",
  );
  const binding = {
    ...mode,
    operationId: randomUUID(),
    approvalId: randomUUID(),
  };
  const connectorTarget = {
    ...identity,
    phoneAccountSid: "synthetic-cleanup-account",
    expectedRetention: maintenanceTargets
      .map((t, i) => ({
        id: t.conversationId,
        reviews: i === 1 ? 1 : 0,
        jobs: i === 2 ? 1 : 0,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
  let connectorClosed = false;
  await assert.rejects(
    createCleanupConnection({
      prisma,
      binding,
      target: { ...connectorTarget, database: "wrong" },
      close: async () => {},
    }),
    /CLEANUP_PREFLIGHT_REFUSED/,
  );
  const connection = await createCleanupConnection({
    prisma,
    binding,
    target: connectorTarget,
    close: async () => {
      connectorClosed = true;
    },
  });
  await prisma.tenantOrganization.update({
    where: { id: tenantId },
    data: {
      settings: {
        controlledPhoneApproval: { enabled: true },
        controlledRuntimeApproval: { enabled: false },
      },
    },
  });
  await assert.rejects(connection.preflight());
  await prisma.tenantOrganization.update({
    where: { id: tenantId },
    data: {
      settings: {
        controlledPhoneApproval: { enabled: false },
        controlledRuntimeApproval: { enabled: false },
      },
    },
  });
  await prisma.$executeRawUnsafe("ALTER ROLE p06_intake_runtime LOGIN");
  await assert.rejects(connection.preflight());
  await prisma.$executeRawUnsafe("ALTER ROLE p06_intake_runtime NOLOGIN");
  const sourceRoot = await realpath(process.cwd());
  const names = [
    "src/communications/verification-cleanup.service.ts",
    "dist/communications/verification-cleanup.service.js",
    "scripts/p06-cleanup-maintenance.mjs",
    "scripts/p06-cleanup-connector.mjs",
    "scripts/p06_backup_guards.mjs",
    "package-lock.json",
    "prisma/schema.prisma",
  ];
  const sourceHashes = Object.fromEntries(
    await Promise.all(
      names.map(async (n) => [
        n,
        createHash("sha256")
          .update(await readFile(path.join(sourceRoot, n)))
          .digest("hex"),
      ]),
    ),
  );
  const plan = { binding, target: connectorTarget, sourceHashes };
  const reviewedPlanHash = planHash(plan);
  const journalRoot = await realpath(
    await mkdtemp(path.join(tmpdir(), "cleanup-connector-fixture-")),
  );
  try {
    await runCleanup({
      plan,
      reviewedPlanHash,
      authorization: {
        decision: "APPROVED",
        action: "THREE_EXPIRED_SESSION_CLEANUP",
        operationId: binding.operationId,
        approvalId: binding.approvalId,
        planHash: reviewedPlanHash,
        automaticRetryAllowed: false,
        deploymentAllowed: false,
      },
      sourceRoot,
      journalRoot,
      input: Readable.from([Buffer.from("synthetic-password\n")]),
      ready: () => {},
      connect: async () => connection,
    });
    const receipt = JSON.parse(
      await readFile(path.join(journalRoot, "result.json"), "utf8"),
    );
    assert.equal(receipt.status, "CLEANUP_VERIFIED");
    assert.equal(connectorClosed, true);
    await connection.verifyUnchangedAndClosed();
    const held = await prisma.auditLog.findFirst({
      where: { tenantId, action: "conversation.controlled_phone_held" },
    });
    await prisma.auditLog.update({
      where: { id: held.id },
      data: { metadata: { ...held.metadata, reservedMicros: 1 } },
    });
    await assert.rejects(connection.verifyUnchangedAndClosed());
    await prisma.auditLog.update({
      where: { id: held.id },
      data: { metadata: held.metadata },
    });
  } finally {
    await rm(journalRoot, { recursive: true, force: true });
  }
  assert.equal(calls, before);
  correction.clear();
  return {
    checks: [
      "two sessions cannot read or clear each other's correction",
      "committed closure refuses proof despite purge rollback",
      "server sweep clears cache without browser keepalive",
      "new cleanup instance retries failed deletion",
      "only abandoned matching draft payload removed; unrelated/foreign/submitted preserved",
      "restart cannot redispatch an observed address operation",
      "restored expired snapshot refuses and is purged",
      "seven-day-or-earlier abandoned draft sweep and concurrent audit once",
      "legacy records untouched and malformed lifecycle refused",
      "ninety-day resolved alias purge retains younger and uncertain references",
      "reference purge audit failure rolls back; foreign tenant sweep removes nothing",
      "accounting rows, request counts and holds unchanged",
      "real connector and one-use runner: exact identity/runtime gates, closure/purge, preservation fingerprints and hold tamper refusal",
      "exact three-session maintenance: close/purge audit rollback, concurrent idempotency, submitted and linked business retention, draft version/session scope and unchanged liabilities",
    ],
    mockCalls: calls,
    liveProviderCalls: 0,
    productionRegistered: false,
  };
}
