import {readFile,writeFile} from 'node:fs/promises';
import {pool} from '../packages/server/src/database/connection.js';
import {exportRetention,applyRetention,type RetentionState} from '../packages/server/src/database/restore-retention.js';
const mode=process.argv[2],path=process.argv[3],url=process.env.WORKPIVOT_DATABASE_ADMIN_URL;
if(!path||!url||!['export','apply'].includes(mode??''))throw Error('Usage: restore-retention.mts export|apply protected-manifest.json');
if(mode==='apply'&&(!/_restor(?:ed|e_test)$/.test(new URL(url).pathname)||process.env.WORKPIVOT_OFFLINE_RESTORE!=='1'||!process.env.WORKPIVOT_DATABASE_FILES_ROOT))throw Error('Only an offline *_restored or *_restore_test database and its independent file copy may be reconciled');
const db=pool(url);
const appUrl=process.env.WORKPIVOT_DATABASE_URL;
if(!appUrl||['hostname','port','pathname'].some(k=>new URL(appUrl)[k as 'hostname']!==new URL(url)[k as 'hostname']))throw Error('Restricted application connection must address the same offline database');
const app=pool(appUrl);
try{
 if(mode==='export'){
  const owners=(await db.query('SELECT id FROM identity.users')).rows;const users:RetentionState[]=[];
  for(const owner of owners)users.push(await exportRetention(app,owner.id));
  await writeFile(path,JSON.stringify({format:1,complete:true,createdAt:new Date().toISOString(),users}),{mode:0o600,flag:'wx'});
  console.log('Content-free retention inventory exported; store securely apart from old backups');
 }else{
  const manifest=JSON.parse(await readFile(path,'utf8'));
  if(manifest.format!==1||manifest.complete!==true||!Array.isArray(manifest.users)||!Number.isFinite(Date.parse(manifest.createdAt)))throw Error('Invalid complete inventory');
  const users=manifest.users as RetentionState[];
  await db.query('UPDATE identity.sessions SET revoked_at=now() WHERE revoked_at IS NULL');
  for(const owner of (await db.query('SELECT id FROM identity.users')).rows){
   const state=users.find(s=>s.actor===owner.id)??{actor:owner.id,projects:[],tasks:[],documents:[],memories:[],experts:[],experiences:[]};
   await applyRetention(app,process.env.WORKPIVOT_DATABASE_FILES_ROOT!,state);
   if(!users.some(s=>s.actor===owner.id))await db.query('UPDATE identity.users SET disabled=true WHERE id=$1',[owner.id]);
  }
  console.log('Deletion inventory replayed; stale contexts revoked. Validate offline before starting any service.');
 }
}finally{await Promise.all([db.end(),app.end()]);}
