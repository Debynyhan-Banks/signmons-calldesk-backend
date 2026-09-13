import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

describe("Google UUID dependency security", () => {
  it("passes isolated bounds and actual-consumer compatibility checks", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--max-old-space-size=128",
        "--test",
        resolve(__dirname, "../../scripts/verify-google-uuid-security.mjs"),
      ],
      { encoding: "utf8", timeout: 15000 },
    );
    if (result.error || result.status !== 0) {
      throw new Error(
        `Google UUID fixtures failed: ${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr}`,
      );
    }
    expect(result.status).toBe(0);
  }, 20000);
});
