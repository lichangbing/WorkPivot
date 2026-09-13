import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const root=mkdtempSync(join(tmpdir(),'wp33-'));
Object.assign(process.env,{WORKPIVOT_HOME:join(root,'home'),WORKPIVOT_WORKSPACE:join(root,'workspace'),WORKPIVOT_INSECURE_SECRETS:'1',WORKPIVOT_HOST:'127.0.0.1'});
const {registerFirstAdmin,setUserTier}=await import('../packages/server/src/auth.js');
const {withAccount}=await import('../packages/server/src/tenants.js');
const {ensureWorkpivotDir}=await import('../packages/server/src/store.js');
const {workspaceRoot}=await import('../packages/server/src/tasks.js');
const {getTier,evaluateAccess,resolvePendingRequest}=await import('../packages/server/src/permissions.js');
const {createApp}=await import('../packages/server/src/app.js');
const account=registerFirstAdmin('matrix-admin','fixture-password');let count=0;
function check(name:string,pass:unknown){assert.ok(pass,name);count++;console.log('✅ '+name);}
await withAccount(account.user,async()=>{
 check('new account defaults to auto',getTier(account.user.id)==='auto');
 for(const [old,expected] of [['readonly','ask'],['workdir','auto'],['ask','ask'],['auto','auto']] as const){setUserTier(account.user.id,old);check('stored personal mode '+old+' normalizes',getTier(account.user.id)===expected);}
 setUserTier(account.user.id,null);
 writeFileSync(join(ensureWorkpivotDir('config'),'settings.json'),JSON.stringify({version:1,permissionTier:'readonly'}));check('legacy default normalizes',getTier()==='ask');
 for(const mode of ['ask','auto'] as const){
  setUserTier(account.user.id,mode);
  for(const kind of ['read','write','bash','danger','external','outside'] as const){
   let prompted=false;const taskId=mode+'-'+kind;
   const result=await evaluateAccess({tool:'fixture',kind:['danger','outside'].includes(kind)?'bash':kind==='external'?'write':kind as 'read'|'write'|'bash',external:kind==='external',paths:kind==='read'||kind==='write'?[{path:join(workspaceRoot(),'file'),mode:kind}]:[],command:kind==='danger'?'git reset --hard':kind==='outside'?'cat /outside/file':kind==='bash'?'echo hello':undefined,taskDir:workspaceRoot(),taskId,userId:account.user.id},req=>{prompted=true;check(mode+' '+kind+' once scope',req.scope==='once');resolvePendingRequest(req.id,'deny',{taskId,userId:account.user.id,role:'admin'});});
   const expected=kind==='danger'||kind==='external'||(mode==='ask'&&kind!=='read');
   check(mode+' '+kind+' permission behavior',prompted===expected&&result.allowed===!expected);
  }
 }
});
const server=createApp().listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));const addr=server.address();if(!addr||typeof addr==='string')throw Error('port');
const api=(body?:unknown)=>fetch('http://127.0.0.1:'+addr.port+'/api/me/tier',{method:body?'PUT':'GET',headers:{authorization:'Bearer '+account.token,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
try{
 const settings=await(await api()).json();check('API exposes exactly two modes',Object.keys(settings.tierLabels).sort().join(',')==='ask,auto');
 for(const tier of ['readonly','workdir','toString','invalid'])check('API rejects obsolete or invalid mode '+tier,(await api({tier})).status===400);
 for(const tier of ['ask','auto'])check('API accepts '+tier,(await(await api({tier})).json()).tier===tier);
}finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
console.log('W33 '+count+'/'+count+' passed');