import {readFileSync,readSync} from 'node:fs';import {pathToFileURL} from 'node:url';
import {hash,need} from '../p08-native-entry-local-20261101/source/authority_bridge.mjs';
import {boundedPaymentResponse,decodeStripeTestSecret,endpoint,endpointComparison} from '../p08-native-entry-local-20261101/source/connected_payment.mjs';
const ACCOUNT='a008b806d6ea2cbe47eda0e27bfc855f1d8a376752c434c5efc36c571ece0248';
export const ENDPOINT='dbaae6448069a186dc4b9e2fc6182707dda7b61218376e9e97cd21b20b4bfeae';
export const ENDPOINT_PHASES=Object.freeze(['OBSERVE','DISABLE','VERIFY']);
export const ENDPOINT_CODES=Object.freeze(['NONE','ENDPOINT_INPUT','ENDPOINT_PHASE','KEY_INPUT_LIMIT',
 'KEY_ENDPOINT_PIN','PAYMENT_TEST_KEY_REQUIRED','KEY_CHECK_DEADLINE','KEY_CHECK_BUDGET','KEY_CHECK_HTTP',
 'PAYMENT_ENDPOINT_DRIFT','ENDPOINT_NOT_DISABLED','PAYMENT_OUTPUT_LIMIT','PAYMENT_IO_TIMEOUT',
 'PAYMENT_DEADLINE','ENDPOINT_JSON','ENDPOINT_TRANSPORT_OR_OUTPUT_UNKNOWN']);

function endpointResult(phase='UNKNOWN'){
 return {status:'ENDPOINT_REFUSED',phase,code:'ENDPOINT_TRANSPORT_OR_OUTPUT_UNKNOWN',requests:0,
  httpStatus:null,scope:'UNKNOWN',state:'UNKNOWN'};
}
function clearInput(input){
 if(input&&typeof input==='object'){input.key='';input.endpointId='';}
}
// This is a one-request worker, not authority to perform any phase. CT3's parent
// owns approval, conditional eligibility, immutable reservations and final reads.
// Provider JSON keeps the existing JSON.parse semantics (including last member
// wins for duplicate names); exact endpoint pins are validated after decoding.
export async function endpointOnce(input,send=fetch,pin=ENDPOINT,now=Date.now,reportFields=false){
 const result=endpointResult(ENDPOINT_PHASES.includes(input?.phase)?input.phase:'UNKNOWN');
 let key='',body='',value=null,options=null,keyBytes=null,last=now(),hardEnd=0;
 try{
  need(input!==null&&typeof input==='object'&&!Array.isArray(input)&&
   Object.keys(input).sort().join(',')==='deadline,endpointId,key,phase','ENDPOINT_INPUT');
  need(ENDPOINT_PHASES.includes(input.phase),'ENDPOINT_PHASE');
  need(typeof reportFields==='boolean' && (!reportFields||input.phase==='OBSERVE'),'ENDPOINT_PHASE');
  need(Number.isSafeInteger(input.deadline)&&Number.isFinite(last)&&input.deadline>last&&
   input.deadline-last<=60000,'KEY_CHECK_DEADLINE');
  hardEnd=performance.now()+input.deadline-last;
  need(typeof input.endpointId==='string'&&input.endpointId.length<=256&&
   endpointInputStatus(input.endpointId,pin).exactMatch,'KEY_ENDPOINT_PIN');
  need(typeof input.key==='string'&&input.key.length<=264,'PAYMENT_TEST_KEY_REQUIRED');
  keyBytes=Buffer.from(input.key,'utf8');
  try{key=await decodeStripeTestSecret({ok:true,text:async()=>JSON.stringify({name:'hidden-owner-input',
   payload:{data:keyBytes.toString('base64')}})},'hidden-owner-input');}
  finally{keyBytes.fill(0);keyBytes=null;input.key='';}
  const plan=JSON.parse(readFileSync(new URL('../p08-local-preparation-20261022/plan.json',import.meta.url)));
  const p={endpointId:input.endpointId,endpointSha256:pin,apiVersion:'2026-03-25.dahlia',url:plan.origin+'/webhooks/stripe'};
  const guard=spend=>{const n=now();need(Number.isFinite(n)&&n>=last&&n<input.deadline&&
   performance.now()<hardEnd,'KEY_CHECK_DEADLINE');last=n;if(spend)need(++result.requests<=1,'KEY_CHECK_BUDGET');};
  options={method:input.phase==='DISABLE'?'POST':'GET',headers:{Authorization:'Bearer '+key,'Stripe-Version':p.apiVersion}};
  if(input.phase==='DISABLE'){options.headers['Content-Type']='application/x-www-form-urlencoded';options.body='disabled=true';}
  const guardedSend=async(...args)=>{try{return await send(...args);}catch{need(false,'ENDPOINT_TRANSPORT_OR_OUTPUT_UNKNOWN');}};
  const response=await boundedPaymentResponse(guardedSend,'https://api.stripe.com/v1/webhook_endpoints/'+input.endpointId,
   options,guard,input.deadline);
  if(Number.isInteger(response.status)&&response.status>=100&&response.status<=599)result.httpStatus=response.status;
  need(result.httpStatus!==null,'ENDPOINT_TRANSPORT_OR_OUTPUT_UNKNOWN');
  need(response.ok===true&&result.httpStatus===200,'KEY_CHECK_HTTP');
  body=await response.text();
  try{value=JSON.parse(body);}catch{need(false,'ENDPOINT_JSON');}
  if(reportFields)result.fields=endpointComparison(value,p);
  try{endpoint(value,p);}catch{result.scope='DRIFT';need(false,'PAYMENT_ENDPOINT_DRIFT');}
  result.scope='MATCH';result.state=value.status.toUpperCase();
  need(input.phase!=='DISABLE'||result.state==='DISABLED','ENDPOINT_NOT_DISABLED');
  guard(false);result.status='ENDPOINT_OBSERVED';result.code='NONE';
 }catch(error){result.code=ENDPOINT_CODES.includes(error?.code)&&error.code!=='NONE'?error.code:'ENDPOINT_TRANSPORT_OR_OUTPUT_UNKNOWN';}
 finally{
  if(keyBytes)keyBytes.fill(0);
  if(options){options.headers.Authorization='';options.body='';}
  key='';body='';value=null;options=null;clearInput(input);
 }
 return result;
}

// Read at most the existing 8192-byte input allowance plus one overflow byte.
// The supervising parent supplies the input deadline and owns blocked-process
// closure; no unbounded readFileSync(0) allocation is needed for either mode.
export function readKeyInput(fd=0){
 const bytes=Buffer.alloc(8193);let length=0;
 try{
  while(length<bytes.length){const n=readSync(fd,bytes,length,bytes.length-length,null);if(n===0)break;length+=n;}
  need(length<=8192,'KEY_INPUT_LIMIT');
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,length)));}
  catch{need(false,'ENDPOINT_INPUT');}
 }finally{bytes.fill(0);}
}
export async function endpointCli({read=readKeyInput,write=text=>process.stdout.write(text),send=fetch,pin=ENDPOINT,now=Date.now,reportFields=false}={}){
 let input=null,result;
 try{input=read();result=await endpointOnce(input,send,pin,now,reportFields);}
 catch(error){result=endpointResult();result.code=ENDPOINT_CODES.includes(error?.code)?error.code:'ENDPOINT_INPUT';}
 finally{clearInput(input);}
 write(JSON.stringify(result)+'\n');
 return result.status==='ENDPOINT_OBSERVED'?0:2;
}
export function endpointInputStatus(value,pin=ENDPOINT){
 const isString=typeof value==='string',text=isString?value:'',trimmed=text.trim();
 const valid=x=>/^we_[A-Za-z0-9]+$/.test(x);
 return {status:'LOCAL_ENDPOINT_INPUT_INSPECTED',isString,inputLength:text.length,
  formatValid:isString&&valid(text),exactMatch:isString&&valid(text)&&hash(text)===pin,
  trimmedMatch:isString&&valid(trimmed)&&hash(trimmed)===pin,
  surroundingWhitespace:isString&&trimmed!==text,looksLikeUrl:/^https?:\/\//i.test(trimmed),
  controlOrNonAscii:/[^\x20-\x7e]/.test(text),providerCalls:0};
}
export async function checkKey(input,send=fetch,pins={account:ACCOUNT,endpoint:ENDPOINT},now=Date.now){
 let key='',calls=0,last=now();
 try{
  need(Number.isFinite(input.deadline)&&input.deadline>last&&input.deadline-last<=60000,'KEY_CHECK_DEADLINE');
  const inputStatus=endpointInputStatus(input.endpointId,pins.endpoint);
  if(!inputStatus.exactMatch){const error=new Error('KEY_ENDPOINT_PIN');error.code='KEY_ENDPOINT_PIN';error.endpointInput=inputStatus;throw error;}
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
 if(process.argv[2]==='--endpoint-once' && (process.argv.length===3 ||
   (process.argv.length===4&&process.argv[3]==='--field-report')))
  process.exitCode=await endpointCli({reportFields:process.argv.length===4});
 else try{const input=readKeyInput();need(process.argv.length===2||(process.argv.length===3&&process.argv[2]==='--inspect-endpoint-local'),'KEY_INPUT_MODE');
  const result=process.argv[2]==='--inspect-endpoint-local'?endpointInputStatus(input.endpointId):await checkKey(input);
  input.endpointId='';input.key='';process.stdout.write(JSON.stringify(result)+'\n');}
 catch(error){const safe=new Set(['KEY_CHECK_DEADLINE','KEY_ENDPOINT_PIN','KEY_CHECK_HTTP','KEY_ACCOUNT_LIST','KEY_ACCOUNT_MISMATCH','KEY_MODE_MISMATCH','PAYMENT_TEST_KEY_REQUIRED','PAYMENT_ENDPOINT_DRIFT','PAYMENT_OUTPUT_LIMIT','PAYMENT_IO_TIMEOUT','PAYMENT_DEADLINE']);process.stdout.write(JSON.stringify({status:'SANDBOX_KEY_REFUSED',code:safe.has(error?.code)?error.code:'KEY_TRANSPORT_OR_OUTPUT_UNKNOWN',...(error?.code==='KEY_ENDPOINT_PIN'&&error.endpointInput?{endpointInput:error.endpointInput}:{})})+'\n');process.exitCode=2;}
}
