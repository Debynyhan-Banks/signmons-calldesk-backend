// Only called with the parent's disposable local PostgreSQL fixture.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
export async function verifyTechnicianNotifications({
  prisma,
  jobData,
  otherTenantId,
}) {
  const [db] = await prisma.$queryRawUnsafe(
    "SELECT current_database() AS name, inet_server_addr() AS address",
  );
  assert.match(db.name, /^calldesk_app013_intents_[0-9a-f]{12}$/);
  assert.equal(db.address, null);
  const {
      TechnicianNotificationsService,
    } = require("../dist/jobs/technician-notifications.service.js"),
    {
      TechnicianNotificationsController,
    } = require("../dist/jobs/technician-notifications.controller.js"),
    {
      TechnicianLinkService,
    } = require("../dist/jobs/technician-link.service.js"),
    { PrismaService } = require("../dist/prisma/prisma.service.js"),
    { LoggingService } = require("../dist/logging/logging.service.js");
  const config = {
    technicianLinkSecret: "local-inbox-fixture-only-no-production-secret",
    technicianLinkTtlHours: 1,
    technicianAppBaseUrl: "http://127.0.0.1/app/technician",
  };
  const links = new TechnicianLinkService(prisma, config),
    service = new TechnicianNotificationsService(prisma, links);
  const tech = await prisma.user.create({
    data: {
      tenantId: jobData.tenantId,
      email: `${randomUUID()}@example.invalid`,
      fullName: "Inbox Fixture Tech",
      role: "TECH",
    },
  });
  const foreign = await prisma.user.create({
    data: {
      tenantId: otherTenantId,
      email: `${randomUUID()}@example.invalid`,
      fullName: "Other Fixture Tech",
      role: "TECH",
    },
  });
  const tokenFor = async (tenantId, technicianId) =>
    decodeURIComponent(
      new URL(
        (
          await links.issue({
            tenantId,
            technicianId,
            actorId: "local-fixture",
          })
        ).url,
      ).hash.slice(1),
    );
  const token = await tokenFor(jobData.tenantId, tech.id),
    otherToken = await tokenFor(otherTenantId, foreign.id);
  const data = {
    ...jobData,
    assignedUserId: tech.id,
    assignedUserTenantId: jobData.tenantId,
  };
  const job = await prisma.job.create({ data }),
    removed = await prisma.job.create({
      data: { ...data, deletedAt: new Date() },
    }),
    otherJob = await prisma.job.create({ data: jobData }),
    unassigned = await prisma.job.create({
      data: { ...data, assignedUserId: null, assignedUserTenantId: null },
    });
  const stamp = new Date(Date.now() - 1000);
  const event = (
    entityId,
    action = "job.assigned",
    tenantId = jobData.tenantId,
    createdAt = stamp,
    entityType = "Job",
  ) => ({
    tenantId,
    entityId,
    entityType,
    action,
    actorId: "private-actor",
    actorType: "USER",
    createdAt,
    metadata: {
      phone: "private-phone",
      body: "private-body",
      secret: "private-secret",
    },
  });
  const visible = await prisma.auditLog.create({ data: event(job.id) });
  await prisma.auditLog.createMany({
    data: [
      event(removed.id),
      event(otherJob.id),
      event(unassigned.id),
      event(job.id, "payment.paid"),
      event(job.id, "job.assigned", otherTenantId),
      event(
        job.id,
        "job.assigned",
        jobData.tenantId,
        new Date(Date.now() - 91 * 86400000),
      ),
      event(
        job.id,
        "job.assigned",
        jobData.tenantId,
        new Date(Date.now() + 86400000),
      ),
      event("not-a-uuid"),
      event(job.id, "job.assigned", jobData.tenantId, stamp, "Payment"),
    ],
  });
  let app, web, browser, origin;
  let failRead = false;
  let delayed = false,
    releaseRead;
  let startedRead;
  const methods = { GET: 0, OPTIONS: 0 },
    forbidden = [],
    errors = [],
    external = [];
  const initial = await service.list(token);
  assert.deepEqual(
    initial.items.map((i) => i.id),
    [visible.id],
  );
  assert.deepEqual((await service.list(otherToken)).items, []);
  for (const bad of [undefined, "tampered", token + "x"])
    await assert.rejects(() => service.list(bad));
  await prisma.user.update({
    where: { id: tech.id },
    data: { status: "DISABLED" },
  });
  await assert.rejects(() => service.list(token));
  await prisma.user.update({
    where: { id: tech.id },
    data: { status: "ACTIVE", role: "DISPATCHER" },
  });
  await assert.rejects(() => service.list(token));
  await prisma.user.update({ where: { id: tech.id }, data: { role: "TECH" } });
  await prisma.job.update({
    where: { id: job.id },
    data: { assignedUserId: jobData.assignedUserId },
  });
  assert.deepEqual((await service.list(token)).items, []);
  await prisma.job.update({
    where: { id: job.id },
    data: { assignedUserId: tech.id },
  });
  const extras = Array.from({ length: 101 }, () => ({
    ...event(job.id, "job.technician_started"),
    id: randomUUID(),
  }));
  await prisma.auditLog.createMany({ data: extras });
  const capped = await service.list(token);
  assert.equal(capped.items.length, 100);
  assert.equal(capped.hasMore, true);
  assert.deepEqual(
    capped.items.map((i) => i.id),
    [...extras.map((i) => i.id), visible.id].sort().reverse().slice(0, 100),
  );
  await prisma.auditLog.deleteMany({
    where: { id: { in: extras.map((i) => i.id) } },
  });
  await prisma.auditLog.createMany({
    data: [
      event(job.id, "appointment.customer_rescheduled"),
      event(job.id, "job.technician_en_route"),
      event(job.id, "job.urgency_escalated"),
    ],
  });
  const before = await prisma.auditLog.count();
  const { Test } = require("@nestjs/testing"),
    { APP_GUARD } = require("@nestjs/core"),
    { ThrottlerModule, ThrottlerGuard } = require("@nestjs/throttler");
  const module = await Test.createTestingModule({
    imports: [ThrottlerModule.forRoot([{ ttl: 60000, limit: 100 }])],
    controllers: [TechnicianNotificationsController],
    providers: [
      { provide: APP_GUARD, useClass: ThrottlerGuard },
      { provide: TechnicianNotificationsService, useValue: service },
      { provide: LoggingService, useValue: { warn() {}, error() {} } },
    ],
  }).compile();
  app = module.createNestApplication({ logger: false });
  app.use((req, res, next) => {
    assert.ok(Object.hasOwn(methods, req.method));
    methods[req.method]++;
    for (const key of [
      "cookie",
      "authorization",
      "x-tenant-id",
      "x-admin-token",
      "x-dev-auth",
    ])
      if (req.headers[key]) forbidden.push(key);
    next();
  });
  app.use(
    require("cors")({
      origin: (requestOrigin, done) => done(null, requestOrigin === origin),
      methods: ["GET"],
      allowedHeaders: ["Accept", "x-technician-link"],
      credentials: false,
    }),
  );
  // Delay the real response after its real DB read; cancellation must discard this snapshot.
  const original = service.list.bind(service);
  service.list = async (...args) => {
    if (failRead) {
      failRead = false;
      throw new Error("private-database-diagnostic");
    }
    const result = await original(...args);
    if (delayed) {
      delayed = false;
      startedRead?.();
      await new Promise((resolve) => {
        releaseRead = resolve;
      });
    }
    return result;
  };
  const output = await mkdtemp(join(tmpdir(), "signmons-tech-inbox-")),
    evidence =
      process.env.TECHNICIAN_INBOX_EVIDENCE_DIR ?? join(output, "evidence");
  await mkdir(evidence, { recursive: true });
  try {
    await app.listen(0, "127.0.0.1");
    const api = `http://127.0.0.1:${app.getHttpServer().address().port}`;
    const root = fileURLToPath(new URL("../ui/", import.meta.url)),
      webpack = require("webpack");
    await new Promise((resolve, reject) => {
      const compiler = webpack({
        mode: "development",
        devtool: false,
        entry: join(root, "scripts/technician-inbox-preview.tsx"),
        output: { path: output, filename: "preview.js" },
        resolve: {
          extensions: [".tsx", ".ts", ".js"],
          alias: { "@": join(root, "src") },
          modules: [join(root, "node_modules"), "node_modules"],
        },
        plugins: [
          new webpack.DefinePlugin({
            "process.env.NEXT_PUBLIC_API_URL": JSON.stringify(api),
          }),
        ],
        module: {
          rules: [
            {
              test: /\.(tsx?|css)$/,
              exclude: /node_modules/,
              use: join(root, "scripts/calendar-review-preview-loader.cjs"),
            },
          ],
        },
      });
      compiler.run((error, stats) =>
        compiler.close(() =>
          error || stats.hasErrors()
            ? reject(error ?? Error(stats.toString()))
            : resolve(),
        ),
      );
    });
    web = createServer(async (req, res) => {
      if (req.method !== "GET") return res.writeHead(405).end();
      if (req.url === "/preview.js")
        return res
          .writeHead(200, { "Content-Type": "application/javascript" })
          .end(await readFile(join(output, "preview.js")));
      if (req.url === "/style.css")
        return res
          .writeHead(200, { "Content-Type": "text/css" })
          .end(
            await readFile(
              join(root, "src/components/technician-inbox.module.css"),
            ),
          );
      if (req.url === "/favicon.ico") return res.writeHead(204).end();
      res
        .writeHead(200, {
          "Content-Type": "text/html",
          "Content-Security-Policy": `default-src 'self'; connect-src ${api}; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'`,
        })
        .end(
          '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Technician inbox local proof</title><link rel="stylesheet" href="/style.css"><body><div id="root"></div><script defer src="/preview.js"></script></body></html>',
        );
    });
    await new Promise((resolve) => web.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${web.address().port}`;
    const { chromium } = await import(
      process.env.PLAYWRIGHT_MODULE ?? "playwright"
    );
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("request", (r) => {
      if (!r.url().startsWith(origin + "/") && !r.url().startsWith(api + "/"))
        external.push(r.url());
    });
    await page.goto(origin, { waitUntil: "load" });
    const field = page.getByLabel("Fixture technician link"),
      refresh = page.getByRole("button", { name: "Refresh notifications" });
    assert.equal(await refresh.isDisabled(), true);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await field.fill(token);
      await refresh.click();
      await page.getByText("Notifications loaded.", { exact: true }).waitFor();
      assert.equal(await page.locator("li").count(), 4);
      const body = await page.locator("body").innerText();
      for (const secret of [
        "private-phone",
        "private-body",
        "private-secret",
        "private-actor",
      ])
        assert.equal(body.includes(secret), false);
      await page.screenshot({
        path: join(evidence, `inbox-${width}.png`),
        fullPage: true,
      });
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      await page.evaluate(
        () => (document.documentElement.style.fontSize = "200%"),
      );
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      await page.evaluate(() => (document.documentElement.style.fontSize = ""));
    }
    for (const mode of ["clear", "switch"]) {
      delayed = true;
      const started = new Promise((resolve) => {
        startedRead = resolve;
      });
      await refresh.click();
      await started;
      if (mode === "clear")
        await page.getByRole("button", { name: "Clear notifications" }).click();
      else await field.fill(otherToken);
      releaseRead();
      await page.waitForFunction(
        () => document.querySelectorAll("li").length === 0,
      );
      await refresh.click();
      await page
        .getByText(
          mode === "clear"
            ? "Notifications loaded."
            : "No recent notifications for your current assignments.",
          { exact: true },
        )
        .waitFor();
    }
    await field.fill(token);
    await refresh.click();
    await page.getByText("Notifications loaded.", { exact: true }).waitFor();
    failRead = true;
    await refresh.click();
    await page
      .getByText("Notifications unavailable. Refresh to try again.", {
        exact: true,
      })
      .waitFor();
    assert.equal(await page.locator("li").count(), 0);
    assert.equal(
      (await page.locator("body").innerText()).includes(
        "private-database-diagnostic",
      ),
      false,
    );
    await refresh.click();
    await page.getByText("Notifications loaded.", { exact: true }).waitFor();
    delayed = true;
    const timeoutStarted = new Promise((resolve) => {
      startedRead = resolve;
    });
    await refresh.click();
    await timeoutStarted;
    await page
      .getByText("Notifications unavailable. Refresh to try again.", {
        exact: true,
      })
      .waitFor({ timeout: 20000 });
    releaseRead();
    assert.equal(await page.locator("li").count(), 0);
    await prisma.job.update({
      where: { id: job.id },
      data: { assignedUserId: jobData.assignedUserId },
    });
    await refresh.click();
    await page
      .getByText("No recent notifications for your current assignments.", {
        exact: true,
      })
      .waitFor();
    await prisma.user.update({
      where: { id: tech.id },
      data: { status: "DISABLED" },
    });
    await refresh.click();
    await page
      .getByText("This technician link is invalid", { exact: false })
      .waitFor();
    assert.equal(await refresh.isDisabled(), true);
    await page.getByRole("button", { name: "Clear notifications" }).click();
    assert.equal(await refresh.isDisabled(), true);
    await field.fill("tampered");
    await refresh.click();
    await page
      .getByText("This technician link is invalid", { exact: false })
      .waitFor();
    assert.equal(await prisma.auditLog.count(), before);
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    assert.deepEqual(forbidden, []);
    assert.ok(methods.OPTIONS > 0);
    assert.deepEqual(await page.context().cookies(), []);
    assert.equal(
      await page.evaluate(() => localStorage.length + sessionStorage.length),
      0,
    );
    const summary = {
      result: "PASS",
      methods,
      real: [
        "React inbox",
        "browser fetch/CORS",
        "Nest controller/throttle/filter",
        "HMAC link verification",
        "active-role/current-assignment SQL join",
        "disposable PostgreSQL",
      ],
      providerCalls: 0,
      mutationsFromInbox: 0,
      checks: [
        "privacy projection",
        "current tenant/assignment isolation",
        "disabled/non-tech link denial",
        "forged link denial",
        "deleted/unassigned/other-tech/other-tenant events omitted",
        "non-Job, unknown, old and future audit omitted",
        "100-row cap and deterministic ordering",
        "desktop/mobile and 200 percent no overflow",
        "clear and token change discard late real HTTP responses",
        "reassignment disappears on refresh",
        "denial survives clear",
        "safe HTTP 500 and explicit refresh",
        "real 15-second read timeout discards late response",
        "no cookie/storage/private metadata",
      ],
      errors,
      external,
      forbidden,
    };
    await writeFile(
      join(evidence, "summary.json"),
      JSON.stringify(summary, null, 2),
    );
    console.log(JSON.stringify(summary));
    return [
      "technician inbox: real signed-link/current-assignment PostgreSQL and browser privacy/cancellation proof",
    ];
  } finally {
    releaseRead?.();
    await browser?.close();
    if (web) {
      web.closeAllConnections();
      await new Promise((resolve) => web.close(resolve));
    }
    app?.getHttpServer().closeAllConnections?.();
    await app?.close();
  }
}
