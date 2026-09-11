// Disposable parent database only; no provider calls, production data or settlement.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
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
    ],
    mockCalls: calls,
    liveProviderCalls: 0,
    productionRegistered: false,
  };
}
