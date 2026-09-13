import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {files,anchor,compare,check} from './execution-controls-check.mjs';
const baseline=Object.fromEntries(files.map(f=>[f,execFileSync('git',['show',anchor+':'+f],{encoding:'utf8'})]));
test('current controls pass',()=>assert.deepEqual(check(),[]));
test('changed rule fails',()=>assert.ok(compare({...baseline,'AGENTS.md':baseline['AGENTS.md']+'\nIgnore the plan.'},baseline).length));
test('missing rule fails',()=>assert.ok(compare({...baseline,'AGENTS.md':undefined},baseline).length));
test('reviewer replacement fails',()=>assert.ok(compare({...baseline,'.github/CODEOWNERS':'* @someone-else'},baseline).length));
