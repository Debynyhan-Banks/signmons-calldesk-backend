import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

describe("Prisma MySQL dependency security", () => {
  it("passes the isolated native protocol compatibility checks", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--test",
        resolve(__dirname, "../../scripts/verify-mysql2-security.mjs"),
      ],
      { encoding: "utf8", timeout: 15000 },
    );
    if (result.error || result.status !== 0) {
      throw new Error(
        `MySQL dependency fixtures failed: ${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr}`,
      );
    }
    expect(result.status).toBe(0);
  }, 20000);
});
