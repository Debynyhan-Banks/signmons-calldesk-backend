// Read-only cross-repository gate; never skips when governance is unavailable.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const governance=process.env.SIGNMONS_GOVERNANCE_REPO;
if(!governance || !existsSync(resolve(governance,'scripts/frozen-baseline-check.mjs'))) {
  console.error('STOP: set SIGNMONS_GOVERNANCE_REPO to the resolved governance checkout with frozen-baseline safeguards.');
  process.exitCode=1;
} else {
  const backend=resolve(dirname(fileURLToPath(import.meta.url)),'..');
  const result=spawnSync(process.execPath,['scripts/docs-consistency-check.mjs'],{
    cwd:resolve(governance),env:{...process.env,SIGNMONS_BACKEND_REPO:backend},stdio:'inherit',
  });
  process.exitCode=result.status ?? 1;
}
