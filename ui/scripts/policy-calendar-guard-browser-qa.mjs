// Static export and intercepted synthetic API responses only; no real authority.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? "playwright"
);
const root = resolve(fileURLToPath(new URL("../out/", import.meta.url)));
const evidence = fileURLToPath(
  new URL("../../evidence/APP-013/", import.meta.url),
);
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  const path = resolve(
    root,
    `.${pathname === "/" ? "/index.html" : extname(pathname) ? pathname : `${pathname}.html`}`,
  );
  if (!path.startsWith(`${root}/`)) return res.writeHead(403).end();
  try {
    res.writeHead(200, {
      "Content-Type": types[extname(path)] ?? "application/octet-stream",
    });
    res.end(await readFile(path));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const jobId = "10000000-0000-4000-8000-000000000001";
const detail = {
  jobId,
  reference: "FIXTURE1",
  serviceCategory: "Synthetic service",
  urgency: "STANDARD",
  status: "ACCEPTED",
  createdAt: "2026-09-08T14:00:00Z",
  rationale: {
    decisionSource: "AI_INTAKE",
    reasonCodes: [],
    triggerDetails: ["Synthetic classification"],
    confidenceNote: "Fictional review fixture",
  },
  escalationPath: [{ order: 1, label: "Notify operations", required: false }],
  history: [],
};
const messages = [
  "Calendar synchronization is unfinished. Appointment details and actions are on hold; please contact the office before making plans or changes.",
  "Job changed while urgency was being saved. Refresh before trying again.",
];
const requests = [],
  errors = [],
  unexpected = [];
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH ??
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  for (const [name, width] of [
    ["desktop", 1440],
    ["mobile", 390],
  ]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    page.on("pageerror", (error) => errors.push(error.message));
    let message = messages[0];
    await page.route("**/*", async (route) => {
      const req = route.request(),
        url = new URL(req.url());
      if (url.origin === origin) return route.continue();
      const path = url.pathname;
      requests.push({ path, method: req.method() });
      const reply = (body, status = 200) =>
        route.fulfill({
          status,
          contentType: "application/json",
          body: JSON.stringify(body),
        });
      if (req.method() === "GET" && path.endsWith("/jobs/urgency-review"))
        return reply([detail]);
      if (
        req.method() === "GET" &&
        path.endsWith("/jobs/urgency-review/" + jobId)
      )
        return reply(detail);
      if (
        req.method() === "POST" &&
        path.endsWith("/jobs/" + jobId + "/urgency/override")
      ) {
        assert.equal(req.postDataJSON().urgency, "HIGH");
        return reply({ statusCode: 409, message }, 409);
      }
      unexpected.push(path);
      return route.abort();
    });
    await page.goto(origin + "/app/urgency-review");
    await page
      .getByLabel("Firebase operator ID token")
      .fill("synthetic-no-real-authority");
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    const save = page.getByRole("button", {
      name: "Save audited override",
      exact: true,
    });
    await save.waitFor();
    await page.getByLabel("New urgency").selectOption("HIGH");
    await page
      .getByLabel("Override reason")
      .fill("Synthetic authorized policy review");
    for (const conflict of messages) {
      message = conflict;
      await save.click();
      const alert = page.getByRole("alert").filter({ hasText: conflict });
      await alert.waitFor();
      assert.equal(await page.getByText(/Urgency changed to/).count(), 0);
      assert.equal(
        await page
          .getByRole("button", {
            name: "Notify operations and record outcome",
            exact: true,
          })
          .isEnabled(),
        true,
      );
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
      );
      if (conflict === messages[0])
        await page.screenshot({
          path: evidence + "policy-hold-urgency-" + name + ".png",
          fullPage: true,
        });
    }
    await page.close();
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  assert.equal(requests.filter((r) => r.method === "POST").length, 4);
  console.log(
    JSON.stringify({
      result: "PASS",
      viewports: [1440, 390],
      requests: requests.length,
      syntheticConflictPosts: 4,
      externalRequests: 0,
      pageErrors: errors,
      operationsEscalationRemainsAvailable: true,
    }),
  );
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}
