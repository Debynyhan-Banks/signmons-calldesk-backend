// Only disposable local DB, loopback HTTPS and synthetic provider ports.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:https";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
const require = createRequire(import.meta.url),
  express = require("express");
const {
  prepareControlledIntakeStartup,
} = require("../dist/communications/controlled-intake-startup.js");
const {
  controlledCustomerAdmissionDigest,
} = require("../dist/communications/controlled-customer-admission.js");
export async function verifyLoadedIntakeBrowser({
  browser,
  prisma,
  runtimePrisma = prisma,
  cipher,
  template,
  facts,
  secrets,
  evidence,
}) {
  const [db] = await prisma.$queryRawUnsafe(
    "SELECT current_database() AS name, inet_server_addr() AS address",
  );
  assert.match(db.name, /^calldesk_org_[0-9a-f]{12}$/);
  assert.equal(db.address, null);
  const directory = await mkdtemp(join(tmpdir(), "signmons-test-tls-"));
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        join(directory, "key.pem"),
        "-out",
        join(directory, "cert.pem"),
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
      ],
      { stdio: "ignore" },
    );
    const tls = {
      key: await readFile(join(directory, "key.pem")),
      cert: await readFile(join(directory, "cert.pem")),
    };
    for (const width of [390, 1440])
      for (const mode of ["accepted", "outside", "unknown", "correction"]) {
        const app = express(),
          server = createServer(tls, app);
        await new Promise((r) => server.listen(0, "127.0.0.1", r));
        const origin = `https://127.0.0.1:${server.address().port}`;
        const cfg = structuredClone(template),
          from = Date.now() - 1000,
          until = Date.now() + 120000;
        cfg.origin = cfg.activation.origin = origin;
        cfg.addressAccountId = randomUUID(); // Independent synthetic account per case; never resets a real hold.
        cfg.phone.accountSid = "AC" + randomUUID().replaceAll("-", "");
        cfg.activation.packetId = randomUUID();
        cfg.activation.validFrom = new Date(from).toISOString();
        cfg.activation.validUntil = new Date(until).toISOString();
        cfg.phone.packetId = cfg.browserBudget.packetId =
          cfg.activation.packetId;
        cfg.phone.startsAt = cfg.browserBudget.validFrom = from;
        cfg.phone.expiresAt =
          cfg.browserBudget.validUntil =
          cfg.addressPolicy.validUntil =
            until;
        cfg.browserBudget.total = cfg.browserBudget.tenant = 60;
        cfg.browserBudget.session = 50;
        const tenantId = cfg.activation.tenantId,
          saved = (
            await prisma.tenantOrganization.findUniqueOrThrow({
              where: { id: tenantId },
            })
          ).settings;
        let runtime, context;
        let phoneCalls = 0,
          addressCalls = 0,
          lose = mode === "accepted";
        const receipts = [],
          errors = [];
        try {
          await prisma.tenantOrganization.update({
            where: { id: tenantId },
            data: {
              settings: {
                ...saved,
                controlledRuntimeApproval: {
                  enabled: true,
                  digest: createHash("sha256")
                    .update(JSON.stringify(cfg))
                    .digest("hex"),
                },
                controlledPhoneApproval: {
                  enabled: true,
                  digest: controlledCustomerAdmissionDigest(cfg.phone),
                },
              },
            },
          });
          const raw = (status) => ({
            status,
            accountSid: cfg.phone.accountSid,
            serviceSid: cfg.phone.serviceSid,
            sid: "VE" + "c".repeat(32),
            to: "+12165550123",
            channel: "sms",
          });
          runtime = await prepareControlledIntakeStartup(
            {
              CONTROLLED_INTAKE_RUNTIME_JSON: JSON.stringify(cfg),
              CONTROLLED_INTAKE_SECRETS_JSON: JSON.stringify(
                Object.fromEntries(
                  Object.entries(secrets).map(([ref, value]) => [
                    ref,
                    Buffer.isBuffer(value) ? value.toString("hex") : value,
                  ]),
                ),
              ),
              NODE_ENV: facts.nodeEnv,
              GOOGLE_CLOUD_PROJECT: facts.project,
              K_SERVICE: facts.service,
              K_CONFIGURATION: facts.configuration,
              K_REVISION: facts.revision,
              PORT: facts.port,
              ...facts.flags,
            },
            () => ({
              prisma: runtimePrisma,
              cipher,
              verifyFactory: () => ({
                verify: {
                  v2: {
                    services: () => ({
                      verifications: {
                        create: async () => {
                          phoneCalls++;
                          return raw("pending");
                        },
                      },
                      verificationChecks: {
                        create: async ({ code }) => {
                          phoneCalls++;
                          return raw(
                            code === "123456" ? "approved" : "pending",
                          );
                        },
                      },
                    }),
                  },
                },
              }),
              googlePorts: {
                token: async () => "synthetic",
                fetch: async (_url, options) => {
                  const request = JSON.parse(options.body);
                  assert.equal(
                    request.previousResponseId,
                    addressCalls === 0
                      ? undefined
                      : "11111111-1111-4111-8111-111111111111",
                  );
                  addressCalls++;
                  if (mode === "unknown") throw Error("Synthetic uncertainty");
                  const number = mode === "correction" ? "174" : "173";
                  return new Response(
                    JSON.stringify({
                      responseId: "11111111-1111-4111-8111-111111111111",
                      result: {
                        verdict: {
                          addressComplete: true,
                          validationGranularity: "PREMISE",
                        },
                        address: {
                          postalAddress: {
                            regionCode: "US",
                            administrativeArea: "OH",
                            locality: "Example",
                            postalCode: "44101",
                            addressLines: [number + " Fictional Lane"],
                          },
                          addressComponents: Object.entries({
                            street_number: number,
                            route: "Fictional Lane",
                            locality: "Example",
                            administrative_area_level_1: "Ohio",
                            postal_code: "44101",
                            country: "United States",
                          }).map(([componentType, text]) => ({
                            componentType,
                            componentName: { text },
                            confirmationLevel: "CONFIRMED",
                          })),
                        },
                        uspsData: {
                          dpvConfirmation: "Y",
                          dpvCmra: "N",
                          addressRecordType: "H",
                          fipsCountyCode: mode === "outside" ? "093" : "035",
                          county: mode === "outside" ? "Lorain" : "Cuyahoga",
                        },
                        metadata: { poBox: false },
                      },
                    }),
                    { headers: { "content-type": "application/json" } },
                  );
                },
              },
            }),
            async () => ({
              html: await readFile(
                new URL(
                  "./fixtures/customer-intake-journey.html",
                  import.meta.url,
                ),
                "utf8",
              ),
              script: await readFile(
                new URL(
                  "./fixtures/customer-intake-journey.js",
                  import.meta.url,
                ),
                "utf8",
              ),
            }),
          );
          assert.equal(phoneCalls + addressCalls, 0);
          app.use((_req, res, next) => {
            const json = res.json.bind(res);
            res.json = (body) => {
              if (
                [
                  "ADMITTED",
                  "REFUSED",
                  "UNCERTAIN",
                  "CORRECTION_REQUIRED",
                ].includes(body.status)
              )
                receipts.push(body);
              if (lose && body.status === "ADMITTED") {
                lose = false;
                res.status(503);
                return json({ error: "Synthetic lost acknowledgment" });
              }
              return json(body);
            };
            next();
          });
          app.use(runtime.session);
          app.use(runtime.page);
          context = await browser.newContext({
            ignoreHTTPSErrors: true,
            viewport: { width, height: 1000 },
          });
          const page = await context.newPage();
          page.on("pageerror", (e) => errors.push(e.message));
          const jobs = await prisma.job.count();
          await page.goto(origin + "/customer-intake");
          await page.locator("#start").click();
          await page.locator("#message").fill("Do you repair heating?");
          await page.locator("#continue").click();
          await page.locator("#skip").click();
          await page.locator("#phone").fill("+12165550123");
          await page.locator("#verifyNotice").click();
          await page.locator("#verifyRequested").check();
          await page.locator("#verifyStart").click();
          await page.waitForFunction(() =>
            document
              .getElementById("verifyStatus")
              .textContent.includes("Code check pending"),
          );
          assert.equal(
            await page.locator("#phone").getAttribute("readonly"),
            "",
          );
          await page.locator("#verifyCode").fill("123455");
          await page.locator("#verifyCheck").click();
          await page.waitForFunction(
            () =>
              document.getElementById("verifyCode").value === "" &&
              !document.getElementById("verifyCode").disabled,
          );
          assert.equal(phoneCalls, 2);
          assert.equal(await prisma.job.count(), jobs);
          await page.locator("#verifyCode").fill("123456");
          await page.locator("#verifyCheck").click();
          await page.waitForFunction(() =>
            document
              .getElementById("verifyStatus")
              .textContent.includes("Code accepted"),
          );
          assert.equal(phoneCalls, 3);
          if (mode === "accepted")
            await page.screenshot({
              path: `${evidence}/loaded-phone-${width}.png`,
              fullPage: true,
            });
          for (const [id, value] of Object.entries({
            customerName: "Fictional Loaded Customer",
            controlledStreet: "173 Fictional Lane",
            controlledCity: "Example",
            controlledPostal: "44101",
          }))
            await page.locator("#" + id).fill(value);
          for (const [id, value] of Object.entries({
            issueCategory: "COOLING",
            propertyType: "RESIDENTIAL",
            serviceIntent: "REPAIR",
          }))
            await page.locator("#" + id).selectOption(value);
          await page.locator("#reviewed").check();
          await page.locator("#draft").click();
          await page.locator("#submitReview").click();
          if (mode === "accepted") {
            await page.locator("#retry").waitFor({ state: "visible" });
            assert.equal(receipts[0]?.status, "ADMITTED");
            assert.equal(await prisma.job.count(), jobs + 1);
            await page.locator("#retry").click();
            await page.locator("#submitted").waitFor({ state: "visible" });
            assert.deepEqual(receipts[1], receipts[0]);
            assert.equal(addressCalls, 1);
          } else if (mode === "correction") {
            await page.locator("#details").waitFor({ state: "visible" });
            assert.equal(receipts[0]?.status, "CORRECTION_REQUIRED");
            assert.equal(await prisma.job.count(), jobs);
            await page.locator("#controlledUseSuggestion").click();
            assert.equal(
              await page.locator("#controlledStreet").inputValue(),
              "174 Fictional Lane",
            );
            await page.locator("#reviewed").check();
            await page.locator("#draft").click();
            await page.locator("#submitReview").click();
            await page.locator("#submitted").waitFor({ state: "visible" });
            assert.equal(addressCalls, 2);
          } else if (mode === "outside") {
            await page.locator("#details").waitFor({ state: "visible" });
            assert.equal(receipts[0]?.status, "REFUSED");
          } else {
            await page.locator("#retry").waitFor({ state: "visible" });
            assert.equal(receipts[0]?.status, "UNCERTAIN");
            assert.equal(await page.locator("#editDraft").isDisabled(), true);
          }
          assert.equal(
            await prisma.job.count(),
            jobs + (["accepted", "correction"].includes(mode) ? 1 : 0),
          );
          assert.equal(phoneCalls, 3);
          assert.deepEqual(errors, []);
          assert.equal(addressCalls, mode === "correction" ? 2 : 1);
          assert.equal(
            await page.evaluate(
              () => localStorage.length + sessionStorage.length,
            ),
            0,
          );
          assert.equal(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
            true,
          );
          await page.screenshot({
            path: `${evidence}/loaded-${mode}-${width}.png`,
            fullPage: true,
          });
          if (mode !== "unknown") {
            await page.locator("#forget").click();
            await page.waitForFunction(() =>
              document
                .getElementById("status")
                .textContent.includes(
                  "Session closed and verification data cleared",
                ),
            );
          }
          await page.reload();
          assert.equal(await page.locator("#start").isVisible(), true);
          assert.equal(await page.locator("#phone").inputValue(), "");
          console.log(
            JSON.stringify({
              loadedBrowser: {
                mode,
                width,
                phoneCalls,
                addressCalls,
                preprovisionedPhoneProof: false,
                liveProviderCalls: 0,
              },
            }),
          );
        } finally {
          runtime?.retire();
          await context?.close();
          server.closeAllConnections();
          await new Promise((r) => server.close(r));
          await prisma.tenantOrganization.update({
            where: { id: tenantId },
            data: { settings: saved },
          });
        }
      }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
