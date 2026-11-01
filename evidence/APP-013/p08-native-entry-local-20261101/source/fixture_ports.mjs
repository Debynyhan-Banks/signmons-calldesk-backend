// Isolated test driver; never imported by the native entry.
import {readFileSync} from 'node:fs';
import {SQL} from '../../p08-coordinator-auth-local-20261031/source/client.mjs';
import {PREFLIGHT_SQL} from '../../p08-real-client-binding-local-20261031/source/bound-clients.mjs';
export function fixturePorts(request,scenario='normal') {
const e=JSON.parse(readFileSync(request.envelopePath));
const j=JSON.parse(readFileSync(request.envelopePath.replace('envelope.json','journal.json')));
const prior=j.authClient, target=e.target;
let row={...target,status:prior?.activatedVersion&&!prior?.disabledVersion?'ACTIVE':'DISABLED',
  updatedAt:prior?.disabledVersion??prior?.activatedVersion??'2026-01-01T00:00:00.000Z'};
let disabled=!prior?.firebaseEnableIntent||prior?.phase==='CLOSEOUT_FINISHED';
let validSince=prior?.phase==='CLOSEOUT_FINISHED'?Math.floor(Date.now()/1000):0;
const sessions=new Set();
class Client {
  constructor(config){this.config=config;this.connection={stream:{encrypted:true,authorized:true}};}
  async connect(){sessions.add(this);}
  async end(){sessions.delete(this);}
  async query(sql,args){
    if(sql===PREFLIGHT_SQL)return {rows:[{database:e.database.database,username:e.database.user,status:'ACTIVE'}]};
    if(sql===SQL.get)return {rows:[{...row}],rowCount:1};
    if(sql===SQL.activate){if(row.status!=='DISABLED'||args[4]!==row.updatedAt)return {rows:[],rowCount:0};
      row={...row,status:'ACTIVE',updatedAt:'2026-01-01T00:00:01.000Z'};return {rows:[{...row}],rowCount:1};}
    if(sql===SQL.disable){if(row.status!=='ACTIVE'||args[4]!==row.updatedAt)return {rows:[],rowCount:0};
      row={...row,status:'DISABLED',updatedAt:'2026-01-01T00:00:02.000Z'};return {rows:[{...row}],rowCount:1};}
    if(sql.includes('pg_stat_activity'))return {rows:[{count:scenario==='sessions'?1:[...sessions].filter(x=>args[0].includes(x.config.application_name)).length}]};
    throw Error('UNLISTED_FIXTURE_SQL');
  }
}
const owner=async()=>({principal:e.plan.ownerPrincipal,impersonationOverride:false,
  credentialOverride:false,accessToken:'SYNTHETIC_OWNER_OAUTH_TOKEN'});
const fetcher=async(url,opts)=>{
  const body=opts.body?JSON.parse(opts.body):null;let value;
  if(url.endsWith('/accounts:lookup'))value={users:[{localId:target.id,email:target.email,
    displayName:target.fullName,disabled,emailVerified:false,customAttributes:JSON.stringify({tenantId:target.tenantId,role:'admin',testOnly:true}),validSince:String(validSince)}]};
  else if(url.endsWith('/accounts:update')){if('disableUser'in body)disabled=body.disableUser;if('validSince'in body)validSince=body.validSince;value={localId:target.id};}
  else if(url.includes(':signBlob'))value={signedBlob:Buffer.from('synthetic-signature').toString('base64')};
  else if(url.endsWith('/keyString'))value={keyString:'synthetic-only-key'};
  else if(url.includes('signInWithCustomToken')){
    const t=Math.floor(Date.now()/1000);
    const claims={sub:target.id,tenantId:target.tenantId,role:'admin',testOnly:true,
      iss:'https://securetoken.google.com/signmons',aud:'signmons',exp:t+300,iat:t};
    value={localId:target.id,idToken:'header.'+Buffer.from(JSON.stringify(claims)).toString('base64url')+'.signature'};
  }else if(url.endsWith('/jobs/dispatch-board/'+e.plan.jobId))value={jobId:e.plan.jobId};
  else throw Error('UNLISTED_FIXTURE_HTTPS');
  return {ok:true,text:async()=>JSON.stringify(value)};
};

return {ClientClass:Client,owner,fetcher};
}
