// Fictional local-only proof: disposable Unix-socket PostgreSQL, real controller/service,
// explicitly substituted test identity guard, static exported UI. No provider credentials.
import assert from "node:assert/strict";
import { verifyOrganizationIntake } from "./verify-organization-intake.mjs";
import { verifyOperatorIntakeAdmission } from "./verify-operator-intake-admission.mjs";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const { Client, Pool } = require("pg");
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const { Test } = require("@nestjs/testing");
const {
  OrganizationProfileService,
} = require("../dist/tenants/organization-profile.service.js");
const {
  OrganizationProfileController,
} = require("../dist/tenants/organization-profile.controller.js");
const { RequestAuthGuard } = require("../dist/auth/request-auth.guard.js");
const { LoggingService } = require("../dist/logging/logging.service.js");
const {
  requestContextMiddleware,
  setAuthContext,
} = require("../dist/common/context/request-context.js");
const { UnauthorizedException } = require("@nestjs/common");
const express = require("express");
const root = fileURLToPath(new URL("../", import.meta.url));
const evidence = process.env.ORGANIZATION_EVIDENCE_DIR;
assert.ok(
  evidence?.startsWith("/private/tmp/"),
  "Evidence must be explicitly directed to /private/tmp",
);
const database = `calldesk_org_${randomBytes(6).toString("hex")}`;
assert.match(database, /^calldesk_org_[0-9a-f]{12}$/);
const local = { host: "/tmp", user: userInfo().username, port: 5432 };
const admin = new Client({ ...local, database: "postgres" });
let prisma,
  pool,
  migration,
  app,
  browser,
  created = false;
const checks = [],
  logs = [];
try {
  await admin.connect();
  assert.equal(
    (await admin.query("SELECT inet_server_addr() AS address")).rows[0].address,
    null,
  );
  await admin.query(`CREATE DATABASE "${database}"`);
  created = true;
  migration = new Client({ ...local, database });
  await migration.connect();
  const names = (
    await readdir(root + "prisma/migrations", { withFileTypes: true })
  )
    .filter((x) => x.isDirectory())
    .map((x) => x.name)
    .sort();
  for (const name of names)
    await migration.query(
      await readFile(`${root}prisma/migrations/${name}/migration.sql`, "utf8"),
    );
  await migration.end();
  migration = null;
  pool = new Pool({ ...local, database });
  prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  const tenant = await prisma.tenantOrganization.create({
    data: {
      name: "Fictional Organization QA",
      timezone: "America/New_York",
      settings: { keep: "unchanged" },
    },
  });
  const other = await prisma.tenantOrganization.create({
    data: {
      name: "Other Fictional Organization",
      timezone: "UTC",
      settings: {},
    },
  });
  const service = new OrganizationProfileService(prisma);
  const asOwner = (fn) =>
    new Promise((resolve, reject) =>
      requestContextMiddleware({ headers: {} }, {}, () => {
        setAuthContext({
          userId: "fictional-owner",
          tenantId: tenant.id,
          role: "owner",
        });
        Promise.resolve().then(fn).then(resolve, reject);
      }),
    );
  const facts = {
    companyName: "Fictional Service",
    timezone: "America/New_York",
    hours: "Weekdays 9 to 5",
    services: "Heating; no plumbing",
    fallback: "Contact our office for human help.",
    greeting: "Welcome.",
    tone: "warm",
    faqs: [
      {
        question: "Do you repair heating?",
        answer: "Yes, we service heating equipment.",
        source: "Fictional owner review",
      },
    ],
  };
  let state = await asOwner(() => service.read());
  const race = await Promise.allSettled(
    [1, 2].map(() =>
      asOwner(() =>
        service.write({ expectedUpdatedAt: state.updatedAt, draft: facts }),
      ),
    ),
  );
  assert.equal(race.filter((x) => x.status === "fulfilled").length, 1);
  checks.push("concurrent stale-version writers commit once");
  state = await asOwner(() => service.read());
  const before = await prisma.tenantOrganization.findUnique({
    where: { id: tenant.id },
  });
  const failing = new OrganizationProfileService(
    new Proxy(prisma, {
      get(target, key) {
        if (key === "$transaction")
          return (fn) =>
            target.$transaction((tx) =>
              fn(
                new Proxy(tx, {
                  get(t, k) {
                    return k === "auditLog"
                      ? {
                          create: async () => {
                            throw new Error("injected audit failure");
                          },
                        }
                      : Reflect.get(t, k);
                  },
                }),
              ),
            );
        return Reflect.get(target, key);
      },
    }),
  );
  await assert.rejects(
    asOwner(() =>
      failing.write({
        expectedUpdatedAt: state.updatedAt,
        draft: { ...facts, greeting: "Do not commit" },
      }),
    ),
  );
  assert.deepEqual(
    await prisma.tenantOrganization.findUnique({ where: { id: tenant.id } }),
    before,
  );
  checks.push("real transaction rolls back draft on audit failure");
  state = await asOwner(() =>
    service.write(
      { expectedUpdatedAt: state.updatedAt, acknowledged: true },
      true,
    ),
  );
  const approvedAt = state.profile.approved.approvedAt;
  state = await asOwner(() =>
    service.write({
      expectedUpdatedAt: state.updatedAt,
      draft: { ...facts, greeting: "Unapproved edit" },
    }),
  );
  assert.equal(state.profile.approved.approvedAt, approvedAt);
  assert.ok(
    !(
      await asOwner(() =>
        service.answer({
          expectedUpdatedAt: state.updatedAt,
          question: facts.faqs[0].question,
        }),
      )
    ).answer.includes("Unapproved edit"),
  );
  const reopened = await asOwner(() =>
    new OrganizationProfileService(prisma).read(),
  );
  assert.equal(reopened.profile.draft.greeting, "Unapproved edit");
  assert.equal(
    (await prisma.tenantOrganization.findUnique({ where: { id: tenant.id } }))
      .settings.keep,
    "unchanged",
  );
  checks.push(
    "durable save/reopen and immutable approved snapshot across draft edits",
  );
  const module = await Test.createTestingModule({
    controllers: [OrganizationProfileController],
    providers: [
      { provide: OrganizationProfileService, useValue: service },
      {
        provide: LoggingService,
        useValue: {
          warn: (...x) => logs.push(x),
          error: (...x) => logs.push(x),
        },
      },
    ],
  })
    .overrideGuard(RequestAuthGuard)
    .useValue({
      canActivate(context) {
        const token = context.switchToHttp().getRequest().headers.authorization;
        const role =
          token === "Bearer fixture-owner"
            ? "owner"
            : token === "Bearer fixture-dispatcher"
              ? "dispatcher"
              : token === "Bearer fixture-other"
                ? "owner"
                : null;
        if (!role) throw new UnauthorizedException();
        setAuthContext({
          userId: "fictional-owner",
          tenantId: token === "Bearer fixture-other" ? other.id : tenant.id,
          role,
        });
        return true;
      },
    })
    .compile();
  app = module.createNestApplication({ logger: false });
  app.use(requestContextMiddleware);
  app.use(express.static(root + "ui/out", { extensions: ["html"] }));
  await app.listen(0, "127.0.0.1");
  const origin = await app.getUrl();
  for (const [token, expected] of [
    ["bad", 401],
    ["fixture-dispatcher", 403],
    ["fixture-owner", 200],
  ]) {
    const response = await fetch(origin + "/organization/profile", {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, expected);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
  }
  const otherResponse = await fetch(origin + "/organization/profile", {
    headers: { Authorization: "Bearer fixture-other" },
  });
  assert.equal((await otherResponse.json()).profile, null);
  checks.push(
    "controller unauthorized/role/tenant isolation and private no-store responses",
  );
  assert.ok(
    process.env.PLAYWRIGHT_MODULE,
    "Explicit local Playwright runtime required",
  );
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (
      url.origin === "http://localhost:3000" &&
      url.pathname.startsWith("/organization/profile")
    ) {
      const response = await route.fetch({ url: origin + url.pathname });
      return route.fulfill({ response });
    }
    if (url.origin !== origin)
      throw new Error("External request refused: " + url.origin);
    return route.continue();
  });
  await page.goto(origin + "/app/organization", { waitUntil: "load" });
  await page.getByLabel("Operator ID token").fill("fixture-owner");
  await page.getByRole("button", { name: "Load organization" }).click();
  await page
    .getByText("Organization loaded. Review facts before approval.", {
      exact: true,
    })
    .waitFor();
  await page.getByLabel("Brand greeting").fill("Welcome to our team.");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await page
    .getByText("Draft saved. Existing approved version is unchanged.", {
      exact: true,
    })
    .waitFor();
  await page
    .getByLabel("I reviewed these saved facts", { exact: false })
    .check();
  await page
    .getByRole("button", { name: "Approve saved version", exact: true })
    .click();
  await page
    .getByText(
      "Saved version approved for preview. Live answering is not connected.",
      { exact: true },
    )
    .waitFor();
  await page
    .getByLabel("Customer question", { exact: true })
    .fill(facts.faqs[0].question);
  await page
    .getByRole("button", { name: "Preview answer", exact: true })
    .click();
  await page
    .getByText("Exact approved FAQ match. Preview only; no action performed.", {
      exact: true,
    })
    .waitFor();
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: evidence + "/desktop.png", fullPage: true });
  await page
    .getByLabel("Customer question", { exact: true })
    .fill("Can you promise a free repair?");
  await page
    .getByRole("button", { name: "Preview answer", exact: true })
    .click();
  await page
    .getByText(
      "No approved match. Human follow-up instructions shown; no callback task was created.",
      { exact: true },
    )
    .waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.screenshot({ path: evidence + "/mobile.png", fullPage: true });
  const concurrent = await asOwner(() => service.read());
  await asOwner(() =>
    service.write({
      expectedUpdatedAt: concurrent.updatedAt,
      draft: concurrent.profile.draft,
    }),
  );
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await page
    .getByText("Version changed or approval is missing. Reload and review.", {
      exact: true,
    })
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Save draft", exact: true }).count(),
    0,
  );
  await page
    .getByRole("button", { name: "Load organization", exact: true })
    .click();
  await page
    .getByText("Organization loaded. Review facts before approval.", {
      exact: true,
    })
    .waitFor();
  checks.push("browser stale save blocks further writes until reload");
  await page
    .getByRole("button", { name: "Clear session", exact: true })
    .click();
  assert.equal(await page.getByLabel("Company display name").count(), 0);
  assert.equal(await page.getByLabel("Operator ID token").inputValue(), "");
  assert.deepEqual(errors, []);
  assert.equal(
    await page.evaluate(() => localStorage.length + sessionStorage.length),
    0,
  );
  checks.push(
    "desktop/mobile real-controller save approve FAQ/fallback preview and clear-session browser flow",
  );
  checks.push(
    ...(await verifyOrganizationIntake({
      prisma,
      tenantId: tenant.id,
      otherTenantId: other.id,
      asOwner,
      organizationService: service,
      browser,
      evidence,
    })),
  );
  const audit = await prisma.auditLog.findMany({
    where: { tenantId: tenant.id },
  });
  assert.ok(audit.some((x) => x.action === "organization.profile_approved"));
  assert.ok(!JSON.stringify(audit).includes(facts.companyName));
  assert.equal(await prisma.job.count(), 0);
  checks.push("privacy-safe audit and zero job/provider side effects");
  await writeFile(
    evidence + "/summary.json",
    JSON.stringify(
      {
        checks,
        migrations: names.length,
        browserErrors: errors,
        providerCalls: 0,
        jobCount: 0,
        identity: "explicit fixture guard, not Firebase acceptance",
        runtimeConnected: false,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ checks, evidence, providerCalls: 0 }));
  console.log(
    JSON.stringify({
      operatorAdmission: await verifyOperatorIntakeAdmission({
        prisma,
        tenantId: tenant.id,
        otherTenantId: other.id,
        asOwner,
        organizationService: service,
        evidence,
      }),
    }),
  );
} finally {
  await browser?.close();
  await app?.close();
  await migration?.end();
  await prisma?.$disconnect();
  if (pool && !pool.ended) await pool.end();
  if (created) await admin.query(`DROP DATABASE "${database}"`);
  await admin.end();
  console.log("Disposable organization fixture cleaned up.");
}
