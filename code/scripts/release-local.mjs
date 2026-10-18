import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,existsSync,openSync,closeSync,unlinkSync,statSync,readdirSync,lstatSync,statfsSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {parseEnv} from 'node:util';
import {pathToFileURL} from 'node:url';

const name=v=>{if(typeof v!=='string'||!/^[a-z][a-z0-9_]{0,62}$/.test(v))throw Error('数据库名称或角色无效');return v;};
const hash=data=>createHash('sha256').update(data).digest('hex');
function run(args,input){try{return execFileSync('docker',args,{input,encoding:'utf8',timeout:300000,maxBuffer:32*1024*1024,stdio:['pipe','pipe','pipe']});}catch{throw Error('Docker操作失败：'+args[0]+'；底层输出已隐藏，凭据不会回显');}}
function save(path,value){writeFileSync(path,JSON.stringify(value,null,2)+'\n',{mode:0o600});}
function inspect(id){return JSON.parse(run(['inspect',id]))[0];}
function environment(container){return Object.fromEntries(container.Config.Env.map(s=>{const at=s.indexOf('=');return [s.slice(0,at),s.slice(at+1)];}));}
function inventory(root){const result=[];function walk(path){for(const entry of readdirSync(path).sort()){const file=join(path,entry),s=lstatSync(file);if(s.isSymbolicLink())throw Error('备份文件不允许符号链接');if(s.isDirectory())walk(file);else if(s.isFile())result.push({path:file.slice(root.length+1),bytes:s.size,sha256:hash(readFileSync(file))});else throw Error('备份包含特殊文件');}}walk(root);return result;}
export class LocalRelease {
 constructor(configPath){
  this.configPath=resolve(configPath);this.cfg=JSON.parse(readFileSync(this.configPath,'utf8'));const c=this.cfg;
  for(const k of ['compose','envFile','stateRoot'])if(!c[k]||!c[k].startsWith('/'))throw Error('配置路径必须为绝对路径：'+k);
  if(!/^[a-z][a-z0-9-]+$/.test(c.project)||!c.databaseContainer||!c.network)throw Error('部署身份配置不完整');
  name(c.adminUser);this.active=join(c.stateRoot,'active.json');this.override=join(c.stateRoot,'active.compose.json');
 }
 compose(args){const c=this.cfg;return run(['compose','--env-file',c.envFile,'-p',c.project,'-f',c.compose,...(existsSync(this.override)?['-f',this.override]:[]),...args]);}
 sql(database,sql){name(database);return run(['exec','-i',this.cfg.databaseContainer,'psql','-X','-v','ON_ERROR_STOP=1','-U',this.cfg.adminUser,'-d',database,'-At'],sql).trim();}
 server(){const id=this.compose(['ps','-a','-q','server']).trim();return id?inspect(id):null;}
 async locked(fn){mkdirSync(this.cfg.stateRoot,{recursive:true,mode:0o700});const path=join(this.cfg.stateRoot,'release.lock');let fd;try{fd=openSync(path,'wx',0o600);}catch{throw Error('已有发布锁；核对发布进程和记录后再处理，不能并行发布');}writeFileSync(fd,String(process.pid));try{return await fn();}finally{closeSync(fd);unlinkSync(path);}}
 preflight(image){
  const c=this.cfg;run(['info','--format','{{.ServerVersion}}']);run(['compose','version']);
  for(const path of [c.envFile,...(c.protectedFiles??[])]){if(!existsSync(path)||statSync(path).mode&0o077)throw Error('受保护配置缺失或权限不是0600：'+path);}
  const i=JSON.parse(run(['image','inspect',image]))[0];
  if(!i?.Id)throw Error('发布镜像不存在');
  const server=this.server();if(!server)throw Error('未发现应用容器；首次安装请使用install');
  const env=environment(server),database=name(new URL(env.WORKPIVOT_DATABASE_URL).pathname.slice(1));
  const volume=server.Mounts.find(m=>m.Destination==='/data/files');if(volume?.Type!=='volume')throw Error('仅支持/data/files命名卷部署');
  if(server.Mounts.some(m=>m.Destination.includes('docker.sock')))throw Error('应用容器不应挂载Docker套接字');
  const schema=Number(this.sql(database,'SELECT max(version) FROM workpivot_meta.schema_versions;'));
  if(schema<31)throw Error('本入口要求schema31及以上，旧版本需先按对应版本迁移');
  const storage=JSON.parse(run(['run','--rm','--network','none','--user','0','--mount',`type=volume,src=${volume.Name},dst=/data,readonly,volume-nocopy`,image,'node','-e',"const fs=require('fs'),p=require('path');let bytes=0;function walk(d){for(const n of fs.readdirSync(d)){const f=p.join(d,n),s=fs.lstatSync(f);if(s.isSymbolicLink())process.exit(1);if(s.isDirectory())walk(f);else bytes+=s.size;}}walk('/data');const f=fs.statfsSync('/data');console.log(JSON.stringify({bytes,free:f.bavail*f.bsize}));"]));
  const databaseBytes=Number(this.sql(database,'SELECT pg_database_size(current_database());')),required=3*(storage.bytes+databaseBytes)+1073741824;
  const host=statfsSync(existsSync(c.stateRoot)?c.stateRoot:dirname(c.stateRoot));if(storage.free<required||host.bavail*host.bsize<required)throw Error('磁盘余量不足以同时保存原数据、备份和隔离副本');
  this.idle(database);return {imageId:i.Id,server,env,database,volume:volume.Name,schema};
 }
 idle(database){const count=this.sql(database,"SELECT count(*) FROM (SELECT 1 FROM workpivot.task_runs WHERE status IN ('running','stopping') UNION ALL SELECT 1 FROM workpivot.tasks WHERE status IN ('running','waiting','queued') UNION ALL SELECT 1 FROM workpivot.automation_runs WHERE status IN ('queued','running') UNION ALL SELECT 1 FROM workpivot.skill_trials WHERE status='running' UNION ALL SELECT 1 FROM workpivot.document_processing WHERE status='running' UNION ALL SELECT 1 FROM workpivot.embedding_jobs WHERE status='running' UNION ALL SELECT 1 FROM workpivot.memory_jobs WHERE status='running' UNION ALL SELECT 1 FROM workpivot.expert_jobs WHERE status='running') x;");if(count!=='0')throw Error('仍有活动任务或后台作业，请等待或停止后重试');}
 fingerprint(database){const tables=this.sql(database,"SELECT schemaname||'.'||tablename FROM pg_tables WHERE schemaname IN ('identity','workpivot','workpivot_meta') ORDER BY 1;").split('\n').filter(Boolean);return hash(tables.map(t=>{if(!/^[a-z_]+\.[a-z_]+$/.test(t))throw Error('表名无效');return t+':'+this.sql(database,`SELECT encode(sha256(convert_to(coalesce(string_agg(h,',' ORDER BY h),''),'UTF8')),'hex') FROM (SELECT encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') h FROM ${t} t) s;`);}).join('\n'));}
 backup(state,dir){
  mkdirSync(dir,{recursive:true,mode:0o700});const dump=join(dir,'database.dump'),fd=openSync(dump,'wx',0o600);
  try{execFileSync('docker',['exec',this.cfg.databaseContainer,'pg_dump','-U',this.cfg.adminUser,'-d',state.database,'-Fc','--no-owner'],{stdio:['ignore',fd,'pipe'],timeout:300000});}catch{throw Error('数据库转储失败，凭据已隐藏');}finally{closeSync(fd);}
  run(['cp',state.server.Id+':/data/files',join(dir,'files')]);
  for(const [i,path] of [this.cfg.envFile,...(this.cfg.protectedFiles??[])].entries())writeFileSync(join(dir,'config-'+i),readFileSync(path),{mode:0o600});
  save(join(dir,'manifest.json'),{format:'workpivot-offline-release',schema:state.schema,database:state.database,volume:state.volume,image:state.server.Image,dump:hash(readFileSync(dump)),files:inventory(join(dir,'files'))});
 }
 clone(state,dir,image,database,volume){
  const manifest=JSON.parse(readFileSync(join(dir,'manifest.json'),'utf8'));
  if(hash(readFileSync(join(dir,'database.dump')))!==manifest.dump||JSON.stringify(inventory(join(dir,'files')))!==JSON.stringify(manifest.files))throw Error('发布备份哈希校验失败');
  if(this.sql('postgres',`SELECT count(*) FROM pg_database WHERE datname='${name(database)}';`)!=='0')throw Error('目标库已存在，拒绝覆盖');
  this.sql('postgres',`CREATE DATABASE ${name(database)};`);
  const input=openSync(join(dir,'database.dump'),'r');try{execFileSync('docker',['exec','-i',this.cfg.databaseContainer,'pg_restore','-U',this.cfg.adminUser,'-d',database,'--no-owner','--single-transaction','--exit-on-error'],{stdio:[input,'pipe','pipe'],timeout:300000});}catch{throw Error('隔离恢复失败，原库未修改');}finally{closeSync(input);}
  run(['volume','create','--label','workpivot.release='+database,volume]);
  run(['run','--rm','--network','none','--user','0','--mount',`type=bind,src=${join(dir,'files')},dst=/source,readonly`,'--mount',`type=volume,src=${volume},dst=/target,volume-nocopy`,image,'sh','-c','cp -a /source/. /target/']);
 }
 fileFingerprint(volume,image){return run(['run','--rm','--network','none','--user','0','--mount',`type=volume,src=${volume},dst=/data,readonly,volume-nocopy`,image,'node','-e',"const fs=require('fs'),p=require('path'),c=require('crypto'),h=c.createHash('sha256');function walk(d){for(const n of fs.readdirSync(d).sort()){const f=p.join(d,n),s=fs.lstatSync(f);if(s.isSymbolicLink())process.exit(1);if(s.isDirectory())walk(f);else{h.update(JSON.stringify([f.slice(6),s.size]));h.update(fs.readFileSync(f));}}}walk('/data');console.log(h.digest('hex')); "]).trim();}
 verify(image,dir,volume){run(['run','--rm','--network',this.cfg.network,'--env-file',join(dir,'schema.env'),'--mount',`type=volume,src=${volume},dst=/data/files,readonly,volume-nocopy`,image,'./node_modules/.bin/tsx','scripts/release-check.mts']);}
 envFile(env,path){if(Object.values(env).some(v=>/[\r\n]/.test(v)))throw Error('运行配置含多行值');writeFileSync(path,Object.entries(env).map(([k,v])=>k+'='+v).join('\n')+'\n',{mode:0o600});}
 migrate(state,image,database,dir){const dbEnv=environment(inspect(this.cfg.databaseContainer));const url=new URL(state.env.WORKPIVOT_DATABASE_URL);url.pathname='/'+database;url.username=this.cfg.adminUser;url.password=dbEnv.POSTGRES_PASSWORD;const path=join(dir,'schema.env');this.envFile({WORKPIVOT_DATABASE_ADMIN_URL:url.href},path);run(['run','--rm','--network',this.cfg.network,'--env-file',path,image,'./node_modules/.bin/tsx','scripts/postgres-schema.mts']);}
 overrideFor(state,image,database,volume){const environment={};for(const key of ['WORKPIVOT_DATABASE_URL','WORKPIVOT_AUTH_DATABASE_URL']){const u=new URL(state.env[key]);u.pathname='/'+database;environment[key]=u.href;}return {services:{server:{image,environment,volumes:[{type:'volume',source:'release_files',target:'/data/files'}]}},volumes:{release_files:{external:true,name:volume}}};}
 async health(){const id=this.server()?.Id;if(!id)throw Error('应用未启动');run(['exec',id,'node','-e',"(async()=>{for(const p of ['/api/health','/','/admin']){const r=await fetch('http://127.0.0.1:39800'+p);if(!r.ok)throw Error('health');}if((await fetch('http://127.0.0.1:39800/api/tasks')).status!==401)throw Error('auth');})().catch(()=>process.exit(1))"]);}
 async upgrade(image){return this.locked(async()=>{
  const state=this.preflight(image),id='r'+Date.now(),dir=join(this.cfg.stateRoot,id);image=state.imageId;mkdirSync(dir,{mode:0o700});
  const previous=JSON.stringify(this.overrideFor(state,state.server.Image,state.database,state.volume));save(join(dir,'previous.json'),{override:previous,active:existsSync(this.active)?JSON.parse(readFileSync(this.active,'utf8')):null});
  const database=name('wp_'+id),volume=this.cfg.project+'-'+id+'-files';let switched=false,started=false;
  const record={id,status:'preparing',image,state:{database:state.database,volume:state.volume,image:state.server.Image},database,volume};save(join(dir,'release.json'),record);
  run(['stop','-t','30',state.server.Id]);
  try{
   this.idle(state.database);this.backup(state,join(dir,'backup'));this.clone(state,join(dir,'backup'),image,database,volume);this.migrate(state,image,database,dir);this.verify(image,dir,volume);
   record.schema=Number(this.sql(database,'SELECT max(version) FROM workpivot_meta.schema_versions;'));record.baseline=this.fingerprint(database);record.filesBaseline=this.fileFingerprint(volume,image);record.status='migrated';save(join(dir,'release.json'),record);
   save(this.override,this.overrideFor(state,image,database,volume));switched=true;
   this.compose(['up','-d','--no-deps','--wait','--wait-timeout','90','server']);started=true;await this.health();record.status='active';save(join(dir,'release.json'),record);save(this.active,{id,directory:dir});console.log(JSON.stringify({status:'active',release:id,schema:record.schema,backup:join(dir,'backup')}));
  }catch(error){
   record.status='failed';save(join(dir,'release.json'),record);
   // 迁移前后均未修改原数据；新实例启动后可能写入，禁止无条件切回。
   if(!switched){run(['start',state.server.Id]);this.compose(['up','-d','--no-deps','--wait','--wait-timeout','90','server']);await this.health();}
   else {this.compose(['stop','server']);if(!started&&this.fingerprint(database)===record.baseline&&this.fileFingerprint(volume,image)===record.filesBaseline){if(previous)writeFileSync(this.override,previous,{mode:0o600});else unlinkSync(this.override);this.compose(['up','-d','--no-deps','--wait','--wait-timeout','90','server']);await this.health();}}
   throw error;
  }
 });}
 async rollback(){return this.locked(async()=>{
  if(!existsSync(this.active))throw Error('没有当前发布记录');const active=JSON.parse(readFileSync(this.active,'utf8')),dir=active.directory,record=JSON.parse(readFileSync(join(dir,'release.json'),'utf8'));
  const state=this.preflight(record.image);if(state.database!==record.database)throw Error('当前服务与发布记录不一致');
  const currentOverride=readFileSync(this.override,'utf8');
  run(['stop','-t','30',state.server.Id]);
  try{this.idle(state.database);this.backup(state,join(dir,'before-rollback-'+Date.now()));
   if(this.fingerprint(state.database)!==record.baseline||this.fileFingerprint(state.volume,record.image)!==record.filesBaseline)throw Error('升级后已有数据写入，拒绝直接回退；当前数据已备份，请使用隔离恢复及保留清单流程');
   const prior=JSON.parse(readFileSync(join(dir,'previous.json'),'utf8'));
   if(prior.override)writeFileSync(this.override,prior.override,{mode:0o600});else unlinkSync(this.override);
   this.compose(['up','-d','--no-deps','--wait','--wait-timeout','90','server']);await this.health();record.status='rolled-back';save(join(dir,'release.json'),record);if(prior.active)save(this.active,prior.active);else unlinkSync(this.active);console.log('已回退，升级库、文件及回退前备份保留');
  }catch(e){writeFileSync(this.override,currentOverride,{mode:0o600});this.compose(['up','-d','--no-deps','server']);throw e;}
 });}
 async install(image){return this.locked(async()=>{
  if(this.server())throw Error('已有应用容器，请使用upgrade');
  image=JSON.parse(run(['image','inspect',image]))[0].Id;for(const path of [this.cfg.envFile,...(this.cfg.protectedFiles??[])])if(statSync(path).mode&0o077)throw Error('受保护配置权限必须为0600');
  const env=parseEnv(readFileSync(this.cfg.envFile,'utf8'));for(const key of ['DATABASE_APP_PASSWORD','DATABASE_AUTH_PASSWORD','DATABASE_ADMIN_PASSWORD','WORKPIVOT_ADMIN_INIT_TOKEN','WORKPIVOT_SECRET_KEY'])if(!env[key]||env[key].length<(key==='WORKPIVOT_SECRET_KEY'?32:24))throw Error('首次安装配置缺失或过短：'+key);
  this.compose(['up','-d','--wait','database']);const database=name(this.cfg.initialDatabase??'workpivot');
  if(this.sql(database,"SELECT count(*) FROM pg_namespace WHERE nspname IN ('identity','workpivot','workpivot_meta');")!=='0')throw Error('首次安装要求空库，已有数据不改动');
  for(const [role,key] of [['workpivot_app','DATABASE_APP_PASSWORD'],['workpivot_auth','DATABASE_AUTH_PASSWORD']]){const password=env[key].replaceAll("'","''");if(this.sql('postgres',`SELECT count(*) FROM pg_roles WHERE rolname='${role}';`)!=='0')throw Error('运行角色已存在，拒绝重新设置凭据');this.sql('postgres',`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;`);}
  const state={env:{WORKPIVOT_DATABASE_URL:`postgresql://workpivot_app:${encodeURIComponent(env.DATABASE_APP_PASSWORD)}@database:5432/${database}`}};
  this.migrate(state,image,database,this.cfg.stateRoot);save(this.override,{services:{server:{image}}});this.compose(['run','--rm','--no-deps','--user','0','--cap-add','CHOWN','--entrypoint','node','server','-e',"const fs=require('fs');fs.mkdirSync('/data/files',{recursive:true});if(fs.readdirSync('/data/files').length)throw Error('首次安装文件卷必须为空');fs.chownSync('/data/files',1000,1000);fs.chmodSync('/data/files',0o700);"]);this.compose(['up','-d','--wait','--wait-timeout','90']);await this.health();console.log('首次安装完成；请使用受保护初始化令牌创建首个管理员');
 });}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{const [command,config,image]=process.argv.slice(2);if(!config)throw Error('用法：release-local.mjs preflight|install|upgrade|rollback|start|status <配置JSON> [镜像]');const release=new LocalRelease(config);if(command==='preflight'){const r=release.preflight(image);console.log(JSON.stringify({schema:r.schema,database:r.database,volume:r.volume,image:r.imageId}));}else if(command==='upgrade')await release.upgrade(image);else if(command==='install')await release.install(image);else if(command==='rollback')await release.rollback();else if(command==='start')release.compose(['up','-d','--wait','server']);else if(command==='status')console.log(release.compose(['ps']));else throw Error('未知发布命令');}catch(e){console.error(e.message);process.exitCode=1;}}
