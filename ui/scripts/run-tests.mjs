import { spawnSync } from "node:child_process";

const result = spawnSync(
  process.execPath,
  [
    "--test",
    "scripts/framework-contract.test.mjs",
    "scripts/postcss-security.test.mjs",
    "scripts/toolchain-dependencies.test.mjs",
    "src/lib/intake-review.test.ts",
    "src/lib/urgency-review.test.ts",
    "src/lib/dispatch-board.test.ts",
    "src/lib/technician-workflow.test.ts",
    "src/lib/customer-booking.test.ts",
    "src/lib/notification-history.test.ts",
    "src/lib/notification-intents.test.ts",
    "src/calendar-review/review.test.ts",
    "src/calendar-review/http-session.test.ts",
  ],
  { stdio: "inherit" },
);

process.exit(result.status ?? 1);
