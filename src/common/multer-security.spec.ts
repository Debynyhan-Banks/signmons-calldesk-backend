import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

describe("Nest multipart dependency security", () => {
  it("passes isolated multipart boundary and cleanup fixtures", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--max-old-space-size=128",
        "--test",
        resolve(__dirname, "../../scripts/verify-multer-security.mjs"),
      ],
      { encoding: "utf8", timeout: 15000 },
    );
    if (result.error || result.status !== 0) {
      throw new Error(
        `Multipart fixtures failed: ${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr}`,
      );
    }
    expect(result.status).toBe(0);
  }, 20000);
});
