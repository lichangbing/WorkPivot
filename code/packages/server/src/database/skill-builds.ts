import {revokeTrashAutomations} from './trash-capture.js';
import { DatabaseSkills } from './skills.js';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { Tool } from '@workpivot/core';
import { transaction, RepositoryError, uuid } from './connection.js';
import { checkFiles, packageDirectories, packageText, validatePackageState, type Files } from '../skill-package-store.js';
import type { FileRepository } from './files.js';
import type { WorkerConfiguration } from './skill-execution.js';

interface Build {
  id: string; name: string; task_id: string; source_run_id: string | null; source_epoch: string; source_invalid:boolean;
  revision: string; content_hash: string; status: string; purpose: string; permissions: string;
  validation: { valid: boolean; errors: string[]; warnings: string[] } | null;
  trial: TrialReport | null; trial_attempts: number; revision_attempts:number; dismissed: boolean; release_id: string | null;
}
interface Draft { name: string; display_name: string; files: Files; revision: string; deleted_at: string | null; published: string | null; disabled: boolean }
interface TrialReport { id: string; passed: boolean; command: string; output: string; error: string | null; inputs: string[]; previews: { path: string; size: number; content: string | null }[] }
const hash = (files: Files) => createHash('sha256').update(JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)))).digest('hex');
function fail(status: number, message: string): never { throw new RepositoryError(status, message); }
const text = (value: unknown, max = 20000) => typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : fail(400, '文本参数为空或超出限制');
const shellQuote=(value:string)=>"'"+value.replaceAll("'","'\"'\"'")+"'";
const scriptful = (files: Files) => Object.keys(files).some(p => /^(scripts|tests)\//.test(p) || /\.(py|js|mjs|cjs|ts|sh|ps1)$/i.test(p));

/** 模型只能操作草稿；启用接口仅提供给已认证的用户界面。 */
export class SkillBuilds {
  constructor(private readonly db: Pool, private readonly files?: FileRepository, private readonly worker?: WorkerConfiguration) {}
  private async get(c: PoolClient, id: string, lock = false): Promise<{ b: Build; d: Draft }> {
    uuid(id);
    let b = (await c.query<Build>('SELECT * FROM workpivot.skill_builds WHERE id=$1', [id])).rows[0];
    if(lock&&b){
      // 与任务删除和文件撤权保持先任务、后构建的加锁次序。
      await c.query('SELECT id FROM workpivot.tasks WHERE id=$1 FOR UPDATE',[b.task_id]);
      b=(await c.query<Build>('SELECT * FROM workpivot.skill_builds WHERE id=$1 FOR UPDATE',[id])).rows[0];
    }
    if (!b) return fail(404, '技能构建不存在或无权访问');
    const d = (await c.query<Draft>("SELECT name,display_name,files,revision,deleted_at,published,disabled FROM workpivot.skill_drafts WHERE name=$1 AND visibility='private'" + (lock ? ' FOR UPDATE' : ''), [b.name])).rows[0];
    if (!d) return fail(404, '私人技能不存在');
    return { b, d };
  }
  private async source(c: PoolClient, b: Build, lock = false) {
    const task = await c.query('SELECT id FROM workpivot.tasks WHERE id=$1 AND deleted_at IS NULL' + (lock ? ' FOR SHARE' : ''), [b.task_id]);
    const epoch = String((await c.query('SELECT epoch FROM workpivot.knowledge_state WHERE owner_user_id=workpivot.actor_id()' + (lock ? ' FOR SHARE' : ''))).rows[0]?.epoch ?? 0);
    if (b.source_invalid || !task.rowCount || epoch !== String(b.source_epoch) || ['stale','cancelled'].includes(b.status)) fail(409, '来源已删除、撤回或发生变更，请重新生成草稿');
    if (b.source_run_id && !(await c.query("SELECT id FROM workpivot.task_runs WHERE id=$1 AND task_id=$2 AND NOT context_revoked AND status IN ('running','completed','failed')" + (lock ? ' FOR SHARE' : ''), [b.source_run_id,b.task_id])).rowCount) fail(409, '来源对话已失效，请重新生成');
  }
  private current(b: Build, d: Draft, revision: unknown) {
    if (d.deleted_at || revision !== b.revision || d.revision !== b.revision || hash(d.files) !== b.content_hash) fail(409, '草稿已修改、删除或版本变化，请重新查看并验证');
  }
  private encode(name: string, input: unknown): Files {
    if (!Array.isArray(input) || !input.length || input.length > 64) return fail(400, '需要1至64个技能文本文件');
    const result: Files = Object.create(null) as Files; let total = 0;
    for (const item of input) {
      if (!item || typeof item !== 'object') return fail(400, '文件参数无效');
      const { path, content } = item as Record<string,unknown>;
      if (typeof path !== 'string' || typeof content !== 'string' || Object.hasOwn(result,path)) return fail(400, '文件路径重复或内容无效');
      if(Buffer.byteLength(content)>256*1024)fail(413,'单个生成文本不能超过256KiB');
      if(/sk-[A-Za-z0-9]{24,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content))fail(400,'技能文件疑似包含密钥，请移除后再保存');
      total += Buffer.byteLength(content); if (total > 512 * 1024) return fail(413, '生成文本总量不能超过512KiB');
      let value = content.replaceAll('{{skill_root}}','/skills/'+name).replaceAll('{{skill_name}}',name);
      // 内部名称由服务器分配，不能让同名私人技能覆盖公共包。
      if (path === 'SKILL.md') {
        value = value.replace(/\r\n/g,'\n');
        if (!/^---\n[\s\S]*?\n---\n/.test(value) || !/^name:.*$/m.test(value.split('\n---\n')[0]!)) return fail(400, 'SKILL.md 需要顶部 name 和 description 元数据');
        const end = value.indexOf('\n---\n',4);
        value = value.slice(0,end).replace(/^name:.*$/m,`name: ${name}`) + value.slice(end);
      }
      result[path] = Buffer.from(value).toString('base64');
    }
    if (!result['SKILL.md']) return fail(400, '缺少 SKILL.md');
    checkFiles(result); packageDirectories(result); return result;
  }
  private async view(c: PoolClient, b: Build, d: Draft) {
    const versions = (await c.query('SELECT id,label,created_at FROM workpivot.skill_releases WHERE name=$1 ORDER BY created_at DESC,id', [d.name])).rows;
    const old = d.published ? (await c.query<{files: Files}>('SELECT files FROM workpivot.skill_releases WHERE id=$1',[d.published])).rows[0]?.files : undefined;
    return { id:b.id, name:b.name, displayName:d.display_name, taskId:b.task_id, revision:b.revision, draftRevision:d.revision, hash:b.content_hash, status:b.status, sourceInvalid:b.source_invalid, purpose:b.purpose, permissions:b.permissions, validation:b.validation, trial:b.trial, trialAttempts:b.trial_attempts, dismissed:b.dismissed, releaseId:b.release_id, deleted:!!d.deleted_at, disabled:d.disabled,
      workerAvailable:!!this.worker, requiresTrial:scriptful(d.files), published:d.published, versions,
      files:Object.entries(d.files).map(([path,data])=>({path,content:packageText(Buffer.from(data,'base64')),size:Buffer.byteLength(data,'base64'),previous:old?.[path] ? packageText(Buffer.from(old[path]!,'base64')) : null,change:!old?.[path]?'added':old[path]===data?'same':'modified'})),
      removed:old?Object.keys(old).filter(p=>!Object.hasOwn(d.files,p)):[] };
  }
  async list(actor: string, taskId?: string) {
    if (taskId) uuid(taskId);
    return transaction(this.db,async c=>{
      await c.query("UPDATE workpivot.skill_trials SET status='interrupted',report=jsonb_build_object('error','试运行已中断，请检查后重试') WHERE status='running' AND lease_until<now()");
      const rows=(await c.query<Build & {display_name:string;deleted_at:string|null;disabled:boolean;published:string|null;draft_revision:string;requires_trial:boolean}>(`SELECT b.*,d.display_name,d.deleted_at,d.disabled,d.published,d.revision AS draft_revision,
        EXISTS(SELECT 1 FROM jsonb_object_keys(d.files) p WHERE p ~ '^(scripts|tests)/|[.](py|js|mjs|cjs|ts|sh|ps1)$') AS requires_trial
        FROM (SELECT DISTINCT ON(name) * FROM workpivot.skill_builds WHERE ($1::uuid IS NULL OR task_id=$1) ORDER BY name,created_at DESC,id DESC) b
        JOIN workpivot.skill_drafts d ON d.name=b.name ORDER BY b.created_at DESC,b.id DESC LIMIT 100`,[taskId??null])).rows;
      return rows.map(b=>({id:b.id,name:b.name,displayName:b.display_name,taskId:b.task_id,revision:b.revision,draftRevision:b.draft_revision,hash:b.content_hash,status:b.status,sourceInvalid:b.source_invalid,purpose:b.purpose,permissions:b.permissions,validation:b.validation,trial:b.trial?{...b.trial,output:'',previews:[]}:null,trialAttempts:b.trial_attempts,dismissed:b.dismissed,releaseId:b.release_id,deleted:!!b.deleted_at,disabled:b.disabled,workerAvailable:!!this.worker,requiresTrial:b.requires_trial,published:b.published,versions:[],files:[],removed:[]}));
    },actor);
  }
  async detail(actor: string, id: string) { return transaction(this.db,async c=>{const {b,d}=await this.get(c,id);return this.view(c,b,d);},actor); }
  async propose(actor: string, taskId: string, args: Record<string,unknown>, run?: {id:string;fence:string}) {
    uuid(taskId);const requestId=text(args.requestId,36);uuid(requestId);
    const displayName=text(args.displayName,120),purpose=text(args.purpose,2000);
    return transaction(this.db,async c=>{
      await c.query('SELECT id FROM workpivot.tasks WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[taskId]).then(r=>{if(!r.rowCount)fail(404,'任务不存在');});
      const existing=(await c.query<Build>('SELECT * FROM workpivot.skill_builds WHERE request_id=$1',[requestId])).rows[0];
      if(existing){const {d}=await this.get(c,existing.id);if(existing.task_id!==taskId||existing.purpose!==purpose||d.display_name!==displayName||hash(this.encode(existing.name,args.files))!==existing.content_hash)fail(409,'请求标识已被不同草稿使用');return this.view(c,existing,d);}
      if((await c.query('SELECT id FROM workpivot.skill_builds WHERE task_id=$1',[taskId])).rowCount! >= 30)fail(429,'每个任务最多保留30次技能构建');
      if(run && !(await c.query("SELECT id FROM workpivot.task_runs WHERE id=$1 AND task_id=$2 AND fence=$3 AND status='running' AND NOT context_revoked AND lease_until>now() FOR SHARE",[run.id,taskId,run.fence])).rowCount)fail(409,'生成轮次已停止');
      const name='p-'+randomUUID(),revision=randomUUID(),id=randomUUID(),files=this.encode(name,args.files);
      const epoch=String((await c.query('SELECT epoch FROM workpivot.knowledge_state WHERE owner_user_id=$1',[actor])).rows[0]?.epoch??0);
      await c.query("INSERT INTO workpivot.skill_drafts(name,owner_user_id,revision,files,directories,display_name,visibility,disabled) VALUES($1,$2,$3,$4,$5,$6,'private',true)",[name,actor,revision,JSON.stringify(files),JSON.stringify(packageDirectories(files)),displayName]);
      await c.query('INSERT INTO workpivot.skill_builds(id,owner_user_id,name,task_id,source_run_id,source_epoch,request_id,revision,content_hash,purpose) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[id,actor,name,taskId,run?.id??null,epoch,requestId,revision,hash(files),purpose]);
      const {b,d}=await this.get(c,id);return this.view(c,b,d);
    },actor);
  }
  async revise(actor:string,id:string,revision:unknown,args:Record<string,unknown>,taskId?:string,run?:{id:string;fence:string}) {
    return transaction(this.db,async c=>{
      const {b,d}=await this.get(c,id,true);if(taskId&&taskId!==b.task_id)fail(404,'草稿不属于当前任务');
      this.current(b,d,revision);await this.source(c,b,true);
      if(run&&!(await c.query("SELECT id FROM workpivot.task_runs WHERE id=$1 AND task_id=$2 AND fence=$3 AND status='running' AND NOT context_revoked AND lease_until>now() FOR SHARE",[run.id,b.task_id,run.fence])).rowCount)fail(409,'修订轮次已停止');
      const files=this.encode(b.name,args.files),rev=randomUUID();
      if(b.trial_attempts>=8||b.revision_attempts>=8)fail(429,'本次构建修复次数已达上限，请检查后重新创建');
      await c.query('UPDATE workpivot.skill_drafts SET files=$2,directories=$3,revision=$4 WHERE name=$1',[b.name,JSON.stringify(files),JSON.stringify(packageDirectories(files)),rev]);
      await c.query("UPDATE workpivot.skill_builds SET revision=$2,content_hash=$3,status='draft',purpose=$4,validation=NULL,trial=NULL,dismissed=false,release_id=NULL,revision_attempts=revision_attempts+1,source_run_id=COALESCE($5::uuid,source_run_id) WHERE id=$1",[id,rev,hash(files),text(args.purpose??b.purpose,2000),run?.id??null]);
      const updated=await this.get(c,id);return this.view(c,updated.b,updated.d);
    },actor);
  }
  async validate(actor:string,id:string,revision:unknown) {
    return transaction(this.db,async c=>{
      const {b,d}=await this.get(c,id,true);this.current(b,d,revision);await this.source(c,b,true);
      if(b.status==='activated')return this.view(c,b,d);
      const available=(await c.query('SELECT name FROM workpivot.skill_catalog WHERE NOT disabled')).rows.map(r=>r.name);
      const validation=validatePackageState(b.name,{draft:d.files,revision:d.revision},available);
      const ready=validation.valid&&(!scriptful(d.files)||b.trial?.passed);
      await c.query('UPDATE workpivot.skill_builds SET validation=$2,status=$3,dismissed=false WHERE id=$1',[id,JSON.stringify(validation),ready?'ready':'draft']);
      const updated=await this.get(c,id);return this.view(c,updated.b,updated.d);
    },actor);
  }
  async trial(actor:string,id:string,revision:unknown,args:Record<string,unknown>,signal?:AbortSignal,taskId?:string) {
    if(!this.worker)return fail(503,'未配置隔离执行器；草稿已保留，不能声明测试通过');
    const command=text(args.command,12000),inputIds=args.inputs??[],outputs=args.outputs??[];
    if(!Array.isArray(inputIds)||inputIds.length>10||inputIds.some(v=>typeof v!=='string')||new Set(inputIds).size!==inputIds.length)fail(400,'测试输入无效');
    for(const v of inputIds)uuid(v as string);
    if(!Array.isArray(outputs)||outputs.length>10||outputs.some(v=>typeof v!=='string'||v.includes('/')||v.includes('\\')||v.startsWith('.')||v.length>240))fail(400,'测试产物仅填写文件名，最多10个');
    const trialId=randomUUID();
    const snapshot=await transaction(this.db,async c=>{
      const {b,d}=await this.get(c,id,true);if(taskId&&taskId!==b.task_id)fail(404,'草稿不属于当前任务');this.current(b,d,revision);await this.source(c,b,true);
      if(b.status==='activated')fail(409,'请先生成修订草稿');
      if(!b.validation?.valid)fail(409,'请先完成草稿结构校验');
      const entry=/^(node|python3|python|sh)(?:\s+(--test))?\s+(?:'([^']+)'|"([^"]+)"|([^\s]+))$/.exec(command);
      const path=entry?.[3]??entry?.[4]??entry?.[5]??'',relative=path.slice(('/skills/'+b.name+'/').length);
      if(!entry||!path.startsWith('/skills/'+b.name+'/tests/')||!Object.hasOwn(d.files,relative)||(entry[2]&&entry[1]!=='node'))fail(400,'试运行必须直接运行技能包 tests/ 中的测试文件，例如 node /skills/<内部名称>/tests/run.cjs；不能用 true、echo 或未执行测试的命令代替');
      const testCommand=entry[1]+(entry[2]?' --test':'')+' '+shellQuote(path);
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended('skill-trial:'||$1,0))",[actor]);
      await c.query("UPDATE workpivot.skill_trials SET status='interrupted' WHERE status='running' AND lease_until<now()");
      if((await c.query("SELECT id FROM workpivot.skill_trials WHERE status='running'")).rowCount)fail(429,'已有测试正在运行，请等待完成');
      if(b.trial_attempts>=8)fail(429,'本次构建最多试运行8次');
      await c.query('INSERT INTO workpivot.skill_trials(id,owner_user_id,build_id,revision,content_hash,command,input_ids) VALUES($1,$2,$3,$4,$5,$6,$7)',[trialId,actor,id,b.revision,b.content_hash,testCommand,inputIds]);
      await c.query("UPDATE workpivot.skill_builds SET trial_attempts=trial_attempts+1,trial=NULL,status='draft' WHERE id=$1",[id]);
      return {b,d,testCommand};
    },actor);
    let report:TrialReport={id:trialId,passed:false,command:snapshot.testCommand,output:'',error:null,inputs:inputIds as string[],previews:[]};
    try {
      signal?.throwIfAborted();
      const inputs:[string,string][]=[];let bytes=Object.values(snapshot.d.files).reduce((n,v)=>n+Buffer.byteLength(v,'base64'),0);
      for(const input of inputIds){if(!this.files)fail(503,'文件服务未配置');const f=await this.files!.download(actor,snapshot.b.task_id,input as string);bytes+=f.data.length;inputs.push([`inputs/${f.version.id}/${f.version.name}`,f.data.toString('base64')]);}
      if(bytes>16*1024*1024)fail(413,'技能与输入合计超过16MiB');
      const syntax=Object.keys(snapshot.d.files).filter(p=>/\.(js|mjs|cjs)$/.test(p)).map(p=>'node --check '+shellQuote('/skills/'+snapshot.b.name+'/'+p));
      const checkedCommand=[...syntax,snapshot.testCommand].join(' && ');
      const response=await fetch(`${this.worker.url.replace(/\/$/,'')}/v1/run`,{method:'POST',headers:{authorization:`Bearer ${this.worker.token}`,'content-type':'application/json'},body:JSON.stringify({command:checkedCommand,files:inputs,skills:Object.entries(snapshot.d.files).map(([p,v])=>[`${snapshot.b.name}/${p}`,v])}),redirect:'error',signal:AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(140000)])});
      if(!response.body)fail(502,'执行器没有返回测试报告');
      const reader=response.body!.getReader(),chunks:Uint8Array[]=[];let size=0;
      try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>24*1024*1024)fail(413,'测试输出过大');chunks.push(part.value);}}finally{await reader.cancel().catch(()=>undefined);reader.releaseLock();}
      const result=JSON.parse(Buffer.concat(chunks).toString('utf8')) as {files?:unknown;output?:unknown;error?:unknown};
      report.output=typeof result.output==='string'?result.output.slice(0,12000):'';
      if(!response.ok){report.error=typeof result.error==='string'?result.error.slice(0,3000):'隔离测试失败';}
      else {
        if(!Array.isArray(result.files)||result.files.length>4000)fail(502,'测试输出格式无效');
        for(const path of outputs){const matches=result.files.filter(v=>Array.isArray(v)&&v[0]===path);if(matches.length!==1)fail(502,`缺少测试产物：${path}`);const entry=matches[0] as unknown[];if(typeof entry[1]!=='string')fail(502,'测试输出编码无效');const data=Buffer.from(entry[1],'base64');if(data.toString('base64')!==entry[1])fail(502,'测试输出编码无效');report.previews.push({path:path as string,size:data.length,content:data.length<=16000?packageText(data):null});}
        report.passed=true;
      }
    } catch(error){report={...report,passed:false,error:signal?.aborted?'试运行已停止':error instanceof RepositoryError?error.message:'执行器不可用或测试超时，请检查后重试'};}
    await transaction(this.db,async c=>{
      const {b,d}=await this.get(c,id,true);
      const live=await c.query("SELECT id FROM workpivot.skill_trials WHERE id=$1 AND status='running' AND lease_until>now() FOR UPDATE",[trialId]);
      if(!live.rowCount)fail(409,'试运行租约已失效');
      await c.query('UPDATE workpivot.skill_trials SET status=$2,report=$3 WHERE id=$1',[trialId,report.passed?'passed':signal?.aborted?'interrupted':'failed',JSON.stringify(report)]);
      this.current(b,d,revision);await this.source(c,b,true);
      const remaining=await c.query('SELECT id FROM workpivot.document_versions WHERE id=ANY($1::uuid[])',[inputIds]);if(remaining.rowCount!==inputIds.length)fail(409,'测试输入已删除，报告不可用于启用');
      await c.query('UPDATE workpivot.skill_builds SET trial=$2,status=$3,dismissed=false WHERE id=$1',[id,JSON.stringify(report),report.passed?'ready':'draft']);
    },actor);
    return this.detail(actor,id);
  }
  async decide(actor:string,id:string,revision:unknown,decision:unknown,contentHash?:unknown) {
    return transaction(this.db,async c=>{
      const {b,d}=await this.get(c,id,true);
      if(revision!==b.revision)fail(409,'草稿已修改，请刷新');
      if(decision==='dismiss'){await c.query('UPDATE workpivot.skill_builds SET dismissed=true WHERE id=$1',[id]);return {saved:true};}
      this.current(b,d,revision);
      if(decision==='cancel'){if(b.status==='activated')fail(409,'已启用技能请使用停用操作');await c.query("UPDATE workpivot.skill_builds SET status='cancelled',dismissed=true WHERE id=$1",[id]);return {cancelled:true};}
      if(decision!=='activate')fail(400,'需要明确选择保存并启用');
      if(contentHash!==b.content_hash)fail(409,'确认内容已变化，请重新核对');
      await this.source(c,b,true);
      if(b.status==='activated')return {releaseId:b.release_id,name:b.name,duplicate:true};
      if(b.status!=='ready'||!b.validation?.valid||(scriptful(d.files)&&!b.trial?.passed))fail(409,'校验或试运行尚未通过');
      if(b.trial){const found=await c.query("SELECT id FROM workpivot.document_versions WHERE id=ANY($1::uuid[]) FOR SHARE",[b.trial.inputs]);if(found.rowCount!==b.trial.inputs.length)fail(409,'试运行输入已删除，请重新验证');}
      const releases=(await c.query('SELECT id FROM workpivot.skill_releases WHERE name=$1',[b.name])).rows;
      if(releases.length>=32)fail(400,'最多保留32个版本');
      const validation=validatePackageState(b.name,{draft:d.files,revision:d.revision},(await c.query('SELECT name FROM workpivot.skill_catalog WHERE NOT disabled')).rows.map(r=>r.name));
      if(!validation.valid)fail(409,'依赖或草稿校验已失效');
      const releaseId=randomUUID();
      const description=/^description:\s*(.+)$/m.exec(Buffer.from(d.files['SKILL.md']!,'base64').toString('utf8'))?.[1]??b.purpose;
      await c.query("INSERT INTO workpivot.skill_releases(id,name,owner_user_id,files,directories,label,description,visibility) VALUES($1,$2,$3,$4,$5,$6,$7,'private')",[releaseId,b.name,actor,JSON.stringify(d.files),JSON.stringify(packageDirectories(d.files)),`版本 ${releases.length+1}`,description]);
      await c.query("INSERT INTO workpivot.skill_catalog(name,owner_user_id,release_id,disabled,visibility,display_name) VALUES($1,$2,$3,false,'private',$4) ON CONFLICT(name) DO UPDATE SET release_id=EXCLUDED.release_id,disabled=false,display_name=EXCLUDED.display_name",[b.name,actor,releaseId,d.display_name]);
      await c.query('UPDATE workpivot.skill_drafts SET published=$2,disabled=false WHERE name=$1',[b.name,releaseId]);
      await c.query('INSERT INTO workpivot.skill_selections(owner_user_id,name) VALUES($1,$2) ON CONFLICT DO NOTHING',[actor,b.name]);
      await c.query("UPDATE workpivot.skill_builds SET status='activated',release_id=$2,dismissed=true WHERE id=$1",[id,releaseId]);
      return {releaseId,name:b.name,loaded:true,effective:'下一轮对话'};
    },actor);
  }
  async lifecycle(actor:string,id:string,revision:unknown,action:unknown) {
    return transaction(this.db,async c=>{
      const {b,d}=await this.get(c,id,true);if(revision!==d.revision)fail(409,'技能已修改，请刷新');
      if(!['disable','delete','restore'].includes(String(action)))fail(400,'操作无效');
      const deleted=action==='delete';
      if(deleted&&d.deleted_at)fail(409,'技能已在回收站');
      if(deleted){await c.query(`INSERT INTO workpivot.trash_entries(owner_user_id,kind,entity_id,name,payload) SELECT owner_user_id,'skill',skill_id,display_name,jsonb_build_object('name',name) FROM workpivot.skill_drafts WHERE name=$1 ON CONFLICT DO NOTHING`,[b.name]);await revokeTrashAutomations(c,'skill',b.name);}
      if(action==='restore')await c.query("DELETE FROM workpivot.trash_entries WHERE kind='skill' AND entity_id=(SELECT skill_id FROM workpivot.skill_drafts WHERE name=$1)",[b.name]);
      if(d.deleted_at&&action==='disable')fail(409,'技能已删除，请使用恢复操作');
      if(action==='restore'&&!d.deleted_at)fail(409,'技能未删除');
      await c.query('UPDATE workpivot.skill_drafts SET disabled=true,deleted_at=$2,revision=$3 WHERE name=$1',[b.name,deleted?new Date():null,randomUUID()]);
      await c.query('UPDATE workpivot.skill_catalog SET disabled=true WHERE name=$1',[b.name]);
      await c.query("UPDATE workpivot.skill_builds SET status='stale',validation=NULL,trial=NULL,dismissed=true WHERE name=$1",[b.name]);
      const experts=(await c.query("SELECT id,name FROM workpivot.experts WHERE settings->'skills' ? $1",[b.name])).rows;
      return {disabled:true,deleted,experts,notice:action==='restore'?'已恢复为停用状态；请从历史版本建立草稿并重新确认':'已停止新执行，并阻止在途成果发布'};
    },actor);
  }
  async fromRelease(actor:string,id:string,revision:unknown,releaseId?:unknown) {
    const version=releaseId===undefined?undefined:text(releaseId,36);if(version)uuid(version);
    return transaction(this.db,async c=>{
      const {b,d}=await this.get(c,id,true);if(d.deleted_at||revision!==d.revision)fail(409,'技能已删除或修改');
      if(b.source_invalid)fail(409,'来源已撤回，不能将旧内容重新激活；请重新描述有效方法');
      const r=version?(await c.query<{files:Files}>('SELECT files FROM workpivot.skill_releases WHERE id=$1 AND name=$2',[version,b.name])).rows[0]:{files:d.files};if(!r)fail(404,'版本不存在');
      const next=randomUUID(),rev=randomUUID(),epoch=String((await c.query('SELECT epoch FROM workpivot.knowledge_state WHERE owner_user_id=$1',[actor])).rows[0]?.epoch??0);
      if(!(await c.query('SELECT id FROM workpivot.tasks WHERE id=$1 AND deleted_at IS NULL FOR SHARE',[b.task_id])).rowCount)fail(409,'原任务已删除，请在有效任务重新创建技能');
      await c.query('UPDATE workpivot.skill_drafts SET files=$2,directories=$3,revision=$4 WHERE name=$1',[b.name,JSON.stringify(r!.files),JSON.stringify(packageDirectories(r!.files)),rev]);
      await c.query("UPDATE workpivot.skill_builds SET status='stale',dismissed=true WHERE name=$1 AND status IN ('draft','ready')",[b.name]);
      await c.query('INSERT INTO workpivot.skill_builds(id,owner_user_id,name,task_id,source_epoch,request_id,revision,content_hash,purpose,source_run_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[next,actor,b.name,b.task_id,epoch,randomUUID(),rev,hash(r!.files),`从${version?'历史版本 '+version:'当前内容'}建立修订：${b.purpose}`.slice(0,2000),b.source_run_id]);
      const updated=await this.get(c,next);return this.view(c,updated.b,updated.d);
    },actor);
  }
  async export(actor:string,id:string,version?:string) {
    const name=await transaction(this.db,async c=>{const {b}=await this.get(c,id);if(b.source_invalid)fail(409,'来源已撤回，不能导出旧内容');return b.name;},actor);
    return new DatabaseSkills(this.db).export(actor,name,version);
  }
  tools(actor:string,taskId:string,run:()=>{id:string;fence:string}|undefined):Tool[] {
    const object={type:'object',properties:{path:{type:'string'},content:{type:'string'}},required:['path','content'],additionalProperties:false};
    const refs={buildId:{type:'string'},revision:{type:'string'}};
    const wrap=(name:string,description:string,properties:Record<string,unknown>,required:string[],handler:(args:Record<string,unknown>,signal?:AbortSignal)=>Promise<unknown>,external=false):Tool=>({name,kind:'write',description,parameters:{type:'object',properties,required,additionalProperties:false},...(external?{access:(args:Record<string,unknown>)=>({external:true,tool:name,kind:'write' as const,paths:[],command:String(args.command??'')})}:{}),run:async(args,ctx)=>{ctx.signal?.throwIfAborted();const bound=run();if(!bound)fail(409,'运行身份尚未就绪');await transaction(this.db,async c=>{if(!(await c.query("SELECT id FROM workpivot.task_runs WHERE id=$1 AND task_id=$2 AND fence=$3 AND status='running' AND NOT context_revoked AND lease_until>now()",[bound!.id,taskId,bound!.fence])).rowCount)fail(409,'当前运行已停止');if(args.buildId){const {b}=await this.get(c,text(args.buildId,36));if(b.task_id!==taskId)fail(404,'草稿不属于当前任务');await this.source(c,b);}},actor);const result=await handler(args,ctx.signal);
      // 模型已有生成内容；写工具只返回摘要，避免每步重复整包挤爆上下文。
      if(name!=='get_skill_build'&&result&&typeof result==='object'&&'files' in result){const value=result as {files:{path:string;size:number}[]};return JSON.stringify({...value,files:value.files.map(f=>({path:f.path,size:f.size}))});}
      return JSON.stringify(result);}});
    return [
      wrap('list_my_skill_builds','生成前查询本人的技能名称、用途、状态、构建标识和修订号。只返回摘要；同主题优先建议修订而非重复生成。当前任务的草稿可直接修订，其他任务的技能应提示用户从设置打开并回到原任务处理。',{},[],async()=>({skills:(await this.list(actor)).map(b=>({id:b.id,name:b.name,displayName:b.displayName,purpose:b.purpose.slice(0,300),taskId:b.taskId,revision:b.revision,status:b.status,deleted:b.deleted})),notice:'仅返回本人最近100个技能的摘要；需要正文时读取具体技能。'})),
      wrap('propose_skill','根据用户要求或当前任务中已验证的方法生成私人技能草稿。files包含SKILL.md和必要的scripts/、tests/、references/文本；顶端name会由服务器替换；说明及测试清单中的{{skill_root}}会替换为实际只读目录，脚本内部使用相对模块引用。有脚本必须提供tests/测试入口，可附skill-test.json的command和outputs供用户试运行。写清触发条件、输入输出、步骤、注意事项、验证方法，脚本及注释用中文。不得包含密钥或未经选择的业务数据。只保存草稿，不发布、不加载。requestId为UUID，重试复用。',{requestId:{type:'string'},displayName:{type:'string'},purpose:{type:'string'},files:{type:'array',items:object}},['requestId','displayName','purpose','files'],args=>this.propose(actor,taskId,args,run())),
      wrap('revise_skill_draft','按错误报告或用户纠正修改当前任务的私人草稿。提交完整文本文件树，保留必要资源。修改使旧校验及确认失效，不能静默替换已发布版本。',{...refs,purpose:{type:'string'},files:{type:'array',items:object}},['buildId','revision','files'],args=>this.revise(actor,text(args.buildId,36),args.revision,args,taskId,run())),
      wrap('validate_skill_draft','检查技能草稿结构、引用和依赖；此操作不执行测试。',refs,['buildId','revision'],args=>this.validate(actor,text(args.buildId,36),args.revision)),
      wrap('trial_skill_draft','隔离执行当前已校验草稿的测试入口，需用户授权。command必须直接为 node /skills/<内部名称>/tests/<文件>（可加--test），或镜像具备的python3/python/sh加同类tests路径；不接受cd、内联shell、true/echo或额外参数，测试准备与断言写在测试文件内。技能文件只读在/skills/<内部名称>/，工作目录/workspace；只有inputs显式文件版本ID会进入/workspace/inputs/<ID>/<文件名>。支持Node与预装办公库，不能联网安装依赖。用断言检查结果，失败必须非零退出；outputs列出需要预览的文件名。测试不发布技能或业务成果，最多8次。',{...refs,command:{type:'string'},inputs:{type:'array',items:{type:'string'},maxItems:10},outputs:{type:'array',items:{type:'string'},maxItems:10}},['buildId','revision','command'],(args,signal)=>this.trial(actor,text(args.buildId,36),args.revision,args,signal,taskId),true),
      wrap('get_skill_build','读取当前任务技能草稿、修订、文件和校验/试运行报告；只有界面确认接口能启用。',{buildId:{type:'string'}},['buildId'],args=>this.detail(actor,text(args.buildId,36))),
    ];
  }
}
