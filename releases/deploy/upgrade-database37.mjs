// 构建发布镜像后在 192.168.1.158 运行，保留已有数据库、密钥和数据卷。
import { execFileSync } from 'node:child_process';
import { mkdirSync,readFileSync,writeFileSync,copyFileSync,openSync,closeSync,existsSync } from 'node:fs';
import { join } from 'node:path';
const root='/home/lichb/workpivot-database-preview34', server='workpivot-database-server34', database='workpivot-database34', image='workpivot-server:0.3.0-db-preview.37';
const run=(bin,args,input)=>execFileSync(bin,args,{input,encoding:'utf8',timeout:300000,maxBuffer:8*1024*1024});
const docker=(args,input)=>run('docker',args,input);
const compose=join(root,'compose.yml'), override=join(root,'compose.database37.yml');
if(existsSync(override))throw Error('Upgrade override exists; inspect prior attempt before continuing');
docker(['image','inspect',image]);
const old=JSON.parse(docker(['inspect',server]))[0];
const mounts=old.Mounts.filter(m=>['/data/workpivot','/data/workspace'].includes(m.Destination));
if(mounts.length!==2 || mounts.some(m=>m.Type!=='volume'))throw Error('Unexpected persistent mounts');
const count=()=>docker(['exec',database,'psql','-U','workpivot_schema','-d','workpivot','-Atc',"SELECT count(*) FROM workpivot.task_runs WHERE status IN ('running','stopping') AND lease_until>now()"] ).trim();
if(count()!=='0')throw Error('Active runs; deployment not changed');
const workerEnv='/home/lichb/workpivot-worker/worker.env', worker=readFileSync(workerEnv,'utf8');
const value=name=>worker.match(new RegExp('^'+name+'=(.+)$','m'))?.[1]?.trim();
const host=value('WORKPIVOT_WORKER_BIND'), port=value('WORKPIVOT_WORKER_PORT'), token=value('WORKPIVOT_WORKER_TOKEN');
if(!host || !/^\d+\.\d+\.\d+\.\d+$/.test(host) || !/^\d+$/.test(port??'') || !token)throw Error('Worker configuration unavailable');
const health=await fetch(`http://${host}:${port}/v1/health`,{headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(5000)});
if(!health.ok)throw Error('Worker not ready');
const backup=join('/home/lichb/workpivot-backups','database37-'+Date.now());mkdirSync(backup,{recursive:true,mode:0o700});
for(const name of ['compose.yml','compose.database35.yml','compose.database36.yml','runtime.env','database.env','schema.env']){copyFileSync(join(root,name),join(backup,name));}
copyFileSync(workerEnv,join(backup,'worker.env'));
let stopped=false;
try {
  docker(['stop',server]);stopped=true;
  if(count()!=='0')throw Error('Run appeared during shutdown; restore service');
  for(const [file,args] of [['database.dump',['pg_dump','-U','workpivot_schema','-d','workpivot','-Fc']],['roles.sql',['pg_dumpall','-U','workpivot_schema','--globals-only']]]) {
    const fd=openSync(join(backup,file),'wx',0o600);try{execFileSync('docker',['exec',database,...args],{stdio:['ignore',fd,'pipe'],timeout:300000});}finally{closeSync(fd);}
  }
  for(const m of mounts)docker(['cp',`${server}:${m.Destination}`,join(backup,m.Destination.split('/').pop())]);
  const lines=['services:','  server:',`    image: ${image}`,`    env_file: [${workerEnv}]`,'    environment:','      WORKPIVOT_DATABASE_FILES_ROOT: /data/workpivot/files',`      WORKPIVOT_WORKER_URL: http://${host}:${port}`,'    volumes:',...mounts.map((m,i)=>`      - retained${i}:${m.Destination}`),'volumes:',...mounts.flatMap((m,i)=>[`  retained${i}:`,`    external: true`,`    name: ${m.Name}`])];
  writeFileSync(override,lines.join('\n')+'\n',{mode:0o600});
  console.log(docker(['run','--rm','--network','workpivot-preview34-database','--env-file',join(root,'schema.env'),image,'./node_modules/.bin/tsx','scripts/postgres-schema.mts']).trim());
  docker(['compose','-p','workpivot-database34','-f',compose,'-f',join(root,'compose.database35.yml'),'-f',join(root,'compose.database36.yml'),'-f',override,'up','-d','--no-deps','--wait','--wait-timeout','90','server']);
  const state=await(await fetch('http://127.0.0.1:39800/api/health')).json();
  if(state.version!=='0.3.0-db-preview.37'||!state.filesEnabled)throw Error('Unexpected health');
  if((await fetch('http://127.0.0.1:39800/api/tasks')).status!==401)throw Error('Authentication guard failed');
  for(const path of ['/','/admin'])if(!(await fetch('http://127.0.0.1:39800'+path)).ok)throw Error('UI unavailable');
  console.log(JSON.stringify({deployed:state.version,backup,override}));
} catch {
  // 保留增量结构升级结果、旧镜像及原挂载。
  if(stopped){try{writeFileSync(join(root,'compose.rollback36.yml'),['services:','  server:',`    image: ${old.Config.Image}`,'    volumes:',...mounts.map((m,i)=>`      - retained${i}:${m.Destination}`),'volumes:',...mounts.flatMap((m,i)=>[`  retained${i}:`,`    external: true`,`    name: ${m.Name}`])].join('\n')+'\n',{mode:0o600});docker(['compose','-p','workpivot-database34','-f',compose,'-f',join(root,'compose.database35.yml'),'-f',join(root,'compose.database36.yml'),'-f',join(root,'compose.rollback36.yml'),'up','-d','--no-deps','server']);}catch{}}
  console.error('Upgrade failed; inspect service status. Backup: '+backup);process.exitCode=1;
}

