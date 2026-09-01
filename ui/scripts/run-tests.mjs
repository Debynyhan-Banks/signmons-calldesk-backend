import { spawnSync } from "node:child_process";

const result = spawnSync(
  process.execPath,
  [
    "--test",
    "src/lib/intake-review.test.ts",
    "src/lib/urgency-review.test.ts",
    "src/lib/dispatch-board.test.ts",
  ],
  { stdio: "inherit" },
);

process.exit(result.status ?? 1);
