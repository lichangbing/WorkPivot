import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync,readFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {LocalRelease} from '../scripts/release-local.mjs';
const image=process.env.WORKPIVOT_TEST_RELEASE_IMAGE??'workpivot-server:local-schema49-20261019';
const expectedSchema=Number(process.env.WORKPIVOT_TEST_RELEASE_SCHEMA??49);
const old=process.env.WORKPIVOT_TEST_OLD_IMAGE??'workpivot-server:local-strict-url-20261018';
const oldSchema=Number(process.env.WORKPIVOT_TEST_OLD_SCHEMA??38);
const project='wp-release-test-'+Date.now(),root=mkdtempSync(join(tmpdir(),'wp-release-')),envFile=join(root,'runtime.env'),compose=join(root,'compose.json'),config=join(root,'config.json');
const secret=randomBytes(32).toString('hex');let checks=0;const check=(v,n)=>{assert.ok(v,n);checks++;console.log('通过：'+n);};
const docker=args=>execFileSync('docker',args,{encoding:'utf8',timeout:180000,stdio:['ignore','pipe','pipe']});
writeFileSync(envFile,['DATABASE_ADMIN_PASSWORD','DATABASE_APP_PASSWORD','DATABASE_AUTH_PASSWORD','WORKPIVOT_ADMIN_INIT_TOKEN','WORKPIVOT_SECRET_KEY'].map(k=>k+'='+secret).join('\n'),{mode:0o600});
writeFileSync(compose,JSON.stringify({services:{database:{image:'pgvector/pgvector:pg16',environment:{POSTGRES_PASSWORD:secret,POSTGRES_USER:'workpivot_schema',POSTGRES_DB:'workpivot'},tmpfs:['/var/lib/postgresql/data'],healthcheck:{test:['CMD-SHELL','pg_isready -U workpivot_schema -d workpivot'],interval:'1s',timeout:'2s',retries:30}},server:{image:old,depends_on:{database:{condition:'service_healthy'}},environment:{WORKPIVOT_DATABASE_URL:`postgresql://workpivot_app:${secret}@database:5432/workpivot`,WORKPIVOT_AUTH_DATABASE_URL:`postgresql://workpivot_auth:${secret}@database:5432/workpivot`,WORKPIVOT_ADMIN_INIT_TOKEN:secret,WORKPIVOT_SECRET_KEY:secret,WORKPIVOT_DATABASE_FILES_ROOT:'/data/files'},volumes:['files:/data/files'],healthcheck:{test:['CMD','node','-e',"fetch('http://localhost:39800/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"],interval:'1s',timeout:'3s',retries:30}}},volumes:{files:{}}}),{mode:0o600});
writeFileSync(config,JSON.stringify({compose,envFile,stateRoot:join(root,'releases'),project,databaseContainer:project+'-database-1',adminUser:'workpivot_schema',network:project+'_default'}));
const release=new LocalRelease(config);
try{
 await release.install(old);check(release.preflight(image).schema===oldSchema,'空库安装指定源版本，就绪检查通过');
 const seed=JSON.parse(docker(['exec',release.server().Id,'node','-e',`(async()=>{const base='http://127.0.0.1:39800';const r=await fetch(base+'/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'release-test',password:'Synthetic-Test-2026!',initToken:process.env.WORKPIVOT_ADMIN_INIT_TOKEN})});const a=await r.json();if(!r.ok)throw Error('register '+r.status+' '+a.error);const t=await fetch(base+'/api/tasks',{method:'POST',headers:{'Content-Type':'application/json',authorization:'Bearer '+a.token},body:JSON.stringify({name:'升级合成任务'})});const taskResponse=await t.json();if(!t.ok)throw Error('task '+t.status+' '+taskResponse.error);const task=taskResponse.task;const f=await fetch(base+'/api/tasks/'+task.id+'/files?name=fixture.txt&requestId='+require('crypto').randomUUID(),{method:'POST',headers:{'Content-Type':'application/octet-stream',authorization:'Bearer '+a.token},body:'升级原件'});if(!f.ok)throw Error('upload '+f.status+' '+(await f.text()));console.log(JSON.stringify({ok:true}));})().catch(e=>{console.error(e.message);process.exit(1);});`]));check(seed.ok,'安装后真实认证接口可创建合成任务和原件');
 for(let i=0;i<30;i++){try{release.idle('workpivot');break;}catch(e){if(i===29)throw e;await new Promise(r=>setTimeout(r,200));}}
 await assert.rejects(release.install(old));check(true,'重复安装拒绝覆盖现有实例');
 const migrate=release.migrate;release.migrate=()=>{throw Error('合成迁移失败');};try{await assert.rejects(release.upgrade(image),/合成迁移失败/);}finally{release.migrate=migrate;}await release.health();check(release.preflight(old).schema===oldSchema,'副本迁移失败时恢复原服务，原库不变');
 await release.upgrade(image);let active=JSON.parse(readFileSync(release.active)),record=JSON.parse(readFileSync(join(active.directory,'release.json')));
 check(record.schema===expectedSchema&&record.status==='active','源版本副本迁移至候选版本并切换');
 check(release.sql(record.database,'SELECT count(*) FROM workpivot.document_versions;')==='1','新库保留原件版本，切换前已验证实际文件哈希');
 check(release.sql('workpivot','SELECT max(version) FROM workpivot_meta.schema_versions;')===String(oldSchema),'原数据库保持源版本未被迁移');
 check(readdirSync(join(active.directory,'backup')).includes('database.dump'),'发布记录保留停写转储和受保护配置');
 const dump=join(active.directory,'backup/database.dump'),bytes=readFileSync(dump);writeFileSync(dump,'synthetic damage');assert.throws(()=>release.clone(release.preflight(image),join(active.directory,'backup'),image,'wp_tamper_test',project+'-tamper'),/哈希/);writeFileSync(dump,bytes);check(true,'损坏备份在创建目标库前拒绝');
 await release.rollback();check(release.preflight(old).schema===oldSchema,'无后续写入时可回退原库与旧镜像');
 await release.upgrade(image);active=JSON.parse(readFileSync(release.active));record=JSON.parse(readFileSync(join(active.directory,'release.json')));
 // 有效人工租约阻止发布，过期租约不永久阻塞；所有数据均属于隔离测试项目。
 release.sql(record.database,"INSERT INTO workpivot.browser_profiles(owner_user_id,name,login_url,urls,lease_id,lease_kind,lease_until) SELECT id,'合成接管','https://example.com/','[\"https://example.com/\"]'::jsonb,gen_random_uuid(),'manual',now()+interval '10 minutes' FROM identity.users LIMIT 1;");
 assert.throws(()=>release.idle(record.database),/网页登录租约/);check(true,'有效网页登录租约阻止升级和回退');
 release.sql(record.database,"UPDATE workpivot.browser_profiles SET lease_until=now()-interval '1 second';");release.idle(record.database);check(true,'过期登录租约不永久阻塞发布');
 const authProbe=docker(['exec',release.server().Id,'node','-e',"fetch('http://127.0.0.1:39800/api/tasks').then(r=>{if(r.status!==401)process.exit(1)})"]);check(authProbe==='', '候选受保护接口拒绝匿名访问');
 release.sql(record.database,"CREATE TABLE workpivot.release_test_marker(id integer); INSERT INTO workpivot.release_test_marker VALUES(1);");
 await assert.rejects(release.rollback(),/已有数据写入/);check(release.preflight(image).schema===expectedSchema,'升级后有写入拒绝回退且恢复当前服务');
 check(release.sql(record.database,'SELECT count(*) FROM workpivot.release_test_marker;')==='1','拒绝回退后新数据保留');
 writeFileSync(join(release.cfg.stateRoot,'release.lock'),'synthetic');await assert.rejects(release.upgrade(image),/发布锁/);check(true,'并行发布锁阻止重复执行');
 console.log('单机发布验收：'+checks+'项通过');
}finally{
 // 仅清理名称属于本次一次性项目的容器、卷和网络，不接触业务部署。
 try{release.compose(['down','-v']);}catch{/* 异常时继续按唯一项目前缀检查残留卷。 */}
 for(const volume of docker(['volume','ls','--format','{{.Name}}']).trim().split('\n'))if(volume.startsWith(project+'-')||volume.startsWith(project+'_'))docker(['volume','rm',volume]);
 rmSync(root,{recursive:true,force:true});
}
