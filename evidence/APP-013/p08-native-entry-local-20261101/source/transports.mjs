import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {gate, need} from './authority_bridge.mjs';
const require = createRequire(new URL('../../../../package.json', import.meta.url));
const exec = promisify(execFile);

// One response deadline covers headers, every body read and normal disposal.
// Disposal after a primary failure has only its own one-second local allowance.
// Neither this helper nor disposal reserves another provider request.
export function responseDeadline(until, guard, code) {
  const wall=Date.now(), mono=performance.now();let last=wall;
  const phaseEnd=mono+(until-wall), responseEnd=Math.min(phaseEnd,mono+5000), timeouts=new WeakSet();
  const expired=()=>{const error=Object.assign(Error(code),{code});timeouts.add(error);return error;};
  const remaining=end=>{
    const now=Date.now();need(now>=last,'CLOCK_ROLLBACK');last=now;guard();
    const left=Math.min(end-performance.now(),until-now);
    if(left<=0)throw expired();return left;
  };
  async function wait(fn,end=responseEnd) {
    let timer;
    try {
      const left=remaining(end);
      const value=await Promise.race([Promise.resolve().then(()=>{remaining(end);return fn();}),
        new Promise((_,reject)=>{timer=setTimeout(()=>reject(expired()),Math.max(1,Math.ceil(left)));})]);
      remaining(end);return value;
    } finally {clearTimeout(timer);}
  }
  return {wait,dispose:(fn,failed)=>wait(fn,Math.min(failed?phaseEnd:responseEnd,performance.now()+1000)),
    isTimeout:error=>error && (typeof error==='object'||typeof error==='function') && timeouts.has(error)};
}

// Canonical User versions are UTC TIMESTAMP(3), not local wall-clock instants.
// Scope this parser to these clients; unrelated OIDs and binary formats retain pg defaults.
function timestampUTC(value) {
  const match=typeof value==='string' && /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(value);
  need(match && match[0]===value && Number(match[1])>0,'TIMESTAMP_VERSION_SHAPE');
  const canonical=`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${(match[7]??'').padEnd(3,'0')}Z`;
  const date=new Date(canonical);
  need(Number.isFinite(date.getTime()) && date.toISOString()===canonical,'TIMESTAMP_VERSION_SHAPE');
  return date;
}

/** Proof mode requires all injected transports; native defaults require exact external authority. */
export function createPorts(cap, credentials, injected = {}) {
  gate(cap, true);
  if (!cap.external) need(typeof injected.ClientClass === 'function' &&
    typeof injected.owner === 'function' && typeof injected.fetcher === 'function', 'NATIVE_REQUIRES_EXTERNAL_AUTHORITY');
  need(credentials && typeof credentials.password === 'string' && credentials.password.length > 0 &&
    typeof credentials.accessToken === 'string' && credentials.accessToken.length >= 20, 'MEMORY_CREDENTIALS');
  const Client = injected.ClientClass ?? require('pg').Client;
  const defaultTypes=require('pg').types;
  const types={getTypeParser(oid,format='text') {
    return oid===1114 && format==='text' ? timestampUTC : defaultTypes.getTypeParser(oid,format);
  }};
  const window = cap.e.plan.window;
  const deadline = cleanup => Date.parse(window[cleanup ? 'cleanupEnd' : 'workEnd']);
  const timeout = cleanup => Math.max(1, Math.min(5000, deadline(cleanup)-Date.now()));
  const spend = () => gate(cap, true, true);
  const timeoutErrors=new WeakSet(), transportFailures=new WeakMap();
  async function bounded(fn) {
    spend(); let timer;
    try {return await Promise.race([Promise.resolve().then(fn),new Promise((_,reject)=>{
      timer=setTimeout(()=>{const error=Object.assign(Error('NATIVE_IO_TIMEOUT'),{code:'NATIVE_IO_TIMEOUT'});timeoutErrors.add(error);reject(error);},timeout(true));
    })]);} finally {clearTimeout(timer); gate(cap,true);}
  }
  const config = name => ({...cap.e.database, password:credentials.password,
    application_name:name, ssl:cap.external ? {rejectUnauthorized:true} : (injected.ssl ?? {rejectUnauthorized:true}),
    connectionTimeoutMillis:timeout(true), query_timeout:timeout(true),
    options:'-c statement_timeout=4000 -c lock_timeout=2000 -c timezone=UTC',types});
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
    let phase='GUARD',category='GUARD',validation=null,signal;
    let responseBound;
    try {
      const u=new URL(url);
      need(u.protocol==='https:' && !u.username && !u.password && !u.hash &&
        (['identitytoolkit.googleapis.com','iamcredentials.googleapis.com','apikeys.googleapis.com'].includes(u.hostname) ||
         url===cap.e.runtimeOrigin+'/jobs/dispatch-board/'+cap.e.plan.jobId), 'AUTH_HOST_SCOPE');
      phase='REQUEST';category='TRANSPORT';
      responseBound=responseDeadline(deadline(true),()=>gate(cap,true),'NATIVE_IO_TIMEOUT');
      const wait=fn=>{spend();return responseBound.wait(fn);};
      const response=await wait(()=>{signal=AbortSignal.timeout(timeout(true));
        return realFetch(url,{...options,redirect:'error',signal});});
      let text;
      phase='RESPONSE_READ';
      if (response.body?.getReader) {
        const reader=response.body.getReader();let size=0;const chunks=[];let failed=false;
        try {while(true){category='TRANSPORT';validation=null;
          const r=await wait(()=>reader.read());if(r.done)break;
          size+=r.value.byteLength;category='RESPONSE_VALIDATION';validation='BODY_BOUND';
          need(size<=65536,'AUTH_OUTPUT_LIMIT');chunks.push(Buffer.from(r.value));}}
        catch(error){failed=true;throw error;}
        finally {try {await responseBound.dispose(()=>reader.cancel(),failed);}
          catch(error){if(!failed){category='TRANSPORT';validation=null;throw error;}}}
        phase='TEXT_DECODE';category='RESPONSE_VALIDATION';validation='TEXT_DECODE';
        text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
      } else {text=await wait(()=>response.text());category='RESPONSE_VALIDATION';validation='BODY_BOUND';
        need(Buffer.byteLength(text)<=65536,'AUTH_OUTPUT_LIMIT');}
      category='RESPONSE_VALIDATION';validation='RESPONSE_SHAPE';
      return {ok:response.ok,status:Number.isInteger(response.status) && response.status>=100 && response.status<=599 ? response.status : null,text:async()=>text};
    } catch(error) {
      if(error && (typeof error==='object'||typeof error==='function')) {
        const timedOut=timeoutErrors.has(error)||responseBound?.isTimeout(error)||(signal?.aborted===true && signal.reason===error);
        transportFailures.set(error,Object.freeze({phase,category:timedOut?'TIMEOUT':category,
          validation:timedOut?null:validation}));
      }
      throw error;
    }
  }
  Object.defineProperty(fetcher,'failureDiagnostic',{value:error=>{
    const value=error && (typeof error==='object'||typeof error==='function')?transportFailures.get(error):null;
    return value?{...value}:null;
  }});

  return {ownerAuth,dbFactory,sessionProbe,fetcher};
}
