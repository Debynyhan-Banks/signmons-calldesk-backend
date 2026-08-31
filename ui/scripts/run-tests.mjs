import { spawnSync } from "node:child_process";

const result = spawnSync(
  process.execPath,
  ["--test", "src/lib/intake-review.test.ts"],
  { stdio: "inherit" },
);

process.exit(result.status ?? 1);
