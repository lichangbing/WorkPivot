// 仅操作带随机实例名的控制器与沙箱，业务服务和状态目录不参与测试。
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm,readdir,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
const name='wp-controller-test-'+randomBytes(8).toString('hex'),root=await mkdtemp(join(tmpdir(),name)),state=join(root,'state'),token=randomBytes(32).toString('hex');
const image=process.env.WORKPIVOT_TEST_CONTROLLER_IMAGE??'workpivot-controller:cn-20261018',executor=process.env.WORKPIVOT_TEST_IMAGE??'workpivot-executor:license-20261018';
const docker=args=>{try{return execFileSync('docker',args,{encoding:'utf8',timeout:30000,stdio:['ignore','pipe','pipe']}).trim();}catch{throw Error('控制器验收Docker操作失败（不输出凭据）');}};
let made=false,network=false,endpoint='',count=0;
const check=(ok,label)=>{assert.ok(ok,label);count++;console.log('通过：'+label);};
const wait=async predicate=>{for(let i=0;i<80;i++){if(await predicate())return;await delay(250);}throw Error('控制器测试等待超时');};
const sandboxes=()=>docker(['ps','-a','--filter','label=workpivot.worker='+name,'--format','{{.Names}}']).split('\n').filter(Boolean);
const request=body=>fetch(endpoint+'/v1/run',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
try{
 await mkdir(state,{mode:0o700});
 await writeFile(join(root,'worker.env'),`WORKPIVOT_WORKER_TOKEN=${token}\nWORKPIVOT_WORKER_IMAGE=${executor}\nWORKPIVOT_WORKER_OWNER=${name}\nWORKPIVOT_WORKER_STATE_DIR=${state}\n`,{mode:0o600});
 // 验收使用仅绑定宿主回环的端口；正式Compose不发布端口，使用内部网络。
 docker(['network','create',name]);network=true;
 docker(['create','--name',name,'--network',name,'--user','1000:1000','--group-add',String((await stat('/var/run/docker.sock')).gid),'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--pids-limit','128','--memory','256m','--cpus','0.5','--tmpfs','/tmp:rw,nosuid,nodev,size=16m,uid=1000,gid=1000','--mount','type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock','--mount',`type=bind,src=${state},dst=${state}`,'-p','127.0.0.1::39990','--env-file',join(root,'worker.env'),image]);made=true;
 const start=async()=>{docker(['start',name]);endpoint='http://'+docker(['port',name,'39990/tcp']);await wait(async()=>{try{return (await fetch(endpoint+'/v1/health',{headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(1000)})).ok;}catch{return false;}});};
 await start();check((await fetch(endpoint+'/v1/health')).status===401,'控制器拒绝未认证访问');
 const response=await request({command:'node -e "require(\'fs\').writeFileSync(\'result.txt\',\'42\')"',files:[],skills:[]}),result=await response.json();
 check(response.ok&&Buffer.from(result.files.find(f=>f[0]==='result.txt')[1],'base64').toString()==='42','容器控制器实际调度隔离执行并返回成果');
 await wait(async()=>!sandboxes().length&&!(await readdir(state)).length);check(true,'成功后回收沙箱与共享暂存目录');
 const pending=request({command:'echo ready > ready.txt; sleep 25',files:[],skills:[]}).catch(()=>null);
 await wait(()=>sandboxes().length===1);
 const info=JSON.parse(docker(['inspect',sandboxes()[0]]))[0];
 check(info.HostConfig.NetworkMode==='none'&&info.HostConfig.ReadonlyRootfs&&info.Config.User==='1000:1000','任务容器保持断网只读非root');
 check(!info.Mounts.some(m=>m.Destination.includes('docker.sock'))&&info.HostConfig.Memory===512*1024*1024&&info.HostConfig.NanoCpus===1e9,'任务不持有socket且CPU内存限制实际生效');
 docker(['kill','--signal','KILL',name]);await pending;
 check(sandboxes().length===1,'控制器死亡后保留可恢复的沙箱证据');
 await start();await wait(async()=>!sandboxes().length&&!(await readdir(state)).length);
 check(true,'同实例重启回收自身遗留沙箱及暂存');
 check((await request({command:'echo resumed > result.txt',files:[],skills:[]})).ok,'恢复后可执行新的显式请求');
 console.log(`容器控制器：${count}/${count}通过`);
}finally{
 if(made)docker(['rm','-f',name]);
 for(const sandbox of sandboxes()){if(!/^wp-skill-[a-f0-9-]{36}$/.test(sandbox))throw Error('测试沙箱名称异常');docker(['rm','-f',sandbox]);}
 if(network)docker(['network','rm',name]);await rm(root,{recursive:true,force:true});
}
