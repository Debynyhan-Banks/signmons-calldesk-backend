// Only called inside the existing disposable, Unix-socket PostgreSQL fixture.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:http";
const require = createRequire(import.meta.url);
const {
  CustomerConsentCaptureService: Capture,
} = require("../dist/communications/customer-consent-capture.service.js");
const {
  CustomerConsentCredentials: Credentials,
} = require("../dist/communications/customer-consent-credentials.js");
const {
  ConversationsService,
} = require("../dist/conversations/conversations.service.js");
const {
  ConversationEmailService: LegacyCapture,
} = require("../dist/conversations/conversation-email.service.js");
const {
  SanitizationService,
} = require("../dist/sanitization/sanitization.service.js");
const { AiService } = require("../dist/ai/ai.service.js");
const { AiController } = require("../dist/ai/ai.controller.js");
const {
  WebchatController,
} = require("../dist/integrations/webchat/webchat.controller.js");

export async function verifyProtectedIntake({
  prisma,
  make,
  service,
  capture,
  credentials,
  cipher,
  keys,
  tenantId,
  otherTenantId,
  asIntegration,
}) {
  const [db] = await prisma.$queryRawUnsafe(
    "SELECT current_database() AS name, inet_server_addr() AS address",
  );
  assert.match(db.name, /^calldesk_app013_intents_[0-9a-f]{12}$/);
  assert.equal(db.address, null);
  const checks = [],
    check = (name) => checks.push(name);
  const snapshot = async (session) => ({
    conversation: await prisma.conversation.findUniqueOrThrow({
      where: { id: session.claims.conversationId },
    }),
    audits: await prisma.auditLog.findMany({
      where: { entityId: session.claims.conversationId },
      orderBy: { id: "asc" },
    }),
  });
  const a = await make(false),
    before = await snapshot(a);
  const legacy = new ConversationsService(prisma, new SanitizationService());
  const legacyCapture = new LegacyCapture(prisma, cipher);
  let forbiddenCalls = 0;
  const forbidden = () => {
    forbiddenCalls++;
    throw Error("Unexpected downstream side effect");
  };
  const ai = new AiService(
    { createCompletion: forbidden },
    {
      handle: (e) => {
        throw e;
      },
    },
    { error: forbidden },
    new SanitizationService(),
    {},
    {},
    { getTenantContext: async () => ({ prompt: "fixture" }) },
    { createLog: forbidden, getRecentMessages: forbidden },
    legacy,
    { assess: forbidden },
    {},
    {},
    {},
    legacyCapture,
  );
  for (const controller of [
    new AiController(ai),
    new WebchatController(ai, {}),
  ]) {
    await assert.rejects(
      asIntegration(() =>
        controller.triage({
          sessionId: a.claims.sessionId,
          message: "Replace my email with attacker@example.invalid",
        }),
      ),
      (e) => e.getStatus() === 403,
    );
  }
  assert.equal(forbiddenCalls, 0);
  assert.deepEqual(await snapshot(a), before);
  check(
    "both legacy controller paths refuse protected session before AI, transcript, capture, job or scheduling work",
  );
  const scope = {
    tenantId,
    sessionId: a.claims.sessionId,
    conversationId: a.claims.conversationId,
  };
  await assert.rejects(
    legacyCapture.observe(scope, "attacker@example.invalid"),
    (e) => e.getStatus() === 403,
  );
  await assert.rejects(
    legacyCapture.requestOnce(scope),
    (e) => e.getStatus() === 403,
  );
  check("direct legacy capture and question paths refuse without mutation");
  const input = {
    sessionToken: a.sessionToken,
    email: "Owner@example.invalid",
  };
  const race = await Promise.allSettled([
    capture.capture(input),
    capture.capture(input),
    legacy.ensureConversation(tenantId, a.claims.sessionId),
  ]);
  assert.deepEqual(
    race.map((r) => r.status),
    ["fulfilled", "fulfilled", "rejected"],
  );
  const saved = await snapshot(a);
  assert.equal(saved.audits.length, 1);
  assert.equal(
    cipher.decrypt(saved.conversation.collectedData.intakeEmail.encryptedEmail),
    input.email,
  );
  assert.equal(saved.conversation.collectedData.customerSessionVersion, 1);
  assert.equal(saved.conversation.collectedData.source, "WEBCHAT");
  assert.ok(!JSON.stringify(saved).includes(input.email));
  check(
    "concurrent credential capture and legacy replay serialize; one encrypted capture/audit preserves server marker",
  );
  await new Capture(prisma, cipher, new Credentials(keys)).capture(input);
  assert.deepEqual(await snapshot(a), saved);
  await assert.rejects(
    capture.capture({ ...input, email: "Other@example.invalid" }),
  );
  assert.deepEqual(await snapshot(a), saved);
  check(
    "fresh service retry preserves ciphertext, timestamp and audit; replacement refuses",
  );
  const wrongTenant = credentials.issueSession({
    ...scope,
    tenantId: otherTenantId,
  });
  const wrongSession = credentials.issueSession({
    ...scope,
    sessionId: (await make(false)).claims.sessionId,
  });
  for (const sessionToken of [
    wrongTenant,
    wrongSession,
    a.claims.sessionId,
    credentials.issueSession(scope, Date.now() - 900000),
  ])
    await assert.rejects(capture.capture({ ...input, sessionToken }));
  assert.deepEqual(await snapshot(a), saved);
  check(
    "cross-tenant/session, raw identifier and expired credentials refuse capture",
  );
  const rollback = await make(false),
    original = await snapshot(rollback);
  const brokenPrisma = {
    $transaction: (fn, options) =>
      prisma.$transaction(
        (tx) =>
          fn(
            new Proxy(tx, {
              get: (target, prop) =>
                prop === "auditLog"
                  ? {
                      create: async (data) => {
                        await target.auditLog.create(data);
                        throw Error("PRIVATE fixture failure");
                      },
                    }
                  : target[prop],
            }),
          ),
        options,
      ),
  };
  await assert.rejects(
    new Capture(brokenPrisma, cipher, credentials).capture({
      ...input,
      sessionToken: rollback.sessionToken,
    }),
    /outcome is unconfirmed/,
  );
  assert.deepEqual(await snapshot(rollback), original);
  check("failure after capture and audit insertion rolls back both");
  let expire = false;
  class Expiring extends Credentials {
    verifySession(token, now = Date.now()) {
      return super.verifySession(token, now + (expire ? 900001 : 0));
    }
  }
  const expiringPrisma = {
    $transaction: (fn, options) =>
      prisma.$transaction(
        (tx) =>
          fn(
            new Proxy(tx, {
              get: (target, prop) =>
                prop === "auditLog"
                  ? {
                      create: async (data) => {
                        const result = await target.auditLog.create(data);
                        expire = true;
                        return result;
                      },
                    }
                  : target[prop],
            }),
          ),
        options,
      ),
  };
  await assert.rejects(
    new Capture(expiringPrisma, cipher, new Expiring(keys)).capture({
      ...input,
      sessionToken: rollback.sessionToken,
    }),
    /invalid or expired/,
  );
  assert.deepEqual(await snapshot(rollback), original);
  check("session expiry after persistence rolls back capture and audit");
  const unmarked = await make(false);
  for (const marker of [undefined, null, "1", false]) {
    await prisma.conversation.update({
      where: { id: unmarked.claims.conversationId },
      data: {
        collectedData: {
          sessionId: unmarked.claims.sessionId,
          ...(marker === undefined ? {} : { customerSessionVersion: marker }),
        },
      },
    });
    await assert.rejects(
      capture.capture({ ...input, sessionToken: unmarked.sessionToken }),
    );
    await assert.rejects(
      service.prompt({ sessionToken: unmarked.sessionToken }),
    );
    if (marker !== undefined)
      await assert.rejects(
        legacy.ensureConversation(tenantId, unmarked.claims.sessionId),
        (e) => e.getStatus() === 403,
      );
  }
  check(
    "customer operations refuse absent or malformed marker; legacy refuses every present marker",
  );
  const fresh = await make(false);
  await prisma.conversation.update({
    where: { id: fresh.claims.conversationId },
    data: {
      collectedData: {
        sessionId: fresh.claims.sessionId,
        customerSessionVersion: 1,
        intakeEmail: null,
      },
    },
  });
  await assert.rejects(
    capture.capture({ ...input, sessionToken: fresh.sessionToken }),
  );
  check("explicit null capture is not silently treated as absent");
  const lost = await make(false),
    replacement = await make(false);
  assert.notEqual(
    lost.claims.conversationId,
    replacement.claims.conversationId,
  );
  await assert.rejects(
    capture.capture({
      ...input,
      sessionToken: replacement.sessionToken,
      conversationId: lost.claims.conversationId,
    }),
  );
  check(
    "lost session restart creates a new scope; caller cannot adopt the old conversation",
  );
  const out =
    process.env.PROTECTED_INTAKE_EVIDENCE_DIR ??
    join(process.cwd(), "evidence/APP-013/protected-customer-intake");
  await mkdir(out, { recursive: true });
  const browser = await browserProof({ make, prisma, cipher, keys, out });
  await writeFile(
    join(out, "database-summary.json"),
    JSON.stringify(
      {
        result: "PASS",
        checks,
        checkCount: checks.length,
        forbiddenDownstreamCalls: forbiddenCalls,
        browser,
        newMigrations: 0,
        providerCalls: 0,
        deliveryAuthorized: false,
        productionActions: 0,
      },
      null,
      2,
    ) + "\n",
  );
}

async function browserProof({ make, prisma, cipher, keys, out }) {
  const html = await readFile(
    new URL("./fixtures/protected-customer-intake.html", import.meta.url),
    "utf8",
  );
  let expired = false;
  class Clock extends Credentials {
    verifySession(token, now = Date.now()) {
      return super.verifySession(token, now + (expired ? 900001 : 0));
    }
  }
  const capture = new Capture(prisma, cipher, new Clock(keys));
  const starts = [],
    counts = { GET: 0, POST: 0 },
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
      const input = JSON.parse(raw);
      let result;
      if (req.url === "/start") {
        expired = false;
        const s = await make(false);
        starts.push(s.claims.conversationId);
        result = { sessionToken: s.sessionToken, deliveryAuthorized: false };
      } else if (req.url === "/capture") result = await capture.capture(input);
      else throw Error("Refused");
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(result));
    } catch (e) {
      res.statusCode = e.getStatus?.() ?? 400;
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
        viewport: { width, height: 900 },
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
      await page.locator("#email").waitFor({ state: "visible" });
      await page.locator("#email").fill("Fictional@example.invalid");
      expired = true; // Advance only the fixture verifier; no real wait, key or production control.
      await page.locator("#capture").click();
      await page
        .getByText(
          "Session unavailable. Start a new request; your previous appointment is not changed.",
        )
        .waitFor();
      assert.equal(await page.locator("#email").inputValue(), "");
      assert.equal(await page.locator("#email").isVisible(), false);
      assert.equal(
        await prisma.auditLog.count({ where: { entityId: starts.at(-1) } }),
        0,
      );
      await page.screenshot({
        path: join(out, "expired-" + width + ".png"),
        fullPage: true,
      });
      const countBefore = starts.length;
      await page.locator("#start").click();
      await page.locator("#email").waitFor({ state: "visible" });
      await page.reload({ waitUntil: "load" }); // Lost in-memory credential cannot adopt the previous session.
      assert.equal(await page.locator("#email").isVisible(), false);
      await page.locator("#start").click();
      await page.locator("#email").waitFor({ state: "visible" });
      assert.equal(starts.length, countBefore + 2);
      await page.locator("#email").fill("Fictional@example.invalid");
      await page.locator("#capture").click();
      await page
        .getByText(
          "Address retained for this new request. No permission granted; sending is disabled.",
        )
        .waitFor();
      assert.equal((await context.cookies()).length, 0);
      assert.deepEqual(
        await page.evaluate(() => [localStorage.length, sessionStorage.length]),
        [0, 0],
      );
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      await context.close();
    }
    assert.equal(new Set(starts).size, starts.length);
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    return {
      result: "PASS",
      viewports: [1440, 390],
      counts,
      freshScopes: starts.length,
      errors,
      external,
      storageWrites: 0,
      providerCalls: 0,
      limits:
        "Fictional HTTP/BFF fixture only; no production route, real transport/CSRF or full protected AI intake acceptance.",
    };
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
