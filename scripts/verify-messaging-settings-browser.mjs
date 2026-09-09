import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdtemp, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);

export async function verifyMessagingSettingsBrowser({
  prisma,
  tenantId,
  otherTenantId,
}) {
  const { Test } = require("@nestjs/testing"),
    { APP_GUARD } = require("@nestjs/core"),
    { ThrottlerModule, ThrottlerGuard } = require("@nestjs/throttler"),
    { ValidationPipe } = require("@nestjs/common");
  const {
    CustomerMessagingSettingsController,
  } = require("../dist/communications/customer-messaging-settings.controller.js");
  const {
    CustomerMessagingSettingsService,
  } = require("../dist/communications/customer-messaging-settings.service.js");
  const {
    TransactionalMessageTemplateService,
  } = require("../dist/communications/transactional-message-template.service.js");
  const {
      FirebaseAdminService,
    } = require("../dist/auth/firebase-admin.service.js"),
    { PrismaService } = require("../dist/prisma/prisma.service.js"),
    { LoggingService } = require("../dist/logging/logging.service.js");
  const {
    requestContextMiddleware,
  } = require("../dist/common/context/request-context.js");
  const config = require("../dist/config/app.config.js").default;
  let browserOrigin, browser, web;
  const methods = { GET: 0, PUT: 0, OPTIONS: 0 },
    forbiddenHeaders = [];
  const module = await Test.createTestingModule({
    imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }])],
    controllers: [CustomerMessagingSettingsController],
    providers: [
      { provide: APP_GUARD, useClass: ThrottlerGuard },
      {
        provide: config.KEY,
        useValue: {
          environment: "production",
          devAuthEnabled: false,
          identityIssuer: "fixture",
          identityAudience: "fixture",
        },
      },
      {
        provide: FirebaseAdminService,
        useValue: {
          getAuth: () => ({
            verifyIdToken: async (token, revoked) => {
              assert.equal(revoked, true);
              if (!["owner", "admin", "other", "dispatcher"].includes(token))
                throw new Error("invalid fixture token");
              return {
                sub: "fixture-" + token,
                tenantId: token === "other" ? otherTenantId : tenantId,
                role: token === "other" ? "owner" : token,
                iss: "fixture",
                aud: "fixture",
              };
            },
          }),
        },
      },
      { provide: PrismaService, useValue: prisma },
      { provide: LoggingService, useValue: { warn() {}, error() {} } },
      CustomerMessagingSettingsService,
      TransactionalMessageTemplateService,
    ],
  }).compile();
  const app = module.createNestApplication({ logger: false });
  app.use((req, res, next) => {
    assert.ok(Object.hasOwn(methods, req.method));
    methods[req.method]++;
    for (const key of ["cookie", "x-admin-token", "x-dev-auth", "x-tenant-id"])
      if (req.headers[key]) forbiddenHeaders.push(key);
    next();
  });
  app.use(
    require("cors")({
      origin: (origin, done) => done(null, origin === browserOrigin),
      methods: ["GET", "PUT"],
      allowedHeaders: ["Authorization", "Accept", "Content-Type"],
      credentials: false,
    }),
  );
  app.use(requestContextMiddleware);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  const output = await mkdtemp(join(tmpdir(), "signmons-messaging-settings-"));
  const evidence =
    process.env.MESSAGING_SETTINGS_EVIDENCE_DIR ?? join(output, "evidence");
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
        entry: join(root, "scripts/customer-messaging-settings-preview.tsx"),
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
      compiler.run((err, stats) =>
        compiler.close(() =>
          err || stats.hasErrors()
            ? reject(err ?? Error(stats.toString()))
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
              join(root, "src/app/app/messaging-settings/settings.module.css"),
            ),
          );
      if (req.url === "/favicon.ico") return res.writeHead(204).end();
      res
        .writeHead(200, {
          "Content-Type": "text/html",
          "Content-Security-Policy": `default-src 'self'; connect-src ${api}; style-src 'self'; object-src 'none'; base-uri 'none'`,
        })
        .end(
          '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Messaging settings local proof</title><link rel="stylesheet" href="/style.css"><body><div id="root"></div><script defer src="/preview.js"></script></body></html>',
        );
    });
    await new Promise((resolve) => web.listen(0, "127.0.0.1", resolve));
    browserOrigin = `http://127.0.0.1:${web.address().port}`;
    const { chromium } = await import(
      process.env.PLAYWRIGHT_MODULE ?? "playwright"
    );
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage(),
      pageErrors = [],
      external = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("request", (req) => {
      if (![api, browserOrigin].includes(new URL(req.url()).origin))
        external.push(req.url());
    });
    const load = async (token) => {
      await page.getByLabel("Operator ID token").fill(token);
      await page
        .getByRole("button", { name: "Load settings", exact: true })
        .click();
    };
    const ready = () =>
      page
        .getByRole("checkbox", { name: "Appointment confirmed", exact: true })
        .waitFor();
    const auditWhere = {
      tenantId,
      action: "communication.customer_sms_preferences_updated",
    };
    for (const [width, token] of [
      [1440, "owner"],
      [390, "admin"],
    ]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(browserOrigin, { waitUntil: "load" });
      await load(token);
      await ready();
      assert.equal(await page.getByRole("checkbox").count(), 5);
      assert.equal(
        await page
          .getByRole("button", { name: "Save preferences" })
          .isDisabled(),
        true,
      );
      assert.doesNotMatch(
        await page.locator("main").innerText(),
        /privateFixture/,
      );
      await page
        .getByRole("checkbox", { name: "Appointment confirmed", exact: true })
        .setChecked(width === 390);
      await page.getByRole("checkbox", { name: /I reviewed/ }).check();
      await page.screenshot({
        path: join(evidence, `settings-${width}.png`),
        fullPage: true,
      });
      const auditBefore = await prisma.auditLog.count({ where: auditWhere });
      await page.getByRole("button", { name: "Save preferences" }).click();
      await page.getByText("Preferences saved.", { exact: false }).waitFor();
      assert.equal(
        await prisma.auditLog.count({ where: auditWhere }),
        auditBefore + 1,
      );
      await load(token);
      await ready();
      assert.equal(
        await page
          .getByRole("checkbox", { name: "Appointment confirmed", exact: true })
          .isChecked(),
        width === 390,
      );
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      await page.evaluate(
        () => (document.documentElement.style.fontSize = "200%"),
      );
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      await page.evaluate(() => (document.documentElement.style.fontSize = ""));
    }
    await prisma.tenantOrganization.update({
      where: { id: tenantId },
      data: { updatedAt: new Date(Date.now() + 1000) },
    });
    await page.getByRole("checkbox", { name: /I reviewed/ }).check();
    await page.getByRole("button", { name: "Save preferences" }).click();
    await page
      .getByText("Settings changed or need review.", { exact: false })
      .waitFor();
    assert.equal(await page.getByRole("checkbox").count(), 0);
    for (const token of ["dispatcher", "invalid"]) {
      await load(token);
      await page
        .getByText("Owner or admin access is required.", { exact: false })
        .waitFor();
      assert.equal(await page.getByLabel("Operator ID token").inputValue(), "");
    }
    await load("other");
    await ready();
    assert.match(await page.locator("main").innerText(), /Other Fixture/);
    await page.getByRole("button", { name: "Clear session" }).click();
    assert.equal(await page.getByRole("checkbox").count(), 0);
    assert.equal(
      await page.evaluate(() => localStorage.length + sessionStorage.length),
      0,
    );
    assert.deepEqual(await page.context().cookies(), []);
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(external, []);
    assert.deepEqual(forbiddenHeaders, []);
    assert.ok(methods.OPTIONS > 0);
    assert.equal(methods.PUT, 3);
    const summary = {
      result: "PASS",
      methods,
      real: "React browser fetch/CORS -> Nest verified-role/tenant boundary -> settings service -> disposable PostgreSQL",
      synthetic: ["Firebase verifier"],
      persistedSaves: 2,
      staleSaveRefused: true,
      desktopMobile: true,
      providerCalls: 0,
      pageErrors,
      external,
      forbiddenHeaders,
      evidence,
    };
    await writeFile(
      join(evidence, "browser-summary.json"),
      JSON.stringify(summary, null, 2),
    );
    console.log(JSON.stringify(summary));
  } finally {
    await browser?.close();
    if (web) {
      web.closeAllConnections();
      await new Promise((resolve) => web.close(resolve));
    }
    app.getHttpServer().closeAllConnections?.();
    await app.close();
  }
}
