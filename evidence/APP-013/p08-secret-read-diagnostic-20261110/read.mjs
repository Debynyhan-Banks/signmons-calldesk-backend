import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {boundedPaymentResponse,decodeStripeTestSecret} from '../p08-native-entry-local-20261101/source/connected_payment.mjs';
const allowed=new Set(['PAYMENT_SECRET_REFUSED','PAYMENT_SECRET_SHAPE','PAYMENT_TEST_KEY_REQUIRED','PAYMENT_OUTPUT_LIMIT','PAYMENT_IO_TIMEOUT','PAYMENT_DEADLINE']);
export async function diagnose(input,send=fetch,now=Date.now){
 let status=null,calls=0,last=now(),secret='',reason=null;
 const until=input.deadline;
 const guard=spend=>{const n=now();if(n<last||n>=until)throw Object.assign(Error(),{code:'PAYMENT_DEADLINE'});last=n;if(spend&&++calls>1)throw Error();};
 try{
  if(!/^[0-9]{6,20}$/.test(input.projectNumber)||typeof input.token!=='string'||input.token.length<20||input.token.length>4096||/\s/.test(input.token))throw Error();
  const name='projects/'+input.projectNumber+'/secrets/signmons-staging-stripe-secret-key/versions/1';
  const response=await boundedPaymentResponse(async(url,options)=>{const r=await send(url,options);status=Number.isInteger(r.status)&&r.status>=100&&r.status<=599?r.status:null;return r;},
    'https://secretmanager.googleapis.com/v1/'+name+':access',{method:'GET',headers:{Authorization:'Bearer '+input.token}},guard,until);
  if(!response.ok){
   const reasons=new Set(['SERVICE_DISABLED','BILLING_DISABLED','ACCESS_TOKEN_SCOPE_INSUFFICIENT','ACCESS_TOKEN_EXPIRED','IAM_PERMISSION_DENIED','USER_PROJECT_DENIED','CONSUMER_INVALID','SECURITY_POLICY_VIOLATED','RATE_LIMIT_EXCEEDED']);
   try {const body=JSON.parse(await response.text());reason=(body.error?.details??[]).map(x=>x.reason).find(x=>reasons.has(x))??'UNCLASSIFIED';}catch{reason='UNCLASSIFIED';}
  }
  secret=await decodeStripeTestSecret(response,name);
  return {code:'TEST_KEY_VALID',httpStatus:status,providerReason:reason,requests:calls};
 }catch(error){return {code:allowed.has(error?.code)?error.code:error instanceof SyntaxError?'SECRET_JSON_INVALID':error?.name==='TimeoutError'?'SECRET_TIMEOUT':error instanceof TypeError?'SECRET_TRANSPORT_OR_ENCODING':'SECRET_UNCLASSIFIED',httpStatus:status,providerReason:reason,requests:calls};}
 finally{secret='';input.token='';input.projectNumber='';}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 let raw=readFileSync(0);if(raw.length>8192)process.exit(2);
 let input=JSON.parse(raw.toString('utf8'));raw.fill(0);
 const result=await diagnose(input);input=null;process.stdout.write(JSON.stringify(result)+'\n');
}
