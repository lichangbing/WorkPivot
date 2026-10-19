// 独立身份实验环境，不连接WorkPivot业务数据库，不将测试凭据输出到终端。
import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,existsSync,chmodSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {pathToFileURL} from 'node:url';
export const labRoot=resolve(import.meta.dirname,'../../local-runtime/iam-lab');
export const image='quay.io/keycloak/keycloak:26.8.0';
const name='workpivot-iam-lab',label='workpivot.iam-lab';
function docker(args){try{return execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:180000}).trim();}catch{throw Error('身份实验容器操作失败；请检查Docker、镜像及本地端口，底层输出未回显');}}
function owned(){const found=docker(['ps','-a','--filter','name=^/'+name+'$','--format','{{.Names}}']);if(!found)return false;const value=docker(['inspect','--format','{{index .Config.Labels "'+label+'"}}',name]);if(value!=='local-test')throw Error('同名容器不属于身份实验，拒绝操作');return true;}
async function ready(){
 for(let i=0;i<90;i++){if(i%5===0&&docker(['inspect','--format','{{.State.Running}}',name])!=='true')throw Error('身份实验容器已退出，请检查后执行stop再重建');try{const response=await fetch('http://127.0.0.1:40190/realms/wp-lab-a/.well-known/openid-configuration',{signal:AbortSignal.timeout(1000)});if(response.ok)return {status:'ready',issuer:'http://127.0.0.1:40190/realms/wp-lab-a',secondIssuer:'http://127.0.0.1:40190/realms/wp-lab-b',credentials:join(labRoot,'credentials.json')};}catch{/* 启动期间只等待就绪，不输出令牌或导入内容。 */}await new Promise(r=>setTimeout(r,1000));}
 throw Error('身份实验环境尚未就绪；保留容器供检查，可用stop清理后重试');
}
export async function lab(action){
 if(action==='stop'){if(owned())docker(['rm','-f',name]);return {status:'stopped',credentials:join(labRoot,'credentials.json')};}
 if(action==='status')return {status:owned()?docker(['inspect','--format','{{.State.Status}}',name]):'absent',issuer:'http://127.0.0.1:40190/realms/wp-lab-a'};
 if(action!=='start')throw Error('用法：node scripts/iam-lab.mjs start|status|stop');
 if(owned())return ready();
 mkdirSync(labRoot,{recursive:true,mode:0o700});chmodSync(labRoot,0o700);
 const file=join(labRoot,'credentials.json'),secret=()=>randomBytes(24).toString('base64url');
 let credentials;
 if(existsSync(file)){try{credentials=JSON.parse(readFileSync(file,'utf8'));}catch{throw Error('本地实验凭据文件不可读取或不是有效JSON，未回显内容');}}
 else{credentials={admin:'lab-admin',adminPassword:secret(),username:'member',password:secret(),clientId:'workpivot-lab',clientSecret:secret()};writeFileSync(file,JSON.stringify(credentials,null,2)+'\n',{mode:0o600});}
 chmodSync(file,0o600);
 for(const key of ['admin','adminPassword','username','password','clientId','clientSecret'])if(typeof credentials[key]!=='string'||!/^[-A-Za-z0-9_]+$/.test(credentials[key]))throw Error('本地实验凭据文件格式无效');
 const imports=join(labRoot,'import');mkdirSync(imports,{recursive:true,mode:0o700});
 for(const realm of ['wp-lab-a','wp-lab-b'])writeFileSync(join(imports,realm+'-realm.json'),JSON.stringify({realm,enabled:true,sslRequired:'none',registrationAllowed:false,resetPasswordAllowed:false,loginWithEmailAllowed:false,clients:[{clientId:credentials.clientId,secret:credentials.clientSecret,enabled:true,protocol:'openid-connect',publicClient:false,standardFlowEnabled:true,implicitFlowEnabled:false,directAccessGrantsEnabled:false,serviceAccountsEnabled:false,redirectUris:['http://127.0.0.1:40191/callback'],webOrigins:[],attributes:{'pkce.code.challenge.method':'S256'}}],users:[{id:realm==='wp-lab-a'?'11111111-1111-4111-8111-111111111111':'22222222-2222-4222-8222-222222222222',username:credentials.username,enabled:true,email:'synthetic@example.invalid',emailVerified:true,firstName:'Synthetic',lastName:'Member',credentials:[{type:'password',value:credentials.password,temporary:false}]}]}),{mode:0o600});
 const env=join(labRoot,'keycloak.env');writeFileSync(env,'KC_BOOTSTRAP_ADMIN_USERNAME='+credentials.admin+'\nKC_BOOTSTRAP_ADMIN_PASSWORD='+credentials.adminPassword+'\n',{mode:0o600});
 docker(['image','inspect',image]);
 docker(['run','-d','--name',name,'--label',label+'=local-test','--publish','127.0.0.1:40190:8080','--memory','1g','--cpus','2','--pids-limit','512','--env-file',env,'--mount','type=bind,src='+imports+',dst=/opt/keycloak/data/import,readonly','--tmpfs','/opt/keycloak/data:rw,size=256m,uid=1000,gid=0',image,'start-dev','--import-realm']);
 return ready();
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)try{console.log(JSON.stringify(await lab(process.argv[2])));}catch(error){console.error(error.message);process.exitCode=1;}
