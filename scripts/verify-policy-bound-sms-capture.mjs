import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
const require = createRequire(import.meta.url);
const {
  PolicyBoundSmsCapture,
} = require("../dist/communications/policy-bound-sms-capture.js");
const {
  TenantSmsPolicyRegistry,
} = require("../dist/communications/tenant-sms-policy-registry.js");
const {
  CustomerConsentCredentials,
} = require("../dist/communications/customer-consent-credentials.js");
const {
  ConversationMemoryCipher,
} = require("../dist/logging/conversation-memory-cipher.service.js");
const {
  SmsConsentService,
} = require("../dist/communications/sms-consent.service.js");
const {
  SmsDeliveryService,
} = require("../dist/communications/sms-delivery.service.js");
const {
  requestContextMiddleware,
  setAuthContext,
} = require("../dist/common/context/request-context.js");

export async function verifyPolicyBoundSmsCapture({ prisma, out }) {
  const [db] = await prisma.$queryRawUnsafe(
    "SELECT current_database() AS name, inet_server_addr() AS address",
  );
  assert.match(db.name, /^calldesk_sms_fixture_[0-9a-f]{12}$/);
  assert.equal(db.address, null);
  const tenant = await prisma.tenantOrganization.create({
    data: { name: "Policy Capture Fictional Heating", timezone: "UTC" },
  });
  const other = await prisma.tenantOrganization.create({
    data: { name: "Other Policy Capture Fixture", timezone: "UTC" },
  });
  const actor = (fn, tenantId = tenant.id, role = "owner") =>
    new Promise((resolve, reject) =>
      requestContextMiddleware({ headers: {} }, {}, () => {
        setAuthContext({ tenantId, userId: "fixture-actor", role });
        Promise.resolve().then(fn).then(resolve, reject);
      }),
    );
  const urls = [
    "https://policy.example.invalid/privacy",
    "https://policy.example.invalid/terms",
  ];
  const attestations = new Map();
  const registry = new TenantSmsPolicyRegistry(prisma, {
    allowedUrls: (id) => (id === tenant.id ? urls : []),
    publication: (ref) => attestations.get(ref),
  });
  let head;
  const publish = async (duration = 3600000) => {
    head = await actor(() =>
      registry.saveDraft({
        expectedRevision: head?.revision ?? 0,
        content: {
          legalSender: "Fictional Heating",
          purpose: "APPOINTMENT_UPDATES_V1",
          supportEmail: "support@example.invalid",
          disclosure:
            "Optional appointment texts. STOP to opt out. HELP for help.",
          disclosureVersion: "fixture-v1",
          privacyUrl: urls[0],
          privacyVersion: "v1",
          termsUrl: urls[1],
          termsVersion: "v1",
          effectiveAt: new Date(Date.now() - 60000).toISOString(),
          expiresAt: new Date(Date.now() + duration).toISOString(),
        },
      }),
    );
    const row = await prisma.tenantSmsPolicyVersion.findUnique({
      where: { id: head.versionId },
    });
    attestations.set(head.versionId, {
      tenantId: tenant.id,
      versionId: head.versionId,
      digest: row.digest,
      reference: head.versionId,
      fixtureOnly: true,
      expiresAt: Date.now() + 3600000,
    });
    for (const target of ["REVIEWED", "PUBLISHED_VERIFIED", "CAPTURE_ELIGIBLE"])
      head = await actor(() =>
        registry.transition({
          expectedRevision: head.revision,
          target,
          evidenceRef: head.versionId,
        }),
      );
  };
  await publish();
  const credentials = new CustomerConsentCredentials({
    activeKeyId: "fixture",
    keys: { fixture: Buffer.alloc(32, 5) },
  });
  const cipher = new ConversationMemoryCipher({
    conversationDataEncryptionKey: "5".repeat(64),
  });
  const hashing = {
    key: "fixture-only-shared-consent-key",
    version: "legacy-v1",
  };
  const model = (client = prisma, hash = hashing) =>
    new PolicyBoundSmsCapture(client, cipher, credentials, registry, hash);
  let phoneIndex = 1000;
  const seed = async () => {
    const phone = `+1216555${phoneIndex++}`;
    const scope = {
      tenantId: tenant.id,
      conversationId: randomUUID(),
      sessionId: randomUUID(),
    };
    const sessionToken = credentials.issueSession(scope);
    const claims = credentials.verifySession(sessionToken);
    const customer = await prisma.customer.create({
      data: { tenantId: tenant.id, phone, fullName: "Fictional Customer" },
    });
    const data = {
      sessionId: scope.sessionId,
      customerSessionVersion: 1,
      verificationLifecycle: {
        version: 1,
        expiresAt: claims.expiresAt,
        closedAt: null,
        purgedAt: null,
      },
    };
    await prisma.conversation.create({
      data: {
        id: scope.conversationId,
        tenantId: tenant.id,
        customerId: customer.id,
        customerTenantId: tenant.id,
        channel: "WEBCHAT",
        status: "ONGOING",
        currentFSMState: "INTAKE",
        collectedData: data,
      },
    });
    const input = {
      sessionToken,
      phone,
      action: "PROMPT",
      promptId: "",
      accepted: false,
    };
    return { scope, input, customer, data };
  };
  const prompt = (f) =>
    actor(() => model().handle(f.input), tenant.id, "webchat_integration");
  const captureInput = (f, p, accepted = true) => ({
    ...f.input,
    action: "CAPTURE",
    promptId: p.promptId,
    accepted,
  });
  const capture = (f, p, client = prisma) =>
    actor(
      () => model(client).handle(captureInput(f, p)),
      tenant.id,
      "webchat_integration",
    );
  const audits = () =>
    prisma.auditLog.count({
      where: { action: "sms.policy_capture_dry_run", tenantId: tenant.id },
    });
  const count = () =>
    prisma.smsPolicyCapture.count({
      where: { tenantId: tenant.id, recordedAt: { not: null } },
    });
  const keyword = (f, body, client = prisma) =>
    new SmsConsentService(client, {
      smsConsentHashKey: hashing.key,
    }).handleInboundKeyword({
      tenantId: tenant.id,
      phoneNumber: f.input.phone,
      body,
      displayName: "Fixture",
      supportPhone: "+12165550199",
    });
  const checks = [];
  const f = await seed(),
    p = await prompt(f);
  assert.equal(p.privacyUrl, urls[0]);
  assert.equal(p.termsUrl, urls[1]);
  assert.equal(p.policyVersion, head.versionId);
  assert.equal(p.deliveryAuthorized, false);
  assert.equal(p.liveCaptureEnabled, false);
  assert.equal(p.mode, "DRY_RUN");
  const stored = await prisma.smsPolicyCapture.findUnique({
    where: { id: p.promptId },
  });
  await assert.rejects(
    prisma.smsPolicyCapture.create({
      data: { ...stored, id: randomUUID(), mode: "LIVE" },
    }),
  );
  assert.equal(JSON.stringify(stored).includes(f.input.phone), false);
  assert.equal(JSON.stringify(stored).includes(f.input.sessionToken), false);
  assert.equal(stored.consentRevision, 0);
  const results = await Promise.all([capture(f, p), capture(f, p)]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(await audits(), 1);
  assert.equal(await count(), 1);
  assert.equal(results[0].liveConsentRecorded, false);
  await actor(() => model().handle(captureInput(f, p, false)));
  assert.equal(await count(), 1);
  assert.equal(
    await prisma.smsConsentRecord.count({ where: { tenantId: tenant.id } }),
    0,
  );
  checks.push(
    "registry public projection, encrypted tenant/session/policy/recipient provenance, concurrent exact receipt replay and skip without grant/revoke",
  );

  await assert.rejects(
    actor(() => model().handle(f.input), other.id),
    /access denied/,
  );
  await assert.rejects(
    actor(() => model().handle(f.input), tenant.id, "technician"),
    /access denied/,
  );
  await assert.rejects(
    actor(() => model().handle({ ...f.input, liveCaptureEnabled: true })),
    /Invalid/,
  );
  const rotated = credentials.issueSession(f.scope);
  await assert.rejects(
    actor(() =>
      model().handle({ ...captureInput(f, p), sessionToken: rotated }),
    ),
    /unavailable/,
  );
  await assert.rejects(
    actor(() =>
      model(prisma, { ...hashing, version: "new-key-version" }).handle(
        captureInput(f, p),
      ),
    ),
    /unavailable/,
  );
  const foreignConversation = await prisma.conversation.findFirst({
    where: { tenantId: { not: tenant.id } },
  });
  assert.ok(foreignConversation);
  await assert.rejects(
    prisma.smsPolicyCapture.create({
      data: {
        ...stored,
        id: randomUUID(),
        conversationId: foreignConversation.id,
      },
    }),
  );
  await assert.rejects(
    prisma.smsPolicyCapture.update({
      where: { id: p.promptId },
      data: { mode: "LIVE" },
    }),
  );
  await assert.rejects(
    prisma.smsPolicyCapture.update({
      where: { id: p.promptId },
      data: { encryptedSnapshot: "tampered" },
    }),
  );
  checks.push(
    "foreign tenant/role/token instance/key version and forged authority refused; database scope/live-mode/immutable evidence constraints",
  );

  const g = await seed(),
    gp = await prompt(g);
  const rollback = {
    $transaction: (fn) =>
      prisma.$transaction(async (tx) => {
        await fn(tx);
        throw Error("fixture rollback");
      }),
  };
  await assert.rejects(capture(g, gp, rollback), /unconfirmed/);
  assert.equal(
    (await prisma.smsPolicyCapture.findUnique({ where: { id: gp.promptId } }))
      .recordedAt,
    null,
  );
  assert.equal(await audits(), 1);
  const unknown = {
    $transaction: async (fn) => {
      await prisma.$transaction(fn);
      throw Error("fixture lost response");
    },
  };
  await assert.rejects(capture(g, gp, unknown), /unconfirmed/);
  const receipt = await capture(g, gp);
  assert.equal(receipt.state, "RECORDED");
  assert.equal(await audits(), 2);
  assert.deepEqual(await capture(g, gp), receipt);
  checks.push(
    "atomic post-write rollback and unknown-commit reconstruction return one original capture/audit",
  );

  const skipped = await seed(),
    skippedPrompt = await prompt(skipped);
  const skippedResult = await actor(() =>
    model().handle(captureInput(skipped, skippedPrompt, false)),
  );
  assert.equal(skippedResult.state, "NOT_RECORDED");
  assert.equal(
    (
      await prisma.smsPolicyCapture.findUnique({
        where: { id: skippedPrompt.promptId },
      })
    ).recordedAt,
    null,
  );
  assert.equal(await audits(), 2);
  const sourceAttestation = attestations.get(head.versionId);
  attestations.delete(head.versionId);
  await assert.rejects(prompt(skipped), /unavailable/);
  await assert.rejects(capture(skipped, skippedPrompt), /unavailable/);
  attestations.set(head.versionId, sourceAttestation);
  const capacity = {
    $transaction: (fn) =>
      prisma.$transaction((tx) =>
        fn(
          new Proxy(tx, {
            get(target, prop) {
              if (prop === "smsPolicyCapture")
                return { count: async () => 256 };
              const value = target[prop];
              return typeof value === "function" ? value.bind(target) : value;
            },
          }),
        ),
      ),
  };
  await assert.rejects(
    actor(() => model(capacity).handle(skipped.input)),
    /unconfirmed/,
  );
  checks.push(
    "uncaptured skip leaves no audit; missing consent authority refuses prompt/capture; session capacity refuses another prompt",
  );

  const h = await seed(),
    hp = await prompt(h);
  await keyword(h, "STOP");
  await assert.rejects(capture(h, hp), /unavailable/);
  await keyword(h, "START");
  await assert.rejects(capture(h, hp), /unavailable/);
  await keyword(h, "STOP");
  checks.push(
    "existing STOP suppresses pending capture; later START cannot revive its stale suppression revision",
  );

  const racing = await seed(),
    rp = await prompt(racing);
  let signal, release;
  const entered = new Promise((resolve) => {
    signal = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const pausedStop = {
    $transaction: (fn) =>
      prisma.$transaction((tx) =>
        fn(
          new Proxy(tx, {
            get(target, prop) {
              if (prop === "smsConsentRecord")
                return {
                  findUnique: target.smsConsentRecord.findUnique.bind(
                    target.smsConsentRecord,
                  ),
                  upsert: async (args) => {
                    signal();
                    await gate;
                    return target.smsConsentRecord.upsert(args);
                  },
                };
              const value = target[prop];
              return typeof value === "function" ? value.bind(target) : value;
            },
          }),
        ),
      ),
  };
  const stopping = keyword(racing, "STOP", pausedStop);
  await entered;
  const pending = assert.rejects(capture(racing, rp), /unavailable/);
  release();
  await Promise.all([stopping, pending]);
  checks.push(
    "STOP holding shared recipient lock defeats overlapping policy-bound capture without deadlock or grant",
  );

  const changed = await seed(),
    cp = await prompt(changed);
  await prisma.customer.update({
    where: { id: changed.customer.id },
    data: { phone: "+12165559999" },
  });
  await assert.rejects(capture(changed, cp), /unavailable/);
  await prisma.customer.update({
    where: { id: changed.customer.id },
    data: { phone: changed.input.phone },
  });
  await assert.rejects(capture(changed, cp), /unavailable/);
  const closed = await seed(),
    clp = await prompt(closed);
  await prisma.conversation.update({
    where: { id: closed.scope.conversationId },
    data: {
      collectedData: {
        ...closed.data,
        verificationLifecycle: {
          ...closed.data.verificationLifecycle,
          closedAt: Date.now(),
        },
      },
    },
  });
  await assert.rejects(capture(closed, clp), /closed or expired/);
  await publish();
  await assert.rejects(capture(f, p), /unavailable/);
  checks.push(
    "recipient change-back, closed session and policy replacement invalidate both pending capture and old receipt replay",
  );

  const revoked = await seed(),
    vp = await prompt(revoked);
  const previousAudits = await audits();
  const attestation = attestations.get(head.versionId);
  const revoking = {
    $transaction: (fn) =>
      prisma.$transaction((tx) =>
        fn(
          new Proxy(tx, {
            get(target, prop) {
              if (prop === "smsPolicyCapture")
                return {
                  findFirst: target.smsPolicyCapture.findFirst.bind(
                    target.smsPolicyCapture,
                  ),
                  update: async (args) => {
                    const result = await target.smsPolicyCapture.update(args);
                    attestations.delete(head.versionId);
                    return result;
                  },
                };
              const value = target[prop];
              return typeof value === "function" ? value.bind(target) : value;
            },
          }),
        ),
      ),
  };
  await assert.rejects(capture(revoked, vp, revoking), /unavailable/);
  assert.equal(await audits(), previousAudits);
  assert.equal(
    (await prisma.smsPolicyCapture.findUnique({ where: { id: vp.promptId } }))
      .recordedAt,
    null,
  );
  attestations.set(head.versionId, attestation);
  await publish(1200);
  const expiring = await seed(),
    ep = await prompt(expiring);
  const slow = {
    $transaction: (fn) =>
      prisma.$transaction((tx) =>
        fn(
          new Proxy(tx, {
            get(target, prop) {
              if (prop === "smsPolicyCapture")
                return {
                  findFirst: target.smsPolicyCapture.findFirst.bind(
                    target.smsPolicyCapture,
                  ),
                  update: async (args) => {
                    const result = await target.smsPolicyCapture.update(args);
                    await target.$queryRawUnsafe("SELECT 1 FROM pg_sleep(1.3)");
                    return result;
                  },
                };
              const value = target[prop];
              return typeof value === "function" ? value.bind(target) : value;
            },
          }),
        ),
      ),
  };
  await assert.rejects(capture(expiring, ep, slow), /unavailable/);
  assert.equal(await audits(), previousAudits);
  checks.push(
    "publication authority revoked during write and actual policy expiry roll back capture plus audit",
  );

  let providerCalls = 0;
  const config = {
    smsConsentHashKey: hashing.key,
    smsDeliveryEnabled: false,
    twilioWebhookEnvironment: "staging",
    twilioTenantIdentities: [
      {
        tenantId: tenant.id,
        enabled: true,
        environment: "staging",
        timeZone: "UTC",
        outboundQuietHoursStart: 0,
        outboundQuietHoursEnd: 0,
      },
    ],
  };
  const delivery = new SmsDeliveryService(
    prisma,
    new SmsConsentService(prisma, config),
    {
      encrypt() {
        throw Error("Must not queue");
      },
    },
    {
      async send() {
        providerCalls++;
        throw Error("Must not send");
      },
    },
    config,
  );
  await assert.rejects(
    delivery.create({
      tenantId: tenant.id,
      to: f.input.phone,
      body: "Fictional",
      idempotencyKey: "no-grant",
    }),
    /no_consent/,
  );
  assert.equal(await delivery.processDue(), 0);
  assert.equal(await prisma.communicationEvent.count(), 0);
  assert.equal(providerCalls, 0);
  assert.equal(
    await prisma.smsConsentRecord.count({
      where: { tenantId: tenant.id, status: "OPTED_IN" },
    }),
    0,
  );
  assert.equal(
    await prisma.customer.count({
      where: { tenantId: tenant.id, consentToText: true },
    }),
    0,
  );
  assert.equal(await count(), await audits());
  checks.push(
    "dry-run capture evidence cannot authorize existing delivery consumers; zero grants, queues and providers",
  );
  await mkdir(out, { recursive: true });
  await writeFile(
    out + "/summary.json",
    JSON.stringify(
      {
        mode: "DISPOSABLE_POSTGRES_DRY_RUN",
        checks,
        capturedEvidence: await count(),
        captureAudits: await audits(),
        providerCalls,
        deliveryEvents: 0,
        finalTenantOptedInRecords: 0,
        liveCaptureEnabled: false,
        productionWrites: 0,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    JSON.stringify({ policyCaptureChecks: checks.length, providerCalls }),
  );
}
