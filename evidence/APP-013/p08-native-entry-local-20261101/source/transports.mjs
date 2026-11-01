import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {gate, need} from './authority_bridge.mjs';
const require = createRequire(new URL('../../../../package.json', import.meta.url));
const exec = promisify(execFile);

/** Proof mode requires all injected transports; native defaults require exact external authority. */
export function createPorts(cap, credentials, injected = {}) {
  gate(cap, true);
  if (!cap.external) need(typeof injected.ClientClass === 'function' &&
    typeof injected.owner === 'function' && typeof injected.fetcher === 'function', 'NATIVE_REQUIRES_EXTERNAL_AUTHORITY');
  need(credentials && typeof credentials.password === 'string' && credentials.password.length > 0 &&
    typeof credentials.accessToken === 'string' && credentials.accessToken.length >= 20, 'MEMORY_CREDENTIALS');
  const Client = injected.ClientClass ?? require('pg').Client;
  const window = cap.e.plan.window;
  const deadline = cleanup => Date.parse(window[cleanup ? 'cleanupEnd' : 'workEnd']);
  const timeout = cleanup => Math.max(1, Math.min(5000, deadline(cleanup)-Date.now()));
  const spend = () => gate(cap, true, true);
  async function bounded(fn) {
    spend(); let timer;
    try {return await Promise.race([Promise.resolve().then(fn),new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(Object.assign(Error('NATIVE_IO_TIMEOUT'),{code:'NATIVE_IO_TIMEOUT'})),timeout(true));
    })]);} finally {clearTimeout(timer); gate(cap,true);}
  }
  const config = name => ({...cap.e.database, password:credentials.password,
    application_name:name, ssl:cap.external ? {rejectUnauthorized:true} : (injected.ssl ?? {rejectUnauthorized:true}),
    connectionTimeoutMillis:timeout(true), query_timeout:timeout(true),
    options:'-c statement_timeout=4000 -c lock_timeout=2000'});
  async function ownerAuth({project,principal}) {
    need(project===cap.e.plan.project && principal===cap.e.plan.ownerPrincipal,'OWNER_SCOPE');
    if (injected.owner) return bounded(()=>injected.owner({project,principal}));
    const run = async args => {
      const r = await bounded(()=>exec('/opt/homebrew/bin/gcloud',args,
        {timeout:timeout(true),maxBuffer:65536,env:{...process.env,
          CLOUDSDK_CORE_DISABLE_PROMPTS:'true',CLOUDSDK_CORE_DISABLE_FILE_LOGGING:'true',CLOUDSDK_CORE_LOG_HTTP:'false'}}));
      return r.stdout.trim();
    };
    need(await run(['auth','list','--filter=status:ACTIVE','--format=value(account)'])===principal,'OWNER_DRIFT');
    for(const key of ['auth/impersonate_service_account','auth/credential_file_override','auth/access_token_file'])
      need(['','(unset)'].includes(await run(['config','get-value',key])),'OWNER_OVERRIDE');
    return {principal,impersonationOverride:false,credentialOverride:false,accessToken:credentials.accessToken};
  }
  async function dbFactory(target,password,name) {
    need(JSON.stringify(target)===JSON.stringify(cap.e.database) && password===credentials.password &&
      name==='p08-auth-'+cap.e.plan.operationId,'DATABASE_SCOPE');
    const db = new Client(config(name));
    return {get connection(){return db.connection;},
      connect:()=>bounded(()=>db.connect()), query:(sql,args)=>bounded(()=>db.query(sql,args)),
      async end(){try {return await bounded(()=>db.end());}finally {db.password='';}}
    };
  }
  async function sessionProbe(name,target) {
    need(name==='p08-auth-'+cap.e.plan.operationId && JSON.stringify(target)===JSON.stringify(cap.e.database),'SESSION_SCOPE');
    const probe = new Client(config('p08-probe-'+cap.e.plan.operationId));
    try {
      await bounded(()=>probe.connect());
      need(probe.connection?.stream?.encrypted===true && probe.connection.stream.authorized===true,'PROBE_TLS');
      const r=await bounded(()=>probe.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name = ANY($1::text[])',
        [[name,'p08-runtime-'+cap.e.plan.operationId]]));
      need(r.rows?.length===1 && Number.isInteger(r.rows[0].count) && r.rows[0].count>=0,'SESSION_OUTPUT');
      return r.rows[0].count;
    }finally {try{await bounded(()=>probe.end());}finally{probe.password='';}}
  }
  const realFetch=injected.fetcher ?? fetch;
  async function fetcher(url,options) {
    const u=new URL(url);
    need(u.protocol==='https:' && !u.username && !u.password && !u.hash &&
      (['identitytoolkit.googleapis.com','iamcredentials.googleapis.com','apikeys.googleapis.com'].includes(u.hostname) ||
       url===cap.e.runtimeOrigin+'/jobs/dispatch-board/'+cap.e.plan.jobId), 'AUTH_HOST_SCOPE');
    const response=await bounded(()=>realFetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(timeout(true))}));
    // Bound reads before allocating an untrusted response in memory.
    let text;
    if (response.body?.getReader) {
      const reader=response.body.getReader();let size=0;const chunks=[];
      try {while(true){const r=await bounded(()=>reader.read());if(r.done)break;
        size+=r.value.byteLength;need(size<=65536,'AUTH_OUTPUT_LIMIT');chunks.push(Buffer.from(r.value));}}
      finally {await reader.cancel().catch(()=>{});}
      text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
    } else {text=await bounded(()=>response.text());need(Buffer.byteLength(text)<=65536,'AUTH_OUTPUT_LIMIT');}
    return {ok:response.ok,text:async()=>text};
  }
  return {ownerAuth,dbFactory,sessionProbe,fetcher};
}
