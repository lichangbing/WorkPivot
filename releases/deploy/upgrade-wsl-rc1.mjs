import {execFileSync} from 'node:child_process';
const name='workpivot-attachment-e2e-web',image='workpivot-server:0.3.0-rc.1';
const docker=args=>{try{return execFileSync('docker',args,{encoding:'utf8',timeout:120000,stdio:['ignore','pipe','pipe']}).trim();}catch{throw Error('WSL container operation failed; credentials withheld');}};
const old=JSON.parse(docker(['inspect',name]))[0],backup=name+'-before-rc1-'+Date.now();
const mounts=old.Mounts.filter(m=>['/data/workpivot','/data/workspace'].includes(m.Destination));
if(mounts.length!==2||mounts.some(m=>m.Type!=='volume')||old.HostConfig.PortBindings['39800/tcp'][0].HostIp!=='127.0.0.1')throw Error('Unexpected persistent configuration');
if(docker(['exec','workpivot-attachment-e2e-db','psql','-U','postgres','-d','workpivot','-Atc',"SELECT count(*) FROM workpivot.task_runs WHERE status IN ('running','stopping') AND lease_until>now()"] )!=='0')throw Error('Active tasks; deployment postponed');
docker(['image','inspect',image]);
let renamed=false,created=false;
try{
 docker(['stop',name]);docker(['rename',name,backup]);renamed=true;
 docker(['create','--name',name,'--restart','unless-stopped','--network','workpivot-attachment-e2e','-p','127.0.0.1:39986:39800',...old.Config.Env.flatMap(e=>['-e',e]),...mounts.flatMap(m=>['-v',m.Name+':'+m.Destination]),image,'./node_modules/.bin/tsx','eval/wsl-database-server.mts']);created=true;
 docker(['network','connect','bridge',name]);docker(['start',name]);
 let ready=false;for(let i=0;i<20;i++){try{const state=await(await fetch('http://127.0.0.1:39986/api/health',{signal:AbortSignal.timeout(2000)})).json();if(state.version==='0.3.0-rc.1'&&state.chatEnabled&&state.filesEnabled){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,500));}
 if(!ready)throw Error('RC health check failed');
 console.log(JSON.stringify({version:'0.3.0-rc.1',rollbackContainer:backup,volumesPreserved:true}));
}catch{
 if(created)docker(['rm','-f',name]);if(renamed){docker(['rename',backup,name]);docker(['start',name]);}
 console.error('RC replacement failed; previous container restored');process.exitCode=1;
}
