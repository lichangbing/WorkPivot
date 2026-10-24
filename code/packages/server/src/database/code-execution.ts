/**
 * 通用代码执行：没有专用工具时，由模型在隔离沙箱里写代码解决问题。
 *
 * 与技能执行共用同一个宿主 worker、同一套产物发布事务和运行栅栏；区别只有两点：
 * 不依赖 Skill 版本，代码由模型直接提供。沙箱边界仍由 worker 强制（无网络、只读根、tmpfs、
 * 120 秒、2 并发、16MiB），因此这里不重复实现隔离，只在入口和发布前做业务校验。
 */
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { Tool } from '@workpivot/core';
import { RepositoryError, transaction } from './connection.js';
import { FileRepository } from './files.js';
import type { WorkerConfiguration } from './skill-execution.js';
import { clipOutput, sanitizeOutput } from '../output-sanitize.js';
import { parseSandboxInputs, parseSandboxOutputs } from './sandbox-args.js';
import { runSandbox } from './sandbox.js';

/** 与 worker 镜像的预装项保持一致：Python 只有标准库与 Pillow，Node 通过 NODE_PATH 获得办公库。
 *  NODE_PATH 只对 CommonJS 生效，因此 Node 入口固定为 .cjs 并要求用 require 加载依赖。 */
const LANGUAGES = {
  python: { file: 'main.py', command: 'python3 main.py' },
  node: { file: 'main.cjs', command: 'node main.cjs' },
  sh: { file: 'run.sh', command: '/bin/sh run.sh' },
} as const;
type Language = keyof typeof LANGUAGES;
const isLanguage = (value: unknown): value is Language => typeof value === 'string' && Object.hasOwn(LANGUAGES, value);

/** 与 worker 的 files+skills 上限一致；工作目录也受同一条预算约束。 */
const MAX_SANDBOX_BYTES = 16 * 1024 * 1024;

interface WorkspaceFile { versionId: string; name: string; size: number; path: string }

/** 授权记录里只放摘要；完整代码由对话中的工具调用事件保留。 */
function commandSummary(args: Record<string, unknown>): string {
  const language = typeof args['language'] === 'string' ? args['language'] : 'unknown';
  const code = typeof args['code'] === 'string' ? args['code'].split('\n').length : 0;
  const inputs = Array.isArray(args['inputs']) ? args['inputs'].length : 0;
  const outputs = Array.isArray(args['outputs']) ? args['outputs'].length : 0;
  return `${language} 代码 ${code} 行；输入 ${inputs} 个；产物 ${outputs} 个`;
}

export class DatabaseCodeExecution {
  constructor(
    private readonly db: Pool,
    private readonly files: FileRepository,
    private readonly config: WorkerConfiguration,
    private readonly boundRun?: () => { id: string; fence: string } | undefined,
    private readonly guard?: (c: PoolClient, args: Record<string, unknown>, taskId?: string) => Promise<void>,
  ) {}

  async run(actor: string, taskId: string, args: Record<string, unknown>, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const { language, code } = args;
    if (!isLanguage(language)) throw new RepositoryError(400, '执行参数无效：language 只能是 python、node 或 sh');
    if (typeof code !== 'string' || !code.trim() || code.length > 65536) throw new RepositoryError(400, '代码不能为空且不能超过65536字符');
    // inputs 省略时把本轮授权的全部文件当作工作目录；显式填写则只挂载这些版本。
    const inputs = args.inputs === undefined ? undefined : parseSandboxInputs(args.inputs);
    // 产物声明可选：只做计算和读取时返回文本结果，未声明就不会发布任何文件。
    const outputs = args.outputs === undefined ? [] : parseSandboxOutputs(args.outputs);
    const target = LANGUAGES[language];
    const run = await transaction(this.db, async c => (await c.query("SELECT id,fence FROM workpivot.task_runs WHERE task_id=$1 AND status='running' AND NOT context_revoked AND lease_until>now()", [taskId])).rows[0], actor);
    if (!run) throw new RepositoryError(409, '任务已停止');
    const bound = this.boundRun?.();
    if (this.boundRun && (!bound || bound.id !== run.id || bound.fence !== run.fence)) throw new RepositoryError(409, '执行轮次已失效');
    if (this.guard) await transaction(this.db, c => this.guard!(c, args, taskId), actor);
    const scope = await transaction(this.db, async c => (await c.query('SELECT resource_scope FROM workpivot.task_runs WHERE id=$1', [run.id])).rows[0]?.resource_scope, actor);
    const versionIds = inputs ?? (scope?.versionIds ?? []);
    if (inputs === undefined) await this.assertWorkspaceFits(actor, taskId, versionIds);
    const files: [string, string][] = [[target.file, Buffer.from(code, 'utf8').toString('base64')]];
    let size = Buffer.byteLength(code, 'utf8');
    const workspace: WorkspaceFile[] = [];
    for (const id of versionIds) {
      const source = await this.files.download(actor, taskId, id, scope?.versionIds);
      size += source.data.length;
      if (size > MAX_SANDBOX_BYTES) throw new RepositoryError(413, '工作目录超过单次执行16MB上限；请用 inputs 指定本次需要读取的文件版本');
      const path = `inputs/${source.version.id}/${source.version.name}`;
      files.push([path, source.data.toString('base64')]);
      workspace.push({ versionId: id, name: source.version.name, size: source.data.length, path });
    }
    // 清单让模型不必逐个猜路径；文件名重复时以版本ID目录区分。
    if (workspace.length) files.push(['manifest.json', Buffer.from(JSON.stringify({ files: workspace }, null, 2)).toString('base64')]);
    const jobId = randomUUID();
    // skill_executions 是通用执行日志（含运行栅栏、迟到产物判定与恢复），代码执行同样登记一行。
    await transaction(this.db, async c => {
      await c.query('SELECT id FROM workpivot.tasks WHERE id=$1 FOR UPDATE', [taskId]);
      const live = await c.query("SELECT id FROM workpivot.task_runs WHERE id=$1 AND fence=$2 AND status='running' AND NOT context_revoked AND lease_until>now() FOR UPDATE", [run.id, run.fence]);
      if (!live.rowCount) throw new RepositoryError(409, '任务已停止');
      await this.guard?.(c, args, taskId);
      await c.query("INSERT INTO workpivot.skill_executions(id,owner_user_id,task_id,run_id,kind) VALUES($1,$2,$3,$4,'code')", [jobId, actor, taskId, run.id]);
    }, actor);
    try {
      const result = await runSandbox(this.config, { command: target.command, files, skills: [] }, signal);
      const output = clipOutput(sanitizeOutput(result.output));
      if (!outputs.length) {
        await transaction(this.db, c => c.query("UPDATE workpivot.skill_executions SET status='completed',finished_at=now() WHERE id=$1", [jobId]), actor);
        return { output, artifacts: [] };
      }
      const entries = outputs.map(output => {
        const found = result.files.filter(entry => entry[0] === output.name);
        if (found.length !== 1 || !Array.isArray(found[0]) || found[0].length !== 2 || typeof found[0][1] !== 'string') throw new RepositoryError(502, '执行器没有生成全部指定产物');
        const data = Buffer.from(found[0][1], 'base64');
        if (data.toString('base64') !== found[0][1]) throw new RepositoryError(502, '产物编码无效');
        return { ...output, data };
      });
      signal?.throwIfAborted();
      const artifacts = await this.files.uploadArtifacts(actor, taskId, entries, signal, async c => {
        await this.guard?.(c, args, taskId);
        // 上传持有任务锁，停止和删除不会与发布事务发生竞态。
        const live = await c.query("SELECT id FROM workpivot.task_runs WHERE id=$1 AND fence=$2 AND status='running' AND NOT context_revoked AND lease_until>now() FOR UPDATE", [run.id, run.fence]);
        if (!live.rowCount) throw new RepositoryError(409, '运行已停止，未发布产物');
        const job = await c.query("SELECT id FROM workpivot.skill_executions WHERE id=$1 AND status='running' FOR UPDATE", [jobId]);
        if (!job.rowCount) throw new RepositoryError(409, '执行已中断，拒绝迟到产物');
        const remaining = await c.query('SELECT v.id FROM workpivot.document_versions v JOIN workpivot.documents d ON d.id=v.document_id WHERE (d.task_id=$1 OR ($3::boolean AND EXISTS(SELECT 1 FROM workpivot.tasks source JOIN workpivot.tasks target ON target.id=$1 AND target.project_id=source.project_id WHERE source.id=d.task_id AND source.deleted_at IS NULL AND target.deleted_at IS NULL))) AND v.id=ANY($2::uuid[])', [taskId, versionIds, !!scope]);
        if (remaining.rowCount !== versionIds.length) throw new RepositoryError(409, '输入文件已删除，未发布产物');
      }, async (c, published) => {
        for (const version of published) await c.query('INSERT INTO workpivot.execution_artifacts(owner_user_id,execution_id,version_id) VALUES($1,$2,$3)', [actor, jobId, version.id]);
        await c.query("UPDATE workpivot.skill_executions SET status='completed',artifact_id=$2,finished_at=now() WHERE id=$1", [jobId, published[0]!.id]);
      });
      return { output, artifacts: artifacts.map(version => ({ id: version.id, name: version.name })) };
    } catch (error) {
      try { await transaction(this.db, c => c.query("UPDATE workpivot.skill_executions SET status=$2,error=$3,finished_at=now() WHERE id=$1 AND status='running'", [jobId, signal?.aborted ? 'interrupted' : 'failed', signal?.aborted ? '执行已停止；请检查已有产物后重新发起' : '执行未完成；请查看对话中的错误详情']), actor); } catch { /* 租约到期后由恢复流程判定结果不明的作业。 */ }
      throw error;
    }
  }

  /** 省略 inputs 时先按清单核对总量，避免为超限范围逐个读取文件。 */
  private async assertWorkspaceFits(actor: string, taskId: string, versionIds: string[]): Promise<void> {
    if (!versionIds.length) return;
    const [uploads, artifacts] = await Promise.all([
      this.files.list(actor, taskId, 'upload', versionIds),
      this.files.list(actor, taskId, 'artifact', versionIds),
    ]);
    const total = [...uploads, ...artifacts].reduce((sum, version) => sum + version.size, 0);
    if (total > MAX_SANDBOX_BYTES) throw new RepositoryError(413, `本轮授权文件合计 ${(total / 1024 / 1024).toFixed(1)}MB，超过单次执行16MB上限；请用 inputs 指定本次需要读取的文件版本`);
  }

  tool(actor: string, taskId: string): Tool {
    return {
      name: 'run_code', displayName: '运行代码', kind: 'write',
      description: '没有专用工具时，在无网络隔离沙箱里写代码解决问题。先判断能否用已有工具（文件解析、检索、网页读取、成果保存）；确实没有对应工具或需要自定义计算时才用本工具。language 取 python、node 或 sh，代码写入 /workspace 后执行，工作目录 /workspace。Python 只有标准库和 Pillow；Node 用 CommonJS 的 require 加载 docx、exceljs、pptxgenjs（通过 NODE_PATH）；不能联网安装依赖、不能访问宿主路径、不会保留后台进程，单次最长 120 秒。本轮授权的文件会自动按原名挂到 /workspace/inputs/<版本ID>/，完整清单在 /workspace/manifest.json；只读其中一部分时可填 inputs 指定文件版本 ID（不是 documentId），未列入的文件不会进入沙箱。需要保存文件时用 outputs 声明 1 至 10 个产物，name 只填文件名（如 report.docx），代码必须写到 /workspace/report.docx；更新已有成果要填 list_artifacts 返回的 documentId 和当前 revision。未声明 outputs 时只返回标准输出，写入的文件全部丢弃。不要用它代替网页访问，也不要声称读取了未列出的文件。',
      parameters: {
        type: 'object',
        properties: {
          language: { type: 'string', enum: ['python', 'node', 'sh'], description: 'python 用 python3 执行 main.py；node 用 node 执行 main.cjs（CommonJS）；sh 用 /bin/sh 执行 run.sh' },
          code: { type: 'string', description: '完整可执行代码；不得包含密钥或未选择的业务样本' },
          inputs: { type: 'array', description: '只读取其中一部分文件时填写；省略则由服务器挂载本轮授权的全部文件。未列入的文件不会提供给代码。', items: { type: 'string' }, maxItems: 10 },
          outputs: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'object', properties: { name: { type: 'string', description: '只填文件名，不含路径，例如 report.docx' }, documentId: { type: 'string' }, revision: { type: 'integer', minimum: 1 } }, required: ['name'], additionalProperties: false } },
        },
        required: ['language', 'code'],
        additionalProperties: false,
      },
      // 静默执行：不弹授权卡，但仍受运行读取范围与产物目标校验约束，代码保留在对话事件中。
      access: args => ({ auto: true, external: true, tool: 'run_code', kind: 'write', paths: [], command: commandSummary(args) }),
      run: async (args, ctx) => JSON.stringify(await this.run(actor, taskId, args, ctx.signal)),
    };
  }
}
