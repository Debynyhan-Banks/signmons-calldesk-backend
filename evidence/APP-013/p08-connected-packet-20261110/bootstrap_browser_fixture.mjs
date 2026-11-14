// Loopback-only fixture for the actual bridge and guarded Python opener.
// No live presenter, credentials, provider transport, payment submission or logs.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {createOperatorBridge} from '../p08-native-entry-local-20261101/source/operator_bridge.mjs';
const lines=createInterface({input:process.stdin,crlfDelay:Infinity})[Symbol.asyncIterator]();
let bridge,browser,stage='INPUT';const timer=setTimeout(()=>process.exit(2),30000);
try {
 const first=JSON.parse((await lines.next()).value);
 assert.match(first.root,/^\/private\/tmp\/p08-coordinator-[0-9a-f-]{36}$/);
 const e=JSON.parse(readFileSync(first.root+'/envelope.json','utf8'));
 assert.equal(e.execution,'PROOF_ONLY');
 let providerCalls=0;
 bridge=await createOperatorBridge({qualification:{status:'QUALIFIED_DATABASE',actorId:e.target.id,
   actorRole:'admin',tenantId:e.plan.tenantId,jobId:e.plan.jobId,...e.payment},
   expectedAccount:e.payment.connectedAccountSha256,token:'SYNTHETIC_LOCAL_TOKEN',
   transport:async()=>{providerCalls++;throw Error('PROVIDER_FORBIDDEN');},deadline:Date.now()+25000});
 writeFileSync(first.root+'/payment-bootstrap.json',JSON.stringify({operationId:e.plan.operationId,
   bootstrapUrl:bridge.bootstrapUrl}),{flag:'wx',mode:0o600});
 stage='BROWSER_START';
 const {chromium}=await import('/Users/debynyhanbanks/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
 browser=await chromium.launch({headless:true,channel:'chrome'});
 const page=await browser.newPage();
 await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
 process.stdout.write('LOCAL_BRIDGE_READY\n');
 stage='PRIVATE_HANDOFF';
 const input=JSON.parse((await lines.next()).value);
 assert.equal(input.bootstrapUrl,bridge.bootstrapUrl);
 stage='NAVIGATION';
 await page.goto(input.bootstrapUrl);
 stage='PAGE_TITLE';
 assert.equal(await page.title(),'Signmons attended Sandbox payment');
 stage='PAGE_CONTROL';
 assert.equal(await page.locator('#read').count(),1);
 stage='PAGE_CHECKOUT';
 // The handoff must not supply a Checkout destination or perform payment work.
 // Existing CSS visibility of the disabled link is outside this opener change.
 assert.equal(await page.locator('#checkout').getAttribute('href'),null);
 assert.equal(providerCalls,0);
 stage='DUPLICATE';
 const response=await page.request.get(input.bootstrapUrl);
 assert.equal(response.status(),403);
 process.stdout.write('LOCAL_BROWSER_HANDOFF_PASS\n');
 await lines.next();
}catch {
 process.stdout.write('LOCAL_BROWSER_FIXTURE_REFUSED_'+stage+'\n');process.exitCode=2;
}finally {
 clearTimeout(timer);await browser?.close();await bridge?.stop();
 process.stdin.destroy();
}
