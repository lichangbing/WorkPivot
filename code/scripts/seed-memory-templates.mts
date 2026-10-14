import {randomUUID} from 'node:crypto';
import {pool,transaction} from '../packages/server/src/database/connection.js';
import {defaultMemoryTemplates} from '../packages/server/src/database/default-memory-templates.js';
const db=pool(process.env.WORKPIVOT_DATABASE_URL!),auth=pool(process.env.WORKPIVOT_AUTH_DATABASE_URL!);
try{
 const admins=(await auth.query("SELECT id,username FROM identity.users WHERE role='admin' AND NOT disabled ORDER BY username")).rows;
 const selected=process.env.WORKPIVOT_TEMPLATE_ADMIN?admins.find(a=>a.username===process.env.WORKPIVOT_TEMPLATE_ADMIN):admins.length===1?admins[0]:admins.find(a=>a.username==='admin');
 if(!selected)throw Error('请明确指定模板管理员');
 const result=await transaction(db,async c=>{
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['default-memory-templates:'+selected.id]);
  const result=[];
  for(const template of defaultMemoryTemplates){
   const existing=(await c.query('SELECT id FROM workpivot.memory_templates WHERE owner_user_id=$1 AND name=$2 AND scope=$3',[selected.id,template.name,template.scope])).rows[0];
   if(existing){result.push({name:template.name,status:'preserved'});continue;}
   await c.query('INSERT INTO workpivot.memory_templates(id,owner_user_id,name,content,scope,enabled) VALUES($1,$2,$3,$4,$5,true)',[randomUUID(),selected.id,template.name,template.content,template.scope]);
   result.push({name:template.name,status:'published'});
  }
  return result;
 },selected.id);
 console.log(JSON.stringify(result));
 console.log('Published presets: '+await transaction(db,async c=>(await c.query('SELECT count(*)::int AS n FROM workpivot.memory_templates WHERE enabled AND name=ANY($1::text[])',[defaultMemoryTemplates.map(t=>t.name)])).rows[0].n,selected.id));
}finally{await db.end();await auth.end();}
