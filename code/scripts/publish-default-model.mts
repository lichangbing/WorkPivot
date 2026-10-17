import { pool } from '../packages/server/src/database/connection.js';
import { ProviderRepository } from '../packages/server/src/database/providers.js';
import { DatabaseModelService } from '../packages/server/src/database/model-service.js';
const auth=pool(process.env.WORKPIVOT_AUTH_DATABASE_URL!),db=pool(process.env.WORKPIVOT_DATABASE_URL!);
try {
  const providers=new ProviderRepository(db,process.env.WORKPIVOT_SECRET_KEY!);
  const admins=(await auth.query("SELECT id FROM identity.users WHERE role='admin' AND NOT disabled")).rows;
  const candidates=[];
  for(const admin of admins)for(const model of await providers.list(admin.id))if(model.active)candidates.push({owner:admin.id,model});
  if(candidates.length!==1)throw Error('Requires exactly one active administrator model; choose default in admin UI');
  const selected=candidates[0]!;await providers.activate(selected.owner,selected.model.id,selected.model.revision,true);
  const models=new DatabaseModelService(auth,db,providers);
  // 使用现有配置执行有界真实连通性探测，不发送对话或用户数据。
  const client=await models.client(selected.owner);let output='';
  for await(const e of client.streamChat([{role:'user',content:'Reply only WORKPIVOT_OK.'}],[],AbortSignal.timeout(45000))){if(e.type==='delta')output+=e.text;}
  console.log(JSON.stringify({published:true,name:selected.model.name,model:selected.model.modelId,probeResponded:output.trim().length>0}));
} finally {await Promise.all([auth.end(),db.end()]);}
