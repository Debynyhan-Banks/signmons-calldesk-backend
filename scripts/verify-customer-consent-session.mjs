// Parent-owned disposable database only. No live credential/key/provider configuration.
import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:http";
const require = createRequire(import.meta.url);
const {
  CustomerConsentCredentials: Credentials,
  CONSENT_PROMPT,
} = require("../dist/communications/customer-consent-credentials.js");
const {
  CustomerConsentResponseService: Responses,
} = require("../dist/communications/customer-consent-response.service.js");
const {
  AppointmentEmailConsentEvidenceStore: Evidence,
} = require("../dist/communications/appointment-email-consent-evidence.js");
const {
  ConversationMemoryCipher: Cipher,
} = require("../dist/logging/conversation-memory-cipher.service.js");
const {
  ConversationEmailService: Capture,
} = require("../dist/conversations/conversation-email.service.js");
const {
  WebchatIntegrationGuard: Guard,
} = require("../dist/integrations/webchat/webchat-integration.guard.js");
const {
  requestContextMiddleware,
} = require("../dist/common/context/request-context.js");
export async function verifyCustomerConsentSession({
  prisma,
  jobData,
  otherTenantId,
}) {
  const [db] = await prisma.$queryRawUnsafe(
    "SELECT current_database() AS name, inet_server_addr() AS address",
  );
  assert.match(db.name, /^calldesk_app013_intents_[0-9a-f]{12}$/);
  assert.equal(db.address, null);
  const tenantId = jobData.tenantId,
    checks = [],
    created = [];
  const check = (name) => checks.push(name);
  const keys = {
    activeKeyId: "local-fixture",
    keys: { "local-fixture": Buffer.alloc(32, 5) },
  };
  const credentials = new Credentials(keys),
    cipher = new Cipher({ conversationDataEncryptionKey: "4".repeat(64) });
  const fingerprint = {
    fingerprint: (tenant, email) => ({
      digest: createHmac("sha256", Buffer.alloc(32, 6))
        .update(JSON.stringify(["fixture-mailbox-v1", tenant, email]))
        .digest("hex"),
      keyVersion: "fixture-only",
    }),
  };
  const evidence = new Evidence(cipher, fingerprint),
    service = new Responses(prisma, cipher, credentials, evidence),
    capture = new Capture(prisma, cipher);
  const integrationSecret = "LOCAL-FICTIONAL-INTEGRATION-CREDENTIAL-ONLY";
  const guard = new Guard({
    webchatIntegrations: [
      {
        name: "local-consent",
        tenantId,
        keyHash: createHash("sha256").update(integrationSecret).digest("hex"),
      },
    ],
  });
  const asIntegration = (fn, secret = integrationSecret) =>
    new Promise((resolve, reject) => {
      requestContextMiddleware({ headers: {} }, {}, () => {
        try {
          guard.canActivate({
            switchToHttp: () => ({
              getRequest: () => ({ header: () => "Bearer " + secret }),
            }),
          });
          Promise.resolve().then(fn).then(resolve, reject);
        } catch (e) {
          reject(e);
        }
      });
    });
  const make = async () => {
    const result = await asIntegration(() => service.start()),
      claims = credentials.verifySession(result.sessionToken);
    created.push(claims);
    await capture.observe(
      {
        tenantId,
        conversationId: claims.conversationId,
        sessionId: claims.sessionId,
      },
      "Session+Case@example.invalid",
    );
    return { ...result, claims };
  };
  const count = () =>
    prisma.appointmentEmailConsentEvidence.count({ where: { tenantId } });
  const originalEvents = await prisma.appointmentEmailIntent.findMany({
    orderBy: { id: "asc" },
  });
  const originalCount = await count();
  await assert.rejects(asIntegration(() => service.start(), "invalid"));
  await assert.rejects(service.start());
  assert.equal(await count(), originalCount);
  check("verified integration required only for fresh-session bootstrap");
  const a = await make(),
    b = await make();
  assert.notEqual(a.claims.sessionId, b.claims.sessionId);
  assert.notEqual(a.claims.conversationId, b.claims.conversationId);
  check(
    "server-generated new sessions cannot adopt existing intake identifiers",
  );
  for (const sessionToken of [
    integrationSecret,
    "caller-session",
    a.claims.sessionId,
  ]) {
    await assert.rejects(service.prompt({ sessionToken }));
  }
  check(
    "integration secret or session ID cannot authenticate a customer response",
  );
  const prompt = await service.prompt({ sessionToken: a.sessionToken });
  assert.equal(prompt.prompt, CONSENT_PROMPT);
  assert.equal(prompt.mailbox, "Session+Case@example.invalid");
  assert.equal(prompt.deliveryAuthorized, false);
  const payload = credentials.verifyPrompt(prompt.promptToken, a.sessionToken);
  assert.ok(!JSON.stringify(payload).includes("@"));
  check(
    "prompt binds exact text and ciphertext snapshot without mailbox in token",
  );
  await assert.rejects(
    service.respond({
      sessionToken: b.sessionToken,
      promptToken: prompt.promptToken,
      response: "GRANTED",
      mailboxConfirmed: true,
    }),
  );
  await assert.rejects(
    service.respond({
      sessionToken: a.sessionToken,
      promptToken: prompt.promptToken,
      response: "yes",
      mailboxConfirmed: false,
    }),
  );
  await assert.rejects(
    service.respond({
      sessionToken: a.sessionToken,
      promptToken: prompt.promptToken,
      response: "GRANTED",
      mailboxConfirmed: true,
      tenantId: otherTenantId,
    }),
  );
  assert.equal(await count(), originalCount);
  check(
    "cross-session, inferred response and caller authority overrides refused",
  );
  const answer = {
    sessionToken: a.sessionToken,
    promptToken: prompt.promptToken,
    response: "GRANTED",
    mailboxConfirmed: true,
  };
  await assert.rejects(service.respond({ ...answer, mailboxConfirmed: false }));
  await assert.rejects(
    service.respond({ ...answer, mailboxConfirmed: "true" }),
  );
  check("grant requires separate boolean mailbox confirmation");
  const [first, retry] = await Promise.all([
    service.respond(answer),
    service.respond(answer),
  ]);
  assert.equal(first.id, retry.id);
  assert.equal(first.deliveryAuthorized, false);
  assert.equal(await count(), originalCount + 1);
  assert.deepEqual(await service.respond(answer), first);
  const restarted = new Responses(
    prisma,
    cipher,
    new Credentials(keys),
    new Evidence(cipher, fingerprint),
  );
  assert.deepEqual(await restarted.respond(answer), first);
  await assert.rejects(service.respond({ ...answer, response: "DECLINED" }));
  check(
    "concurrent identical response creates one receipt; conflicting replay refuses",
  );
  assert.equal(
    (await service.prompt({ sessionToken: a.sessionToken })).state,
    "completed",
  );
  check("completed question is not repeated");
  const newPrompt = await service.prompt({ sessionToken: b.sessionToken });
  const competing = await service.prompt({ sessionToken: b.sessionToken });
  const winner = await service.respond({
    sessionToken: b.sessionToken,
    promptToken: newPrompt.promptToken,
    response: "DECLINED",
    mailboxConfirmed: false,
  });
  assert.equal(winner.deliveryAuthorized, false);
  await assert.rejects(
    service.respond({
      sessionToken: b.sessionToken,
      promptToken: competing.promptToken,
      response: "GRANTED",
      mailboxConfirmed: true,
    }),
  );
  check("decline completes once; another issued prompt cannot regrant");
  const stale = await make(),
    stalePrompt = await service.prompt({ sessionToken: stale.sessionToken });
  await prisma.conversation.update({
    where: { id: stale.claims.conversationId },
    data: {
      collectedData: {
        sessionId: stale.claims.sessionId,
        intakeEmail: {
          version: 1,
          status: "captured",
          askedAt: null,
          encryptedEmail: cipher.encrypt("Changed@example.invalid"),
        },
      },
    },
  });
  await assert.rejects(
    service.respond({
      sessionToken: stale.sessionToken,
      promptToken: stalePrompt.promptToken,
      response: "GRANTED",
      mailboxConfirmed: true,
    }),
  );
  check("mailbox replacement after display invalidates the response token");
  const rollback = await make(),
    rollbackPrompt = await service.prompt({
      sessionToken: rollback.sessionToken,
    });
  const beforeAudit = await prisma.auditLog.count({ where: { tenantId } });
  const broken = new Responses(prisma, cipher, credentials, {
    record: async (tx, input) => {
      await evidence.record(tx, input);
      throw Error("PRIVATE_FAILURE_TOKEN");
    },
  });
  await assert.rejects(
    broken.respond({
      sessionToken: rollback.sessionToken,
      promptToken: rollbackPrompt.promptToken,
      response: "GRANTED",
      mailboxConfirmed: true,
    }),
    /outcome is unconfirmed/,
  );
  assert.equal(
    await prisma.auditLog.count({ where: { tenantId } }),
    beforeAudit,
  );
  assert.equal(
    await prisma.appointmentEmailConsentScope.count({
      where: { conversationId: rollback.claims.conversationId },
    }),
    0,
  );
  check("post-insert failure rolls back receipt, evidence and new scope");
  let advanceClock = false;
  class ExpiringCredentials extends Credentials {
    verifyPrompt(promptToken, sessionToken) {
      return super.verifyPrompt(
        promptToken,
        sessionToken,
        Date.now() + (advanceClock ? 301000 : 0),
      );
    }
  }
  const expiring = new Responses(
    prisma,
    cipher,
    new ExpiringCredentials(keys),
    {
      record: async (tx, input) => {
        const result = await evidence.record(tx, input);
        advanceClock = true;
        return result;
      },
    },
  );
  await assert.rejects(
    expiring.respond({
      sessionToken: rollback.sessionToken,
      promptToken: rollbackPrompt.promptToken,
      response: "GRANTED",
      mailboxConfirmed: true,
    }),
    /invalid or expired/,
  );
  assert.equal(
    await prisma.auditLog.count({ where: { tenantId } }),
    beforeAudit,
  );
  assert.equal(
    await prisma.appointmentEmailConsentScope.count({
      where: { conversationId: rollback.claims.conversationId },
    }),
    0,
  );
  check("expiry while persistence is awaited rolls back all consent writes");
  const expired = await make(),
    expiredClaims = credentials.verifySession(expired.sessionToken);
  const pastSession = credentials.issueSession(
    {
      tenantId,
      conversationId: expiredClaims.conversationId,
      sessionId: expiredClaims.sessionId,
    },
    Date.now() - 900000,
  );
  await assert.rejects(service.prompt({ sessionToken: pastSession }));
  const pastPrompt = credentials.issuePrompt(
    expired.sessionToken,
    "a".repeat(64),
    0,
    Date.now(),
  );
  const removed = new Responses(
    prisma,
    cipher,
    new Credentials({
      activeKeyId: "replacement",
      keys: { replacement: Buffer.alloc(32, 9) },
    }),
    evidence,
  );
  await assert.rejects(
    removed.respond({
      sessionToken: expired.sessionToken,
      promptToken: pastPrompt,
      response: "GRANTED",
      mailboxConfirmed: true,
    }),
  );
  check("expired session and retired signing key refuse");
  await prisma.conversation.update({
    where: { id: expiredClaims.conversationId },
    data: { deletedAt: new Date() },
  });
  await assert.rejects(service.prompt({ sessionToken: expired.sessionToken }));
  check("deleted session cannot display private mailbox");
  const job = await prisma.job.create({
    data: {
      ...jobData,
      status: "CREATED",
      intakeSessionId: a.claims.sessionId,
      serviceWindowStart: null,
      serviceWindowEnd: null,
      calendarEventId: null,
    },
  });
  await prisma.conversationJobLink.create({
    data: {
      tenantId,
      conversationId: a.claims.conversationId,
      conversationTenantId: tenantId,
      jobId: job.id,
      jobTenantId: tenantId,
      relationType: "CREATED_FROM",
    },
  });
  const bound = await prisma.$transaction((tx) =>
    evidence.bindJob(tx, {
      tenantId,
      conversationId: a.claims.conversationId,
      jobId: job.id,
    }),
  );
  assert.equal(bound.deliveryAuthorized, false);
  check(
    "verified response evidence retains one-time job binding without sending",
  );
  // A new prompt issued under a different tenant cannot be combined with this session.
  const foreign = credentials.issueSession({
    tenantId: otherTenantId,
    conversationId: a.claims.conversationId,
    sessionId: a.claims.sessionId,
  });
  await assert.rejects(service.prompt({ sessionToken: foreign }));
  check("signed but cross-tenant conversation binding refuses");
  assert.deepEqual(
    await prisma.appointmentEmailIntent.findMany({ orderBy: { id: "asc" } }),
    originalEvents,
  );
  check("existing finalized events remain unchanged and unbound");
  const audits = await prisma.auditLog.findMany({
    where: {
      action: "conversation.appointment_email_permission",
      entityId: { in: created.map((c) => c.conversationId) },
    },
  });
  for (const audit of audits)
    assert.ok(
      !JSON.stringify(audit).includes("Session+Case@") &&
        !JSON.stringify(audit).includes(a.sessionToken),
    );
  check("ordinary audit contains no mailbox or bearer credential");
  const out =
    process.env.CUSTOMER_CONSENT_EVIDENCE_DIR ??
    join(process.cwd(), "evidence/APP-013/customer-consent-session");
  await mkdir(out, { recursive: true });
  const browser = await browserProof({ make, service, out });
  await writeFile(
    join(out, "database-summary.json"),
    JSON.stringify(
      {
        result: "PASS",
        checks,
        checkCount: checks.length,
        providerCalls: 0,
        productionActions: 0,
        newMigrations: 0,
        deliveryAuthorized: false,
        fictionalKeysOnly: true,
        browser,
      },
      null,
      2,
    ) + "\n",
  );
  await prisma.appointmentEmailConsentScope.deleteMany({
    where: {
      tenantId,
      conversationId: { in: created.map((c) => c.conversationId) },
    },
  });
  return checks.map((c) => "customer consent session: " + c);
}

async function browserProof({ make, service, out }) {
  const html =
    '<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local consent model</title><style>body{font:18px system-ui;max-width:32rem;margin:24px;padding:12px}button{font:inherit;padding:12px;margin:8px 8px 8px 0}p{overflow-wrap:anywhere}</style><h1>Appointment email permission</h1><p>Local test only. Sending is disabled.</p><button id="start">Begin local session</button><p id="mailbox"></p><p id="prompt"></p><label id="confirm-label" hidden><input type="checkbox" id="confirmed"> I confirm this is my email address.</label><button id="yes" hidden>Allow appointment emails</button><button id="no" hidden>No thanks</button><p id="status" role="status"></p><script>let sessionToken,promptToken;const call=async(path,body)=>{const r=await fetch(path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});if(!r.ok)throw Error("Request refused");return r.json()};document.querySelector("#start").onclick=async()=>{const s=await call("/start",{});sessionToken=s.sessionToken;const p=await call("/prompt",{sessionToken});promptToken=p.promptToken;document.querySelector("#mailbox").textContent=p.mailbox;document.querySelector("#prompt").textContent=p.prompt;document.querySelector("#yes").hidden=false;document.querySelector("#confirm-label").hidden=false;document.querySelector("#yes").disabled=true;document.querySelector("#confirmed").onchange=()=>{document.querySelector("#yes").disabled=!document.querySelector("#confirmed").checked};document.querySelector("#no").hidden=false;document.querySelector("#start").hidden=true};const submit=async response=>{await call("/respond",{sessionToken,promptToken,response,mailboxConfirmed:document.querySelector("#confirmed").checked});document.querySelector("#status").textContent="Choice recorded. Sending remains disabled.";document.querySelector("#yes").hidden=true;document.querySelector("#no").hidden=true;sessionToken=undefined;promptToken=undefined};document.querySelector("#yes").onclick=()=>submit("GRANTED");document.querySelector("#no").onclick=()=>submit("DECLINED");</script></html>';
  const counts = { GET: 0, POST: 0 },
    errors = [],
    external = [];
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    try {
      if (req.method === "GET" && req.url === "/") {
        counts.GET++;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(html);
        return;
      }
      if (req.method !== "POST") throw Error("Refused");
      counts.POST++;
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 16384) throw Error("Too large");
      }
      const input = JSON.parse(raw),
        result =
          req.url === "/start"
            ? await make()
            : req.url === "/prompt"
              ? await service.prompt(input)
              : req.url === "/respond"
                ? await service.respond(input)
                : null;
      if (!result) throw Error("Refused");
      res.setHeader("Content-Type", "application/json");
      // Never return fixture-only decoded claims.
      const { claims, ...publicResult } = result;
      void claims;
      res.end(JSON.stringify(publicResult));
    } catch {
      res.statusCode = 400;
      res.end('{"error":"Request refused"}');
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;
  const { chromium } = await import(
    process.env.PLAYWRIGHT_MODULE ?? "playwright"
  );
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    for (const width of [1440, 390]) {
      const context = await browser.newContext({
        viewport: { width, height: 1000 },
      });
      await context.route("**/*", (route) =>
        new URL(route.request().url()).origin !== origin
          ? (external.push("blocked"), route.abort())
          : route.continue(),
      );
      const page = await context.newPage();
      page.on("pageerror", () => errors.push("page error"));
      await page.goto(origin, { waitUntil: "load" });
      await page.locator("#start").click();
      await page.locator("#yes").waitFor({ state: "visible" });
      assert.equal(await page.locator("#prompt").innerText(), CONSENT_PROMPT);
      assert.equal(
        await page.locator("#mailbox").innerText(),
        "Session+Case@example.invalid",
      );
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      await page.screenshot({
        path: join(out, "prompt-" + width + ".png"),
        fullPage: true,
      });
      if (width === 1440) await page.locator("#confirmed").check();
      await page.locator(width === 390 ? "#no" : "#yes").click();
      await page
        .getByText("Choice recorded. Sending remains disabled.")
        .waitFor();
      assert.equal((await context.cookies()).length, 0);
      assert.deepEqual(
        await page.evaluate(() => ({
          local: localStorage.length,
          session: sessionStorage.length,
        })),
        { local: 0, session: 0 },
      );
      await context.close();
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    return {
      result: "PASS",
      counts,
      viewports: [1440, 390],
      errors,
      external,
      providerCalls: 0,
      storageWrites: 0,
      limits:
        "Fictional localhost UI and bootstrap; not a production route, cookie/CSRF acceptance or mailbox verification.",
    };
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
