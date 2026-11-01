import {readFileSync} from 'node:fs';
import {runChild} from './native_child.mjs';
import {fixturePorts} from './fixture_ports.mjs';
const request=JSON.parse(readFileSync(0,'utf8'));
const scenario=process.argv[3]??'normal';
try {
  const result=await runChild(process.argv[2],request,fixturePorts(request,scenario));
  if(scenario==='lost_output'&&process.argv[2]==='--run')process.exitCode=2;
  else process.stdout.write(JSON.stringify(result)+'\n');
} catch(e) {process.stderr.write(String(e.code??e.message)+'\n');process.exitCode=2;}
