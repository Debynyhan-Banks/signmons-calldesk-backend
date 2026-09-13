import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { executeInspection } from "./run-google-address-inspection.mjs";
import { collectAddress, operator } from "./prepare-google-address.mjs";
import { privateDialog } from "./private-phone-input.mjs";
import { semanticReview } from "./google-semantic-review.mjs";
import {
  correctionReview,
  presentObservedCorrection,
} from "./google-correction-review.mjs";
import { showTransientCorrection } from "./transient-correction-screen.mjs";

// Explicit new semantic packet; never remove/reset the prior connectivity hold.
const gc = (args) =>
  execFileSync("gcloud", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15000,
  }).trim();
try {
  const result = await executeInspection(process.argv.slice(2), {
    now: Date.now,
    account: () =>
      gc(["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"]),
    directory: () => {
      const d = join(realpathSync(homedir()), ".signmons-address-inspection");
      const s = lstatSync(d);
      if (
        !s.isDirectory() ||
        s.isSymbolicLink() ||
        s.uid !== process.getuid() ||
        (s.mode & 0o777) !== 0o700 ||
        realpathSync(d) !== d
      )
        throw Error("Unsafe directory");
      const names = readdirSync(d);
      if (
        names.length !== 1 ||
        names[0] !== "google-address-inspection-001.held"
      )
        throw Error("Existing evidence requires review");
      const p = join(d, names[0]);
      const f = lstatSync(p);
      if (
        !f.isFile() ||
        f.isSymbolicLink() ||
        f.uid !== process.getuid() ||
        (f.mode & 0o777) !== 0o600
      )
        throw Error("Unsafe prior hold");
      const h = JSON.parse(readFileSync(p, "utf8"));
      if (
        h.packetId !== "google-address-inspection-001" ||
        h.project !== "signmons" ||
        h.requests !== 1 ||
        h.liabilityMicros !== 100000
      )
        throw Error("Prior hold mismatch");
      return d;
    },
    collect: collectAddress,
    confirm: (prompt) =>
      privateDialog(
        "SEMANTIC TEST: Results will be shown privately, not saved. " + prompt,
      ),
    run: async (options, request) => {
      const require = createRequire(import.meta.url);
      const {
        GoogleAddressOneShot,
      } = require("../dist/communications/google-address-one-shot.js");
      const {
        GoogleAddressOAuthTransport,
      } = require("../dist/communications/google-address-oauth.transport.js");
      const {
        reviewGoogleAddressResponse,
      } = require("../dist/communications/google-address.adapter.js");
      const {
        reviewGoogleServiceArea,
      } = require("../dist/communications/google-service-area.js");
      const transport = new GoogleAddressOAuthTransport(true, {
        token: () =>
          Promise.resolve(
            gc(["auth", "print-access-token", "--account=" + operator]),
          ),
        fetch: (...args) => fetch(...args),
      });
      let summary, correction;
      const runner = new GoogleAddressOneShot({
        ...options,
        approval: {
          ...options.approval,
          packetId: "google-semantic-inspection-002",
        },
        transport: {
          validate: async (input, signal) => {
            const r = await transport.validate(input, signal);
            if (r.status === "RESPONSE" && !signal.aborted) {
              summary = await semanticReview(input, r.body, {
                address: reviewGoogleAddressResponse,
                county: reviewGoogleServiceArea,
              });
              correction = correctionReview(
                input,
                r.body,
                reviewGoogleAddressResponse,
              );
            }
            return r;
          },
        },
      });
      const result = await runner.run(request);
      if (result.status === "OBSERVED" && correction) {
        await presentObservedCorrection(
          result.status,
          correction,
          (entered, candidate) =>
            showTransientCorrection(entered, candidate, {
              open: (url) =>
                execFileSync("open", ["-a", "Safari", url], {
                  stdio: "ignore",
                  timeout: 10000,
                }),
            }),
        );
      } else if (result.status === "OBSERVED" && summary) {
        // Private presentation only; response/candidate/county values never in stdout.
        privateDialog(summary + "\nType OK to close.");
      }
      summary = correction = undefined;
      return result;
    },
  });
  console.log(JSON.stringify(result));
  if (result.status !== "OBSERVED") process.exitCode = 1;
} catch {
  console.error(
    "Semantic inspection refused or uncertain. Do not retry or reset holds.",
  );
  process.exitCode = 1;
}
