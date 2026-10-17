import {randomBytes,randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {pool,installSchema} from '../packages/server/src/database/connection.js';
import {AccountRepository} from '../packages/server/src/database/accounts.js';
import {WorkspaceRepository} from '../packages/server/src/database/workspace.js';
import {UsageRepository} from '../packages/server/src/database/usage.js';
import {ProviderRepository} from '../packages/server/src/database/providers.js';
import {createDatabaseApp} from '../packages/server/src/database/app.js';
if(process.env.WORKPIVOT_TEST_PG_DISPOSABLE!=='1')throw Error('仅允许一次性数据库');
const target=process.env.WORKPIVOT_TEST_PG_URL!,secret=randomBytes(32).toString('hex');
const schema=pool(target);await schema.query(`CREATE ROLE usage_app LOGIN PASSWORD '${secret}' NOSUPERUSER NOBYPASSRLS;CREATE ROLE usage_auth LOGIN PASSWORD '${secret}' NOSUPERUSER NOBYPASSRLS;`);await installSchema(schema,'usage_app','usage_auth');
const url=(role:string)=>{const u=new URL(target);u.username=role;u.password=secret;return u.toString();};
const db=pool(url('usage_app')),auth=pool(url('usage_auth')),accounts=new AccountRepository(auth);
const actor=(await accounts.registerFirst('usage-test','Usage-Test-2026!',secret,secret)).user.id;
const workspace=new WorkspaceRepository(db),usage=new UsageRepository(db),task=await workspace.createTask(actor,'用量验收（合成资料）');
for(const currency of ['CNY','USD']){
 const client=usage.wrap(actor,{providerId:randomUUID(),model:'用量夹具',async *streamChat(){yield {type:'delta',text:'合成回复'};yield {type:'usage',inputTokens:1000,outputTokens:200};}},{inputPrice:'2',outputPrice:'6',currency},{taskId:task.id});
 for await(const event of client.streamChat([],[])){void event;}
}
await usage.budget(actor,'CNY','0.001',0);
const providers=new ProviderRepository(db,secret);await providers.save(actor,{name:'配置验收模型',baseUrl:'http://127.0.0.1:1',modelId:'fixture',protocol:'openai',inputPrice:'2',outputPrice:'6',currency:'CNY'});
const app=await createDatabaseApp(auth,db,secret,undefined,providers,undefined,resolve('apps/web/dist'));
app.post('/fixture/stop',async(req,res)=>{const token=req.headers.authorization?.slice(7)??'';if(!await accounts.resolve(token)){res.status(401).end();return;}res.json({ok:true});setTimeout(()=>void close(),100);});
const server=app.listen(39990,'127.0.0.1',()=>console.log('用量验收 http://127.0.0.1:39990；usage-test / Usage-Test-2026!；不连接真实模型'));
let closing=false;async function close(){if(closing)return;closing=true;server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await Promise.all([db.end(),auth.end(),schema.end()]);}
setTimeout(()=>void close(),900000).unref();process.on('SIGINT',()=>void close());process.on('SIGTERM',()=>void close());
