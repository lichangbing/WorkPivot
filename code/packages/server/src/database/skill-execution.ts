import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { Tool } from '@workpivot/core';
import { RepositoryError, transaction } from './connection.js';
import { parseSandboxInputs, parseSandboxOutputs } from './sandbox-args.js';
import { runSandbox } from './sandbox.js';
import { FileRepository } from './files.js';
import { DatabaseSkills } from './skills.js';

export interface WorkerConfiguration { url: string; token: string }
/** 由固定宿主服务创建沙箱，网页容器不接收 Docker 套接字。 */
export class DatabaseSkillExecution {
  constructor(private readonly db: Pool, private readonly files: FileRepository, private readonly skills: DatabaseSkills, private readonly config: WorkerConfiguration, private readonly boundRun?: () => { id: string; fence: string } | undefined, private readonly guard?:(c:PoolClient,args:Record<string,unknown>,taskId?:string)=>Promise<void>) {}
  async run(actor: string, taskId: string, versions: ReadonlyMap<string,string>, args: Record<string,unknown>, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const { skill, command } = args;
    if (typeof skill !== 'string' || !versions.has(skill) || typeof command !== 'string' || !command.trim() || command.length > 65536) throw new RepositoryError(400, '执行参数无效');
    if (args.outputs !== undefined && (args.output !== undefined || args.documentId !== undefined || args.revision !== undefined)) throw new RepositoryError(400, '单个和多个产物参数不能混用');
    const outputs = parseSandboxOutputs(args.outputs ?? [{ name: args.output, documentId: args.documentId, revision: args.revision }]);
    const inputs = parseSandboxInputs(args.inputs ?? []);
    const run = await transaction(this.db, async c => (await c.query("SELECT id,fence FROM workpivot.task_runs WHERE task_id=$1 AND status='running' AND NOT context_revoked AND lease_until>now()", [taskId])).rows[0], actor);
    if (!run) throw new RepositoryError(409, '任务已停止');
    const bound = this.boundRun?.();
    if (this.boundRun && (!bound || bound.id !== run.id || bound.fence !== run.fence)) throw new RepositoryError(409, '执行轮次已失效');
    if(this.guard)await transaction(this.db,c=>this.guard!(c,args,taskId),actor);
    const scope=await transaction(this.db,async c=>(await c.query('SELECT resource_scope FROM workpivot.task_runs WHERE id=$1',[run.id])).rows[0]?.resource_scope,actor);
    const resources = await this.skills.executionResources(actor, skill, versions.get(skill)!);
    const files: [string,string][] = []; let size = resources.reduce((n, [,data]) => n + Buffer.byteLength(data,'base64'),0);
    for (const id of inputs) {
      const source = await this.files.download(actor, taskId, id,scope?.versionIds);
      size += source.data.length;
      files.push([`inputs/${source.version.id}/${source.version.name}`, source.data.toString('base64')]);
    }
    if (size > 16 * 1024 * 1024) throw new RepositoryError(413, '输入和技能资源合计不能超过16MB');
    const jobId = randomUUID();
    await transaction(this.db, async c => {
      await c.query('SELECT id FROM workpivot.tasks WHERE id=$1 FOR UPDATE', [taskId]);
      const live = await c.query("SELECT id FROM workpivot.task_runs WHERE id=$1 AND fence=$2 AND status='running' AND NOT context_revoked AND lease_until>now() FOR UPDATE", [run.id,run.fence]);
      if (!live.rowCount) throw new RepositoryError(409, '任务已停止');
      await this.guard?.(c,args,taskId);
      await c.query('INSERT INTO workpivot.skill_executions(id,owner_user_id,task_id,run_id) VALUES($1,$2,$3,$4)', [jobId,actor,taskId,run.id]);
    }, actor);
    try {
    const result = await runSandbox(this.config, { command, files, skills: resources }, signal);
    const entries = outputs.map(output => {
      const found = result.files.filter(entry => entry[0] === output.name);
      if (found.length !== 1 || !Array.isArray(found[0]) || found[0].length !== 2 || typeof found[0][1] !== 'string') throw new RepositoryError(502, '执行器没有生成全部指定产物');
      const data = Buffer.from(found[0][1], 'base64');
      if (data.toString('base64') !== found[0][1]) throw new RepositoryError(502, '产物编码无效');
      return { ...output, data };
    });
    signal?.throwIfAborted();
    const artifacts = await this.files.uploadArtifacts(actor, taskId, entries, signal, async c => {
      await this.guard?.(c,args,taskId);
      // 上传持有任务锁，停止和删除不会与发布事务发生竞态。
      const live = await c.query("SELECT id FROM workpivot.task_runs WHERE id=$1 AND fence=$2 AND status='running' AND NOT context_revoked AND lease_until>now() FOR UPDATE", [run.id,run.fence]);
      if (!live.rowCount) throw new RepositoryError(409, '运行已停止，未发布产物');
      const job = await c.query("SELECT id FROM workpivot.skill_executions WHERE id=$1 AND status='running' FOR UPDATE", [jobId]);
      if (!job.rowCount) throw new RepositoryError(409, '执行已中断，拒绝迟到产物');
      const loaded = await c.query('SELECT c.name FROM workpivot.skill_catalog c JOIN workpivot.skill_selections s ON s.name=c.name WHERE c.name=$1 AND NOT c.disabled FOR SHARE OF c,s', [skill]);
      if (!loaded.rowCount) throw new RepositoryError(409, '技能已禁用或卸载，未发布产物');
      const remaining = await c.query('SELECT v.id FROM workpivot.document_versions v JOIN workpivot.documents d ON d.id=v.document_id WHERE (d.task_id=$1 OR ($3::boolean AND EXISTS(SELECT 1 FROM workpivot.tasks source JOIN workpivot.tasks target ON target.id=$1 AND target.project_id=source.project_id WHERE source.id=d.task_id AND source.deleted_at IS NULL AND target.deleted_at IS NULL))) AND v.id=ANY($2::uuid[])', [taskId,inputs,!!scope]);
      if (remaining.rowCount !== inputs.length) throw new RepositoryError(409, '输入文件已删除，未发布产物');
    }, async (c, published) => {
      for (const version of published) await c.query('INSERT INTO workpivot.execution_artifacts(owner_user_id,execution_id,version_id) VALUES($1,$2,$3)', [actor,jobId,version.id]);
      await c.query("UPDATE workpivot.skill_executions SET status='completed',artifact_id=$2,finished_at=now() WHERE id=$1", [jobId,published[0]!.id]);
    });
    return { artifact: artifacts[0]!, artifacts, output: typeof result.output === 'string' ? result.output.slice(0,16000) : '' };
    } catch (error) {
      try { await transaction(this.db,c => c.query("UPDATE workpivot.skill_executions SET status=$2,error=$3,finished_at=now() WHERE id=$1 AND status='running'", [jobId, signal?.aborted ? 'interrupted' : 'failed', signal?.aborted ? '执行已停止；请检查已有产物后重新发起' : '执行未完成；请查看对话中的错误详情']),actor); } catch { /* 租约到期后由恢复流程判定结果不明的作业。 */ }
      throw error;
    }
  }
  tool(actor: string, taskId: string, versions: ReadonlyMap<string,string>): Tool {
    return { name: 'execute_skill', kind: 'write', description: '按已加载Skill指引在无网络隔离环境执行命令。先load_skill读取说明。技能包只读位于/skills/<名称>；必须在inputs数组显式填写要读取的文件版本ID（list_uploaded_files返回的id，不是documentId），否则文件不会进入沙箱。所选输入位于/workspace/inputs/<版本ID>/<原文件名>，工作目录/workspace。支持Node及预装办公库，不能联网安装依赖。使用outputs指定1至10个产物，每项name只填文件名（如report.docx，不含目录），命令须写入/workspace/report.docx；更新已有成果须填list_artifacts返回的documentId和当前revision。所有指定文件整体保存，任一缺失或版本冲突则全部不发布，过程文件丢弃。兼容单个output及documentId/revision。', parameters: { type: 'object', properties: { skill: { type: 'string' }, command: { type: 'string' }, inputs: { type: 'array', description: '实际要读取的文件版本ID列表；未列入的文件不会提供给命令。', items: { type: 'string' }, maxItems: 10 }, outputs: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'object', properties: { name: { type: 'string', description: '只填文件名，不含路径，例如 report.docx' }, documentId: { type: 'string' }, revision: { type: 'integer', minimum: 1 } }, required: ['name'], additionalProperties: false } }, output: { type: 'string' }, documentId: { type: 'string' }, revision: { type: 'integer', minimum: 1 } }, required: ['skill','command'], additionalProperties: false }, access: args => ({ binding:{releaseId:versions.get(String(args['skill']??''))??null}, external: true, tool: 'execute_skill', kind: 'write', paths: [], command: String(args['command'] ?? '') }), run: async (args, ctx) => JSON.stringify(await this.run(actor, taskId, versions, args, ctx.signal)) };
  }
}
