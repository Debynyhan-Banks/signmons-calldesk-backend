import {readFileSync} from 'node:fs';import {pathToFileURL} from 'node:url';
import {hash,need} from '../p08-native-entry-local-20261101/source/authority_bridge.mjs';
import {boundedPaymentResponse,decodeStripeTestSecret,endpoint} from '../p08-native-entry-local-20261101/source/connected_payment.mjs';
const ACCOUNT='a008b806d6ea2cbe47eda0e27bfc855f1d8a376752c434c5efc36c571ece0248';
const ENDPOINT='dbaae6448069a186dc4b9e2fc6182707dda7b61218376e9e97cd21b20b4bfeae';
export async function checkKey(input,send=fetch,pins={account:ACCOUNT,endpoint:ENDPOINT},now=Date.now){
 let key='',calls=0,last=now();
 try{
  need(Number.isFinite(input.deadline)&&input.deadline>last&&input.deadline-last<=60000,'KEY_CHECK_DEADLINE');
  need(/^we_[A-Za-z0-9]+$/.test(input.endpointId)&&hash(input.endpointId)===pins.endpoint,'KEY_ENDPOINT_PIN');
  const scope=JSON.parse(readFileSync(new URL('../p08-local-preparation-20261022/plan.json',import.meta.url)));
  const p={endpointId:input.endpointId,endpointSha256:pins.endpoint,apiVersion:'2026-03-25.dahlia',url:scope.origin+'/webhooks/stripe'};
  key=await decodeStripeTestSecret({ok:true,text:async()=>JSON.stringify({name:'hidden-owner-input',payload:{data:Buffer.from(input.key).toString('base64')}})},'hidden-owner-input');
  const guard=spend=>{const n=now();need(n>=last&&n<input.deadline,'KEY_CHECK_DEADLINE');last=n;if(spend)need(++calls<=3,'KEY_CHECK_BUDGET');};
  const get=async path=>{const r=await boundedPaymentResponse(send,'https://api.stripe.com/v1/'+path,{method:'GET',headers:{Authorization:'Bearer '+key,'Stripe-Version':p.apiVersion}},guard,input.deadline);need(r.ok,'KEY_CHECK_HTTP');return JSON.parse(await r.text());};
  const a=await get('accounts?limit=100');need(a?.object==='list'&&a.has_more===false&&Array.isArray(a.data)&&a.data.length<=100,'KEY_ACCOUNT_LIST');
  const matched=a.data.filter(x=>x?.object==='account'&&typeof x.id==='string'&&hash(x.id)===pins.account);
  need(matched.length===1&&matched[0].charges_enabled===true,'KEY_ACCOUNT_MISMATCH');
  const b=await get('balance');need(b?.object==='balance'&&b.livemode===false,'KEY_MODE_MISMATCH');
  endpoint(await get('webhook_endpoints/'+input.endpointId),p,'disabled');
  return {status:'SANDBOX_KEY_VALIDATED',requests:calls,accountMatched:true,testMode:true,endpointDisabled:true};
 }finally{key='';input.key='';input.endpointId='';}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{const raw=readFileSync(0);need(raw.length<=8192,'KEY_INPUT_LIMIT');const input=JSON.parse(raw.toString('utf8'));raw.fill(0);process.stdout.write(JSON.stringify(await checkKey(input))+'\n');}
 catch(error){const safe=new Set(['KEY_CHECK_DEADLINE','KEY_ENDPOINT_PIN','KEY_CHECK_HTTP','KEY_ACCOUNT_LIST','KEY_ACCOUNT_MISMATCH','KEY_MODE_MISMATCH','PAYMENT_TEST_KEY_REQUIRED','PAYMENT_ENDPOINT_DRIFT','PAYMENT_OUTPUT_LIMIT','PAYMENT_IO_TIMEOUT','PAYMENT_DEADLINE']);process.stdout.write(JSON.stringify({status:'SANDBOX_KEY_REFUSED',code:safe.has(error?.code)?error.code:'KEY_TRANSPORT_OR_OUTPUT_UNKNOWN'})+'\n');process.exitCode=2;}
}
