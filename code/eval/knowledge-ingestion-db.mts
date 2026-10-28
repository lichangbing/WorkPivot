/** 隔离 PostgreSQL 专项：知识确认、解析重建、来源失效、版本删除与范围检索。 */
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {pool,installSchema,transaction} from '../packages/server/src/database/connection.js';
import {AccountRepository} from '../packages/server/src/database/accounts.js';
import {WorkspaceRepository} from '../packages/server/src/database/workspace.js';
import {FileRepository} from '../packages/server/src/database/files.js';
import {KnowledgeRepository} from '../packages/server/src/database/knowledge.js';
import {parserFingerprint} from '../packages/server/src/database/document-parser.js';
import {createDatabaseApp} from '../packages/server/src/database/app.js';
import {testKnowledge} from './database-knowledge.mts';
import {testParsing} from './database-parsing.mts';
import {testResourceScope} from './resource-scope.mts';
import {testFiles} from './database-files.mts';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const url=process.env['WORKPIVOT_TEST_PG_URL'];
if(!url||process.env['WORKPIVOT_TEST_PG_DISPOSABLE']!=='1'||!new URL(url).pathname.startsWith('/knowledge_test'))throw Error('仅允许一次性 workpivot 知识测试数据库');
const password=randomBytes(24).toString('hex'),suffix=randomBytes(5).toString('hex');
const appRole='knowledge_app_'+suffix,authRole='knowledge_auth_'+suffix;
const admin=pool(url);
await admin.query(`CREATE ROLE ${appRole} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  CREATE ROLE ${authRole} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
const appUrl=new URL(url);appUrl.username=appRole;appUrl.password=password;
const authUrl=new URL(url);authUrl.username=authRole;authUrl.password=password;
const db=pool(appUrl.toString(),{max:3}),identity=pool(authUrl.toString(),{max:2});
let checks=0;
const check=(value:unknown,label:string)=>{assert.ok(value,label);checks++;console.log('通过：'+label);};
try{
  await installSchema(admin,appRole,authRole);
  const accounts=new AccountRepository(identity);
  const owner=await accounts.registerFirst('knowledge-owner',password);
  const foreign=(await accounts.createUser(owner.token,'knowledge-foreign',password,'member')).id;
  await testKnowledge(db,owner.user.id,foreign,check);
  await testParsing(db,owner.user.id,foreign,check);
  await testResourceScope(db,owner.user.id,foreign,check);
  await testFiles(db,identity,owner.user.id,foreign,owner.token,password,check);
  const root=await mkdtemp(join(tmpdir(),'wp-knowledge-api-')),files=new FileRepository(db,root),workspace=new WorkspaceRepository(db);
  try{
    const project=await workspace.createProject(owner.user.id,'知识接口项目');
    const task=await workspace.createTask(owner.user.id,'知识接口任务',project.id);
    const file=await files.upload(owner.user.id,task.id,'合成知识接口.txt',Buffer.from('synthetic'),randomUUID());
    await transaction(db,c=>c.query("INSERT INTO workpivot.document_processing(version_id,owner_user_id,status,parts,parser_fingerprint) VALUES($1,$2,'completed',$3,$4) ON CONFLICT(version_id) DO UPDATE SET status='completed',parts=EXCLUDED.parts,parser_fingerprint=EXCLUDED.parser_fingerprint",[file.id,owner.user.id,JSON.stringify([{location:'第1页',text:'合成接口确认内容'}]),parserFingerprint]),owner.user.id);
    const server=(await createDatabaseApp(identity,db,password,undefined,undefined,undefined,undefined,files)).listen(0,'127.0.0.1');
    await new Promise<void>(resolve=>server.once('listening',resolve));
    try{
      const address=server.address();if(!address||typeof address==='string')throw Error('知识接口未监听');
      const headers={Authorization:'Bearer '+owner.token,'Content-Type':'application/json'};
      const base=`http://127.0.0.1:${address.port}/api/tasks/${task.id}`;
      const pageResponse=await fetch(`${base}/knowledge-ingestions/${file.id}`,{headers});
      const pageText=await pageResponse.text();
      if(!pageResponse.ok)throw Error(`知识候选 HTTP ${pageResponse.status}: ${pageText}`);
      const page=JSON.parse(pageText) as {revision:number;status:string;candidates:Array<{ordinal:number}>};
      check(pageResponse.ok&&page.status==='pending'&&page.candidates.length===1,'知识候选 HTTP 接口返回待确认版本');
      const confirmResponse=await fetch(`${base}/knowledge-ingestions/${file.id}/confirm`,{method:'POST',headers,body:JSON.stringify({revision:page.revision,selected:[page.candidates[0]!.ordinal]})});
      check(confirmResponse.ok&&(await confirmResponse.json() as {status:string}).status==='confirmed','知识确认 HTTP 接口只发布用户选择');
      check((await new KnowledgeRepository(db).search(owner.user.id,task.id,'接口确认')).matches.length===1,'确认后的候选进入项目检索');
      const deleteResponse=await fetch(`${base}/files/${file.documentId}/versions/${file.id}`,{method:'DELETE',headers,body:JSON.stringify({confirmation:'删除此版本'})});
      check(deleteResponse.ok&&(await deleteResponse.json() as {cleanupPending:boolean}).cleanupPending===false,'单版本删除 HTTP 接口清除原件和知识');
      check((await new KnowledgeRepository(db).search(owner.user.id,task.id,'接口确认')).matches.length===0,'HTTP 删除后知识立即零召回');
    }finally{
      server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
    }
  }finally{
    await rm(root,{recursive:true,force:true});
  }
  console.log(`知识入库专项：${checks} 项通过`);
}finally{
  await Promise.all([db.end(),identity.end(),admin.end()]);
}
