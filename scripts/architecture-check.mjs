#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const violations = [];

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

const sourceFiles = walk(join(root, "src")).filter(
  (file) => extname(file) === ".ts" && !file.endsWith(".spec.ts"),
);

for (const file of sourceFiles) {
  const source = readFileSync(file, "utf8");
  if (file.endsWith(".controller.ts") && /from ["'][^"']*prisma/.test(source)) {
    violations.push(
      `${file}: controllers must not import persistence infrastructure`,
    );
  }
}

const requiredFiles = [
  "src/integrations/webchat/webchat-integration.guard.ts",
  "src/integrations/webchat/webchat.controller.ts",
  "src/ai/safety/life-safety.service.ts",
  "src/communications/communications.module.ts",
  "src/communications/communications-operations.controller.ts",
  "src/communications/sms-consent.service.ts",
  "src/communications/sms-delivery.service.ts",
  "src/communications/sms-delivery.worker.ts",
  "src/communications/sms-enqueue-intent.service.ts",
  "src/scheduling/appointment-confirmation.service.ts",
  "prisma/migrations/20260908120000_add_sms_enqueue_intents/migration.sql",
  "src/communications/sms-provider.interface.ts",
  "src/communications/twilio-sms.provider.ts",
  "src/communications/twilio-webhook.service.ts",
  "src/communications/twilio-webhooks.controller.ts",
  "prisma/migrations/20260907180000_add_sms_consent_records/migration.sql",
  "prisma/migrations/20260907220000_add_sms_delivery_state/migration.sql",
  "prisma/migrations/20260828000000_canonical_schema_reconciliation/migration.sql",
];

const communicationsModule = readFileSync(
  join(root, "src/communications/communications.module.ts"),
  "utf8",
);
if (
  !/import\s+\{\s*AuthModule\s*\}\s+from\s+["']\.\.\/auth\/auth\.module["']/.test(
    communicationsModule,
  ) ||
  !/imports:\s*\[AuthModule\]/.test(communicationsModule)
) {
  violations.push(
    "communications module must import AuthModule for RequestAuthGuard dependencies",
  );
}

for (const relativePath of requiredFiles) {
  if (!existsSync(join(root, relativePath))) {
    violations.push(`missing required boundary: ${relativePath}`);
  }
}

const promptPath = join(root, "src/ai/prompts/calldeskSystemPrompt.txt");
const prompt = readFileSync(promptPath, "utf8");
for (const prohibited of ["$99", "upsell", "pretend to be human"]) {
  if (prompt.toLowerCase().includes(prohibited.toLowerCase())) {
    violations.push(`default prompt contains prohibited policy: ${prohibited}`);
  }
}

if (violations.length) {
  console.error("architecture-check failed");
  violations.forEach((violation) => console.error(`- ${violation}`));
  process.exit(1);
}

console.log("architecture-check passed");
