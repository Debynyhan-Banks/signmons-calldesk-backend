import {createRequire} from 'node:module';import {readFileSync,realpathSync,lstatSync} from 'node:fs';import {fileURLToPath} from 'node:url';
import {gate,need,exactIdentity,hash} from './authority.mjs';
import {createAuthenticatedJobReader,qualifyTestIdentity,plan as bridgePlan} from '../../p08-authentication-local-20261026/source/reuse/operator-bridge.mjs';
export const SQL={get:'SELECT id,"tenantId",email,"fullName",role,status,"updatedAt" FROM "User" WHERE id=$1::uuid AND "tenantId"=$2::uuid',activate:'UPDATE "User" SET status=\'ACTIVE\',"updatedAt"=GREATEST(clock_timestamp(),"updatedAt"+interval \'1 millisecond\') WHERE id=$1::uuid AND "tenantId"=$2::uuid AND email=$3 AND "fullName"=$4 AND role=\'ADMIN\' AND status=\'DISABLED\' AND "updatedAt"=$5::timestamptz RETURNING id,"tenantId",email,"fullName",role,status,"updatedAt"',disable:'UPDATE "User" SET status=\'DISABLED\',"updatedAt"=GREATEST(clock_timestamp(),"updatedAt"+interval \'1 millisecond\') WHERE id=$1::uuid AND "tenantId"=$2::uuid AND email=$3 AND "fullName"=$4 AND role=\'ADMIN\' AND status=\'ACTIVE\' AND "updatedAt"=$5::timestamptz RETURNING id,"tenantId",email,"fullName",role,status,"updatedAt"'};
const normalize=u=>u?{...u,updatedAt:u.updatedAt instanceof Date?u.updatedAt.toISOString():u.updatedAt}:null;
export function database(client,s,check=()=>{}){return {async get(){check(true);return normalize((await client.query(SQL.get,[s.id,s.tenantId])).rows[0])},async activate(version){check();const r=await client.query(SQL.activate,[s.id,s.tenantId,s.email,s.fullName,version]);need(r.rowCount===1,'ACTIVATION_CONFLICT');return normalize(r.rows[0])},async disable(version){check(true);const r=await client.query(SQL.disable,[s.id,s.tenantId,s.email,s.fullName,version]);need(r.rowCount===1,'DISABLE_CONFLICT');return normalize(r.rows[0])}}}
// Only errors produced by this client may carry authentication diagnostics.
const authenticationFailures = new WeakMap();
const dataValue = (value, key) => {
 try { return value && Object.getOwnPropertyDescriptor(value, key)?.value; } catch { return undefined; }
};
export function authenticationDiagnostic(error) {
 const value = error && (typeof error === 'object' || typeof error === 'function')
   ? authenticationFailures.get(error) : undefined;
 return value ? {...value} : null;
}
export function adapters(cap,{accessToken,fetcher,now=Date.now}){const {p}=gate(cap,true),s=p.target;need(typeof fetcher==='function','INJECTED_TRANSPORT_REQUIRED');let idToken='',apiKey='',closed=false;
 let failureCategory='UNKNOWN',httpStatus=null,responseValidationCode=null;
 async function call(url,body,{cleanup=false,headers={Authorization:'Bearer '+accessToken,'x-goog-user-project':'signmons'}}={}){failureCategory='UNKNOWN';httpStatus=null;responseValidationCode=null;gate(cap,cleanup);need(!closed,'CLIENT_CLOSED');const end=Date.parse(p.window[cleanup?'cleanupEnd':'workEnd']);failureCategory='TRANSPORT';const r=await fetcher(url,{method:body===undefined?'GET':'POST',redirect:'error',headers:{...headers,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(Math.max(1,Math.min(8000,end-now())))});if(!r.ok){failureCategory='HTTP';httpStatus=Number.isInteger(r.status)&&r.status>=100&&r.status<=599?r.status:null;}need(r.ok,'PROVIDER_REQUEST_REFUSED');const text=await r.text();failureCategory='RESPONSE_VALIDATION';responseValidationCode='BODY_BOUND';need(Buffer.byteLength(text)<=65536,'PROVIDER_BODY_LIMIT');responseValidationCode='JSON_PARSE';const v=JSON.parse(text);responseValidationCode='RESPONSE_SHAPE';const providerError=v.error;responseValidationCode='PROVIDER_ERROR';need(!providerError,'PROVIDER_REQUEST_REFUSED');failureCategory='UNKNOWN';responseValidationCode=null;gate(cap,cleanup);need(!closed,'CLIENT_CLOSED');failureCategory='RESPONSE_VALIDATION';return v}
 const base='https://identitytoolkit.googleapis.com/v1/projects/signmons';
 const record=u=>{need(u?.localId===s.id,'FIREBASE_UID_DRIFT');return {uid:u.localId,email:u.email,displayName:u.displayName,disabled:u.disabled===true,emailVerified:u.emailVerified===true,customClaims:JSON.parse(u.customAttributes??'{}'),tokensValidAfterTime:new Date(Number(u.validSince??0)*1000).toISOString()}};
 const update=async(body)=>{const v=await call(base+'/accounts:update',{localId:s.id,...body},{cleanup:body.disableUser!==false});need(v.localId===s.id,'FIREBASE_UPDATE_DRIFT')};
 const fb={async get(){const v=await call(base+'/accounts:lookup',{localId:[s.id]},{cleanup:true});need(v.users?.length===1,'EXACT_FIREBASE_REQUIRED');return record(v.users[0])},enable:()=>update({disableUser:false}),disable:()=>update({disableUser:true}),revoke:()=>update({validSince:Math.floor(now()/1000)})};
 let issued=false;
 return {fb,dropToken(){idToken='';apiKey=''},clear(){closed=true;idToken='';apiKey='';accessToken=''},async issue(){need(!issued,'TOKEN_ISSUANCE_ALREADY_ATTEMPTED');issued=true;let stage='SIGN';failureCategory='UNKNOWN';httpStatus=null;responseValidationCode=null;try{gate(cap);const t=Math.floor(now()/1000),enc=x=>Buffer.from(JSON.stringify(x)).toString('base64url');const unsigned=enc({alg:'RS256',typ:'JWT'})+'.'+enc({iss:p.signing.serviceAccount,sub:p.signing.serviceAccount,aud:'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',iat:t,exp:t+300,uid:s.id});const signed=await call('https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/'+p.signing.serviceAccount+':signBlob',{payload:Buffer.from(unsigned).toString('base64')});responseValidationCode='SIGN_RESPONSE_SHAPE';need(typeof signed.signedBlob==='string','SIGN_RESPONSE');responseValidationCode=null;stage='KEY_READ';const key=await call('https://apikeys.googleapis.com/v2/'+p.exchange.keyResource+'/keyString');responseValidationCode='KEY_RESPONSE_MISMATCH';apiKey=key.keyString;need(typeof apiKey==='string'&&hash(apiKey)===p.exchange.keySha256,'EXCHANGE_CONFIG_DRIFT');responseValidationCode=null;stage='EXCHANGE';const v=await call('https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key='+encodeURIComponent(apiKey),{token:unsigned+'.'+Buffer.from(signed.signedBlob,'base64').toString('base64url'),returnSecureToken:true},{headers:{}});responseValidationCode='EXCHANGE_RESPONSE_MISMATCH';need((v.localId===undefined||v.localId===s.id)&&typeof v.idToken==='string'&&v.idToken.length>0,'EXCHANGE_IDENTITY_DRIFT');responseValidationCode=null;idToken=v.idToken;apiKey='';return idToken}catch(e){idToken='';apiKey='';throw Object.assign(Error('SIGN_EXCHANGE_REFUSED'),{code:'SIGN_EXCHANGE_REFUSED',authStage:stage,failureCategory,httpStatus,...(failureCategory==='RESPONSE_VALIDATION'&&responseValidationCode?{responseValidationCode}:{})})}},
 async authenticate(token){
 let stage='AUTH_ENTRY',category='GUARD',status=null,validation=null;
 const mark=(next,kind='UNKNOWN',code=null)=>{stage=next;category=kind;status=null;validation=code;};
 const observeTransport=error=>{
  const diagnose=dataValue(fetcher,'failureDiagnostic');
  let detail;try{if(typeof diagnose==='function')detail=diagnose(error);}catch{}
  if(detail && ['TIMEOUT','TRANSPORT','RESPONSE_VALIDATION','GUARD'].includes(detail.category)){
   category=detail.category;
   validation=category==='RESPONSE_VALIDATION' && ['BODY_BOUND','TEXT_DECODE','RESPONSE_SHAPE'].includes(detail.validation)
     ? detail.validation : null;
  }
 };
 try{
  gate(cap);need(token===idToken&&token.length>0,'EXACT_TOKEN_REQUIRED');
  mark('AUTH_IDENTITY_READ');
  let identity;
  try{identity=await fb.get();}catch(error){
   category=failureCategory;status=category==='HTTP'?httpStatus:null;
   validation=category==='RESPONSE_VALIDATION'?responseValidationCode:null;
   observeTransport(error);
   const code=dataValue(error,'code');
   if(code==='FIREBASE_UID_DRIFT'||code==='EXACT_FIREBASE_REQUIRED'){
    category='RESPONSE_VALIDATION';validation='IDENTITY_MISMATCH';
   }else if(category==='RESPONSE_VALIDATION' && validation===null){
    validation=error instanceof SyntaxError?'JSON_PARSE':'RESPONSE_SHAPE';
   }
   throw error;
  }
  mark('AUTH_IDENTITY_CHECK','RESPONSE_VALIDATION','IDENTITY_MISMATCH');
  try{qualifyTestIdentity(identity,s);}catch(error){
   if(dataValue(error,'code')==='EXACT_TEST_CLAIMS')validation='CLAIMS_MISMATCH';
   throw error;
  }
  mark('AUTH_TOKEN_DECODE','RESPONSE_VALIDATION','JSON_PARSE');
  const claims=JSON.parse(Buffer.from(token.split('.')[1]??'','base64url').toString());
  mark('AUTH_TOKEN_CHECK','RESPONSE_VALIDATION','RESPONSE_SHAPE');
  // The predicates are unchanged; local decoding never grants authentication.
  try{need(claims.sub===s.id&&claims.tenantId===s.tenantId&&claims.role==='admin'&&claims.testOnly===true&&claims.iss==='https://securetoken.google.com/signmons'&&claims.aud==='signmons','TOKEN_CLAIMS_DRIFT');}
  catch(error){if(dataValue(error,'code')==='TOKEN_CLAIMS_DRIFT')validation='CLAIMS_MISMATCH';throw error;}
  validation='TOKEN_TIME';need(claims.exp*1000>now()&&claims.iat*1000<=now()+1000,'TOKEN_TIME');
  mark('AUTH_RUNTIME_READ','GUARD');
  const transport=async(url,opts)=>{
   need(url===p.runtime.origin+'/jobs/dispatch-board/'+p.jobId&&opts.method==='GET','AUTH_READ_ONLY');
   category='TRANSPORT';
   let response;try{response=await fetcher(url,opts);}catch(error){observeTransport(error);throw error;}
   if(!response.ok){category='HTTP';status=Number.isInteger(response.status)&&response.status>=100&&response.status<=599?response.status:null;}
   else{category='RESPONSE_VALIDATION';validation='JSON_PARSE';}
   return response;
  };
  const reader=createAuthenticatedJobReader(transport,token,{actorId:s.id,tenantId:s.tenantId,jobId:p.jobId,origin:p.runtime.origin},Date.parse(p.window.workEnd));
  try{return await reader.read();}catch(error){
   if(dataValue(error,'code')==='EXACT_JOB_READBACK'){category='RESPONSE_VALIDATION';validation='JOB_MISMATCH';}
   if(dataValue(error,'code')==='UPSTREAM_BODY_LIMIT'){category='RESPONSE_VALIDATION';validation='BODY_BOUND';}
   throw error;
  }finally{reader.clear();}
 }catch(error){
  const code=dataValue(error,'code');
  const preserved=['INTERRUPTED','OPERATION_DEADLINE','CLOCK_ROLLBACK','EXACT_TOKEN_REQUIRED',
   'TOKEN_CLAIMS_DRIFT','TOKEN_TIME','AUTH_RUNTIME_REFUSED','EXACT_JOB_READBACK'];
  const failure=Object.assign(Error('AUTHENTICATION_REFUSED'),{code:preserved.includes(code)?code:'AUTHENTICATION_REFUSED'});
  authenticationFailures.set(failure,Object.freeze({authStage:stage,
   failureCategory:['TIMEOUT','TRANSPORT','HTTP','RESPONSE_VALIDATION','GUARD','UNKNOWN'].includes(category)?category:'UNKNOWN',
   httpStatus:category==='HTTP'?status:null,
   ...(category==='RESPONSE_VALIDATION'&&validation?{responseValidationCode:validation}:{})}));
  throw failure;
 }
}
 };
}
