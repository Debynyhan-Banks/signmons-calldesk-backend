import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { showTransientCorrection } from "./transient-correction-screen.mjs";
import {
  correctionReview,
  presentObservedCorrection,
} from "./google-correction-review.mjs";
const entered = {
  street: "123 Fictional St",
  unit: "Apt 2",
  city: "Example",
  postalCode: "44101",
};
const candidate = {
  addressLines: ["123 Fictional Street", "Apt 2"],
  city: "Example",
  postalCode: "44101",
  country: "US",
  state: "OH",
};
test("shared Google parser connects a correction without raw provider fields", () => {
  const { reviewGoogleAddressResponse } = createRequire(import.meta.url)(
    "../dist/communications/google-address.adapter.js",
  );
  const body = {
    result: {
      verdict: {
        addressComplete: true,
        validationGranularity: "PREMISE",
        hasReplacedComponents: true,
      },
      address: {
        postalAddress: {
          regionCode: "US",
          administrativeArea: "OH",
          locality: "Example",
          postalCode: "44101",
          addressLines: ["123 Fictional Street"],
        },
        addressComponents: Object.entries({
          street_number: "123",
          route: "Fictional Street",
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
      uspsData: { dpvConfirmation: "Y" },
    },
    responseId: "never-display-response-id",
  };
  const request = {
    address: {
      addressLines: ["123 Fictional St"],
      locality: "Example",
      postalCode: "44101",
    },
  };
  const review = correctionReview(request, body, reviewGoogleAddressResponse);
  assert.equal(review.candidate.addressLines[0], "123 Fictional Street");
  assert.ok(!JSON.stringify(review).includes("never-display"));
  assert.equal(review.entered.street, "123 Fictional St");
});
const headers = (url) => ({
  "Content-Type": "application/x-www-form-urlencoded",
  Origin: new URL(url).origin,
});
async function exercise(action) {
  let url;
  const pending = showTransientCorrection(entered, candidate, {
    open: (u) => {
      url = u;
    },
    timeoutMs: 3000,
  });
  while (!url) await new Promise((r) => setTimeout(r, 1));
  try {
    return await action(url, pending);
  } finally {
    await fetch(url, {
      method: "POST",
      headers: headers(url),
      body: "action=cancel",
    }).catch(() => {});
    await pending;
  }
}
test("comparison is escaped, private, single-view and selection preserves exact suggested unit", () =>
  exercise(async (url, pending) => {
    const response = await fetch(url);
    assert.match(response.headers.get("cache-control"), /no-store/);
    assert.match(
      response.headers.get("content-security-policy"),
      /frame-ancestors 'none'/,
    );
    const html = await response.text();
    assert.match(html, /You entered/);
    assert.match(html, /Google suggested/);
    assert.match(html, /Apt 2/);
    assert.equal((await fetch(url)).status, 410);
    const r = await fetch(url, {
      method: "POST",
      headers: headers(url),
      body: "action=confirm&confirmed=yes&street=forged",
    });
    assert.equal(r.status, 200);
    const result = await pending;
    assert.equal(result.status, "CONFIRMED");
    assert.equal(result.address.street, "123 Fictional Street");
    assert.equal(result.address.unit, "Apt 2");
    assert.equal(result.admissionAuthorized, false);
  }));
test("cross-origin, missing confirmation, duplicate action and unexpected fields refused", () =>
  exercise(async (url) => {
    await fetch(url);
    for (const [body, origin, expected] of [
      ["action=confirm", new URL(url).origin, 400],
      ["action=cancel", "https://evil.example", 403],
      ["action=cancel&action=confirm", new URL(url).origin, 400],
      ["action=cancel&tenantId=forged", new URL(url).origin, 400],
    ]) {
      assert.equal(
        (
          await fetch(url, {
            method: "POST",
            headers: { ...headers(url), Origin: origin },
            body,
          })
        ).status,
        expected,
      );
    }
  }));
test("edit returns customer input, never verification; original caller data unchanged", () =>
  exercise(async (url, pending) => {
    await fetch(url);
    await fetch(url, {
      method: "POST",
      headers: headers(url),
      body: new URLSearchParams({
        ...entered,
        street: "124 Fictional St",
        action: "edit",
      }).toString(),
    });
    const result = await pending;
    assert.equal(result.status, "EDITED");
    assert.equal(result.address.street, "124 Fictional St");
    assert.equal(result.addressVerified, false);
    assert.equal(entered.street, "123 Fictional St");
  }));
test("cancel, expiry and open failure release the screen without address output", async () => {
  await exercise(async (url, pending) => {
    await fetch(url);
    await fetch(url, {
      method: "POST",
      headers: headers(url),
      body: "action=cancel",
    });
    assert.equal((await pending).address, undefined);
  });
  assert.equal(
    (
      await showTransientCorrection(entered, candidate, {
        open: () => {},
        timeoutMs: 5,
      })
    ).status,
    "EXPIRED",
  );
  assert.equal(
    (
      await showTransientCorrection(entered, candidate, {
        open: () => {
          throw Error("private");
        },
      })
    ).status,
    "UNAVAILABLE",
  );
});
test("invalid candidate refuses without opening; HTML text cannot inject markup", async () => {
  let opened = false;
  assert.equal(
    (
      await showTransientCorrection(
        entered,
        { ...candidate, state: "CA" },
        {
          open: () => {
            opened = true;
          },
        },
      )
    ).status,
    "REFUSED",
  );
  assert.equal(opened, false);
  let url;
  const pending = showTransientCorrection(
    { ...entered, street: "<script>secret</script>" },
    candidate,
    {
      open: (u) => {
        url = u;
      },
      timeoutMs: 1000,
    },
  );
  while (!url) await new Promise((r) => setTimeout(r, 1));
  const html = await (await fetch(url)).text();
  assert.ok(!html.includes("<script>"));
  assert.match(html, /&lt;script&gt;/);
  await fetch(url, {
    method: "POST",
    headers: headers(url),
    body: "action=cancel",
  });
  await pending;
});
test("only observed correction is presented; no address or arbitrary status escapes presenter", async () => {
  const request = {
    address: {
      addressLines: ["123 Fictional St", "Apt 2"],
      locality: "Example",
      postalCode: "44101",
    },
  };
  const review = correctionReview(request, {}, () => ({
    status: "CORRECTION_REQUIRED",
    candidate,
  }));
  assert.deepEqual(review.entered, entered);
  assert.equal(
    correctionReview(request, {}, () => ({ status: "UNKNOWN", candidate })),
    null,
  );
  let calls = 0;
  const present = async () => {
    calls++;
    return { status: "CONFIRMED", address: entered };
  };
  assert.equal(
    await presentObservedCorrection("UNCERTAIN", review, present),
    "NOT_PRESENTED",
  );
  assert.equal(calls, 0);
  assert.equal(
    await presentObservedCorrection("OBSERVED", review, present),
    "CONFIRMED",
  );
  assert.equal(calls, 1);
  assert.equal(
    await presentObservedCorrection("OBSERVED", review, async () => ({
      status: "private data",
    })),
    "REFUSED",
  );
});
