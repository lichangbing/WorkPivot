// Dedicated WSL host service; never run this inside a container or mount a Docker socket.
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
const run = (bin,args,input) => execFileSync(bin,args,{input,encoding:'utf8',timeout:180000,stdio:['pipe','pipe','pipe']}).trim();
const container='workpivot-attachment-e2e-web', service='workpivot-database-worker', image='workpivot-executor:0.1.0';
run('docker',['image','inspect',image]); run('docker',['inspect',container]);
const gateway=JSON.parse(run('docker',['network','inspect','bridge']))[0].IPAM.Config[0].Gateway;
if (!/^\d+\.\d+\.\d+\.\d+$/.test(gateway)) throw Error('Unsupported gateway');
const root=join(homedir(),'.local','state',service); mkdirSync(root,{recursive:true,mode:0o700});
const configPath=join(root,'worker.json');
const config=existsSync(configPath)?JSON.parse(readFileSync(configPath,'utf8')):{url:`http://${gateway}:39991`,token:randomBytes(32).toString('hex')};
if (config.url!==`http://${gateway}:39991` || !/^[a-f0-9]{64}$/.test(config.token)) throw Error('Existing worker configuration differs');
writeFileSync(configPath,JSON.stringify(config),{mode:0o600});
copyFileSync(new URL('./skill-worker.mjs',import.meta.url),join(root,'skill-worker.mjs'));
writeFileSync(join(root,'worker.env'),`WORKPIVOT_WORKER_BIND=${gateway}\nWORKPIVOT_WORKER_PORT=39991\nWORKPIVOT_WORKER_TOKEN=${config.token}\nWORKPIVOT_WORKER_IMAGE=${image}\nWORKPIVOT_WORKER_OWNER=${service}\n`,{mode:0o600});
const units=join(homedir(),'.config','systemd','user'); mkdirSync(units,{recursive:true});
writeFileSync(join(units,`${service}.service`),`[Unit]\nDescription=WorkPivot database isolated execution\n[Service]\nEnvironmentFile=${root}/worker.env\nExecStart=/usr/bin/node ${root}/skill-worker.mjs\nRestart=on-failure\nRestartSec=3\n[Install]\nWantedBy=default.target\n`);
run('systemctl',['--user','daemon-reload']); run('systemctl',['--user','enable',service]); run('systemctl',['--user','restart',service]);
let healthy=false;
for(let i=0;i<20;i++){try{const r=await fetch(config.url+'/v1/health',{headers:{authorization:`Bearer ${config.token}`},signal:AbortSignal.timeout(1000)});healthy=r.ok && (await r.json()).protocol===1;}catch{} if(healthy)break;await new Promise(r=>setTimeout(r,500));}
if(!healthy)throw Error('Worker health failed; backend not changed');
run('docker',['exec','-i',container,'node','-e',"let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>require('fs').writeFileSync('/data/workpivot/worker.json',s,{mode:0o600}));"],JSON.stringify(config));
console.log('Dedicated WSL worker healthy; protected backend configuration installed.');
