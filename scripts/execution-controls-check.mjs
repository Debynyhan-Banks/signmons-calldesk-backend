import {execFileSync} from 'node:child_process';
import {readFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
export const anchor='5d971c8cd91ecef2840868d3f28d5c87bf9a29b4';
export const files=["AGENTS.md",".github/CODEOWNERS"];
export const normalize=s=>s.replace(/\r\n/g,'\n').replace(/^- \[[ xX]\] /gm,'- [ ] ').trim();
export function compare(current,baseline) {
 return files.flatMap(file=>typeof current[file]!=='string'||typeof baseline[file]!=='string'||normalize(current[file])!==normalize(baseline[file])?['Protected baseline changed: '+file]:[]);
}
export function check() {
 try {
 const current={},baseline={};
 for(const file of files) {
 current[file]=readFileSync(file,'utf8');
 baseline[file]=execFileSync('git',['show',anchor+':'+file],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
 }
 const errors=compare(current,baseline);
 
 return errors;
 } catch {return ['Missing baseline file/history; fetch full history. Do not skip or regenerate.'];}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const errors=check();
 if(errors.length){console.error(errors.join('\n'));console.error('STOP: explicit owner-reviewed baseline change required.');process.exitCode=1;}
 else console.log('execution-controls passed');
}
