const fs = require("fs");
const path = require("path");

const clientDir = path.join(
  __dirname,
  "..",
  "node_modules",
  "@prisma",
  "client",
);
const target = path.join(__dirname, "..", "node_modules", ".prisma");
const linkPath = path.join(clientDir, ".prisma");

try {
  if (!fs.existsSync(target)) {
    throw new Error(
      "Missing node_modules/.prisma after generation; Prisma client is unusable.",
    );
  }

  if (fs.existsSync(linkPath)) {
    return;
  }

  try {
    fs.symlinkSync(path.relative(clientDir, target), linkPath, "junction");
    console.log(
      "[prisma] Linked @prisma/client/.prisma -> node_modules/.prisma",
    );
  } catch (error) {
    if (error && error.code === "EEXIST") {
      return;
    }
    throw error;
  }
} catch (error) {
  console.error("[prisma] Failed to link generated client.", error);
  process.exitCode = 1;
}
