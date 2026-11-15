import {readFileSync,writeFileSync} from 'node:fs';
import {runChild,childRefusal,readChildRequest,serializeChildResult} from './native_child.mjs';
import {fixturePorts} from './fixture_ports.mjs';
import {PREFLIGHT_SQL} from '../../p08-real-client-binding-local-20261031/source/bound-clients.mjs';
const scenario=process.argv[3]??'normal';
try {
  const request=readChildRequest();
  let ports=fixturePorts(request,scenario);
  const e=JSON.parse(readFileSync(request.envelopePath));
  if(e.version===2){const {portsFor,rawFor}=await import('./fixture_connected.mjs');ports=portsFor({r:request,e,raw:rawFor(e)},scenario);}
  const failure=code=>Object.assign(Error('PRIVATE_SENTINEL'),{code,stage:'RESULT'});
  if(['auth_sign_http403','auth_key_http403','auth_exchange_http403'].includes(scenario)){
    const fetcher=ports.fetcher;
    ports.fetcher=async(url,options)=>{
      const selected=scenario==='auth_sign_http403'?url.includes(':signBlob'):
        scenario==='auth_key_http403'?url.endsWith('/keyString'):url.includes('signInWithCustomToken');
      return selected?{ok:false,status:403,text:async()=>'PRIVATE_SENTINEL'}:fetcher(url,options);
    };
  }
  if(scenario==='owner_refused'||scenario==='main_and_cleanup_refused')
    ports.owner=async()=>{throw failure(scenario==='main_and_cleanup_refused'&&process.argv[2]!=='--run'?'OWNER_OVERRIDE':'OWNER_DRIFT');};
  if(['db_connect_refused','db_tls_refused','db_preflight_refused','db_close_refused','db_probe_refused'].includes(scenario)){
    const Parent=ports.ClientClass;
    ports.ClientClass=class extends Parent {
      constructor(config){super(config);this.isAuth=config.application_name.startsWith('p08-auth-');
        if(this.isAuth&&scenario==='db_tls_refused')this.connection.stream.authorized=false;}
      async connect(){if(this.isAuth&&scenario==='db_connect_refused')throw failure('NATIVE_IO_TIMEOUT');return super.connect();}
      async query(sql,args){
        if(sql===PREFLIGHT_SQL&&scenario==='db_preflight_refused')return {rows:[]};
        if(sql.includes('pg_stat_activity')&&scenario==='db_probe_refused')return {rows:[{count:1}]};
        return super.query(sql,args);
      }
      async end(){const result=await super.end();if(this.isAuth&&scenario==='db_close_refused')throw failure('NATIVE_IO_TIMEOUT');return result;}
    };
  }
  if(process.argv[2]==='--run'){
    if(scenario==='authority_refused')request.receipt.deleted=true;
    if(scenario==='reservation_refused')request.childCall++;
    if(scenario==='sequence_start_refused'){
      const path=request.envelopePath.replace(/envelope\.json$/,'journal.json'),journal=JSON.parse(readFileSync(path));
      journal.authClient={operationId:e.plan.operationId,version:1};writeFileSync(path,JSON.stringify(journal));
    }
  }
  const result=await runChild(process.argv[2],request,ports);
  if(scenario==='result_serialization_refused')result.circular=result;
  if(scenario==='lost_output'&&process.argv[2]==='--run')process.exitCode=2;
  else process.stdout.write(serializeChildResult(result));
} catch(error) {process.stdout.write(JSON.stringify(childRefusal(error))+'\n');process.exitCode=2;}
