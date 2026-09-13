import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = mkdtempSync(join(tmpdir(), 'wp29-'));
process.env['WORKPIVOT_HOME'] = join(root, 'home');
process.env['WORKPIVOT_WORKSPACE'] = join(root, 'workspace');
process.env['WORKPIVOT_HOST'] = '127.0.0.1';
process.env['WORKPIVOT_INSECURE_SECRETS'] = '1';
process.env['WORKPIVOT_EXECUTION_MODE'] = 'disabled';
process.env['WORKPIVOT_MAX_PARALLEL'] = '1';
process.env['NODE_ENV'] = 'test';
const { withTenant, withAccount } = await import('../packages/server/src/tenants.js');
const auth = await import('../packages/server/src/auth.js');
const { createApp } = await import('../packages/server/src/app.js');
const { initializeSecretBox } = await import('../packages/server/src/secret.js');
const admin = withTenant('default', () => auth.registerFirstAdmin('workflow-admin', 'fixture-password'));
const member = withTenant('default', () => { auth.createUser('workflow-member', 'fixture-password', 'member'); return auth.login('workflow-member', 'fixture-password'); });
initializeSecretBox();

const {listSkills} = await import('../packages/server/src/skills.js');
const {workspaceRoot} = await import('../packages/server/src/tasks.js');
const {buildSkillTools} = await import('../packages/server/src/skill-tools.js');
const other = withTenant('default', () => { auth.createUser('other-admin', 'fixture-password', 'admin'); return auth.login('other-admin','fixture-password'); });
const server = createApp().listen(0,'127.0.0.1'); await new Promise<void>(r=>server.once('listening',r));
const address=server.address(); if(!address || typeof address==='string') throw Error('port');
const request=(path:string,token=admin.token,method='GET',body?:unknown)=>fetch('http://127.0.0.1:'+address.port+'/api'+path,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
let count=0; function check(name:string,value:unknown):void {assert.ok(value,name);count++;console.log('✅ '+name);}
try {
 const initial=await (await request('/skills/docx-report')).json();
 check('admin reads editable instructions',initial.content.includes('name: docx-report') && initial.revision);
 check('member cannot read editor',(await request('/skills/docx-report',member.token)).status===403);
 const content=initial.content+'\nPersonal research instructions\n';
 check('save instructions',(await request('/skills/docx-report',admin.token,'PUT',{content,revision:initial.revision})).status===200);
 check('conflicting save rejected',(await request('/skills/docx-report',admin.token,'PUT',{content,revision:initial.revision})).status===409);
 const edited=await (await request('/skills/docx-report')).json();
 check('edits persisted',edited.content===content);
 check('other admin unchanged',(await (await request('/skills/docx-report',other.token)).json()).content===initial.content);
 const discovered=withAccount(admin.user,()=>listSkills(workspaceRoot()).find(s=>s.name==='docx-report'));
 check('runtime discovery uses edit',discovered?.content===content);
 const loaded = await withAccount(admin.user, async () => {
   const tool = buildSkillTools(() => listSkills(workspaceRoot()), () => true)[0]!;
   return JSON.parse(await tool.run({name:'docx-report'}, {taskDir:workspaceRoot()}));
 });
 check('model loads edited instructions', loaded.content === content);
 check('invalid frontmatter rejected',(await request('/skills/docx-report',admin.token,'PUT',{content:'invalid',revision:edited.revision})).status===400);
 check('name change rejected',(await request('/skills/docx-report',admin.token,'PUT',{content:content.replace('name: docx-report','name: other'),revision:edited.revision})).status===400);
 check('member cannot edit',(await request('/skills/docx-report',member.token,'PUT',{content,revision:edited.revision})).status===403);
 check('invalid toggle rejected',(await request('/skills/toggle',admin.token,'POST',{name:'docx-report',disabled:'false'})).status===400);
 check('unknown toggle rejected',(await request('/skills/toggle',admin.token,'POST',{name:'absent',disabled:true})).status===404);
 check('disable succeeds',(await request('/skills/toggle',admin.token,'POST',{name:'docx-report',disabled:true})).status===200);
 check('disabled absent from runtime',withAccount(admin.user,()=>!listSkills(workspaceRoot()).some(s=>s.name==='docx-report')));
 check('disabled still editable',(await request('/skills/docx-report')).status===200);
 check('other account still enabled',withAccount(other.user,()=>listSkills(workspaceRoot()).some(s=>s.name==='docx-report')));
 check('enable succeeds',(await request('/skills/toggle',admin.token,'POST',{name:'docx-report',disabled:false})).status===200);
 check('edit survives toggle',withAccount(admin.user,()=>listSkills(workspaceRoot()).find(s=>s.name==='docx-report')?.content===content));
 console.log('W29 '+count+'/'+count+' passed');
} finally {server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
