import {readFileSync} from 'node:fs';
import {runChild} from './native_child.mjs';
import {fixturePorts} from './fixture_ports.mjs';
const request=JSON.parse(readFileSync(0,'utf8'));
const scenario=process.argv[3]??'normal';
try {
  let ports=fixturePorts(request,scenario);
  const e=JSON.parse(readFileSync(request.envelopePath));
  if(e.version===2){const {portsFor,rawFor}=await import('./fixture_connected.mjs');ports=portsFor({r:request,e,raw:rawFor(e)},scenario);}
  const result=await runChild(process.argv[2],request,ports);
  if(scenario==='lost_output'&&process.argv[2]==='--run')process.exitCode=2;
  else process.stdout.write(JSON.stringify(result)+'\n');
} catch(e) {process.stderr.write(String(e.code??e.message)+'\n');process.exitCode=2;}
