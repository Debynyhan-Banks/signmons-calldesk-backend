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
const token = "synthetic-technician-no-real-authority";
const actions = [
  "accept",
  "decline",
  "cannot_take",
  "on_my_way",
  "in_progress",
  "complete",
];
const labels = [
  "Accept job",
  "Decline",
  "Can't take job",
  "I'm on my way",
  "Start work",
  "Complete job",
];
const fixture = {
  jobId,
  reference: "FIXTURE1",
  serviceCategory: "Synthetic service",
  serviceAddress: "123 Fixture Lane",
  serviceWindowStart: "2026-09-09T14:00:00Z",
  serviceWindowEnd: "2026-09-09T16:00:00Z",
  urgency: "STANDARD",
  technicianStatus: "ASSIGNED",
  updatedAt: "2026-09-08T14:00:00Z",
  customer: {
    fullName: "Synthetic Customer",
    phone: "+12025550123",
    email: null,
  },
  accessNotes: null,
  issueSummary: "Fictional test appointment",
  preferredTimeText: null,
};
const errors = [],
  unexpected = [],
  requests = [];
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
    let pending = true;
    const detail = () => ({
      ...fixture,
      calendarSyncPending: pending,
      jobStatus: pending ? "CANCELLED" : "ACCEPTED",
      availableActions: pending
        ? actions
        : ["accept", "decline", "cannot_take"],
    });
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
      assert.equal(req.headers()["x-technician-link"], token);
      if (req.method() === "GET" && path.endsWith("/technician/jobs"))
        return reply({
          technician: { id: "tech-1", fullName: "Synthetic Tech" },
          timezone: "UTC",
          linkExpiresAt: "2026-09-10T14:00:00Z",
          groups: { today: [detail()], upcoming: [], completed: [] },
        });
      if (req.method() === "GET" && path.endsWith(`/technician/jobs/${jobId}`))
        return reply(detail());
      if (
        req.method() === "POST" &&
        path.endsWith(`/technician/jobs/${jobId}/status`)
      ) {
        assert.equal(pending, true);
        assert.deepEqual(req.postDataJSON(), {
          action: "accept",
          expectedUpdatedAt: fixture.updatedAt,
        });
        return reply(
          {
            statusCode: 409,
            message: "Calendar synchronization is unfinished.",
          },
          409,
        );
      }
      unexpected.push(path);
      return route.abort();
    });
    const noActions = async () => {
      for (const label of labels)
        assert.equal(
          await page.getByRole("button", { name: label, exact: true }).count(),
          0,
        );
    };
    const noOverflow = async () =>
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
      );
    await page.goto(`${origin}/app/technician#${token}`);
    const hold = page
      .getByRole("status")
      .filter({ hasText: "Calendar synchronization is unfinished" });
    await hold.waitFor();
    assert.ok(
      (await hold.innerText()).includes(
        "Do not travel, start work, or change job status",
      ),
    );
    await page.getByText("Calendar hold", { exact: true }).waitFor();
    await page.getByText("Provisional reservation", { exact: true }).waitFor();
    await noActions();
    assert.equal(
      requests.filter((request) => request.method === "POST").length,
      name === "desktop" ? 0 : 1,
    );
    await noOverflow();
    await hold.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `${evidence}calendar-hold-technician-${name}.png`,
      fullPage: true,
    });
    // A formerly settled detail must disappear when the server reports a new hold.
    pending = false;
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    const accept = page.getByRole("button", {
      name: "Accept job",
      exact: true,
    });
    await accept.waitFor();
    pending = true;
    await accept.click();
    await page
      .getByRole("alert")
      .filter({ hasText: "Refresh before trying again" })
      .waitFor();
    await noActions();
    assert.equal(
      await page
        .getByRole("heading", { name: fixture.serviceCategory, exact: true })
        .count(),
      0,
    );
    await noOverflow();
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await hold.waitFor();
    await noActions();
    await page.close();
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  assert.equal(
    requests.filter((request) => request.method === "POST").length,
    2,
  );
  console.log(
    JSON.stringify({
      result: "PASS",
      viewports: [1440, 390],
      requests: requests.length,
      syntheticConflictPosts: 2,
      initialHeldMutationPosts: 0,
      pageErrors: errors,
      externalRequests: 0,
    }),
  );
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}
