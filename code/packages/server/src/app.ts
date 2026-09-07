/**
 * Express 应用与全部路由。
 * W1：供应商/任务/SSE 对话；W2：登录门/权限档位/授权卡/审计/@引用/并行上限。
 */
import express, { type Express, type Request } from 'express';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve as resolvePath } from 'node:path';
import {
  BUILTIN_TOOLS,
  MAX_STEPS_DEFAULT,
  createAnthropicClient,
  createOpenAICompatibleClient,
  runAgentLoop,
  verifyAnthropicProvider,
  verifyProvider,
  type ChatMessage,
  type ModelClient,
  type ToolAccessRequest,
} from '@workpivot/core';
import { verifyClaimedFiles } from './chat-gate.js';
import { disabledSkills, findSkillBySlash, listSkills, renderSkillDirectory, setSkillDisabled } from './skills.js';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  needsSetup,
  registerFirstAdmin,
  login as authLogin,
  resolveToken,
  createUser,
  deleteUser,
  changePassword,
  updateUserRole,
  updateUserProfile,
  listUsers,
  type PublicUser,
  type Role,
} from './auth.js';
import { evaluateAccess, getTier, resolvePendingRequest, setTier, TIER_LABELS, listAllowDirs, type Decision, type Tier } from './permissions.js';
import { appendTranscript, createTask, getTask, listTasks, readHistory, readTranscript, updateTaskStatus } from './tasks.js';
import { audit, argsHash, readAllAudit } from './audit.js';
import { deleteProvider, listProviders, resolveActiveProvider, saveProvider, setActiveProvider, updateProvider } from './providers.js';
import { listTrash } from './trash.js';
import { addTemplate, deleteTemplate, listTemplates, renderTemplateInjection, setDefaultTemplate } from './templates.js';
import { addSchedule, cronIsValid, deleteSchedule, listNotifications, listSchedules, runScheduleNow, updateSchedule } from './schedules.js';
import { analyzeRisk } from './risk-analysis.js';
import {
  DEFAULT_PROJECT_ID,
  createProject,
  deleteProject,
  ensureDefaultProject,
  getProject,
  listProjects,
  renameProject,
} from './projects.js';
import { deleteTempTask, workspaceRoot } from './tasks.js';
import { buildMemoryTools, resolveMemoryConfirm } from './memory-tools.js';
import { buildPlanTool, readPlan } from './plan.js';
import { initProjectMemory, memoryView, removeEntryById, renderMemoryInjection, setMemoryEnabled, writeHandbook } from './memory.js';

export interface AppOptions {
  /** 前端构建产物目录（apps/web/dist）。存在则托管静态资源并提供 SPA 回退。 */
  webDistDir?: string;
}

interface AuthedRequest extends Request {
  user?: PublicUser;
}

/** 运行中的 agent 会话（taskId → 中止控制器）。 */
const running = new Map<string, AbortController>();

const PARALLEL_LIMIT = 8;

// app.use('/api') 下 req.path 为相对路径（如 '/auth/login'）
const PUBLIC_PATHS = new Set(['/health', '/auth/state', '/auth/login', '/auth/register']);

export function createApp(opts: AppOptions = {}): Express {
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  // T4-02：bash 子进程的 NODE_PATH——让技能脚本 require 应用内置依赖（如 docx）。
  // 桌面打包态 import.meta 不可用：由 Electron 主进程注入 WORKPIVOT_NODE_PATH；其余走模块位置/工作目录回退。
  let bashNodePath = process.env['WORKPIVOT_NODE_PATH'] ?? '';
  if (bashNodePath === '') {
    try {
      const serverModuleDir = dirname(fileURLToPath(import.meta.url));
      const nodePathCandidates = [
        join(serverModuleDir, 'node_modules'),
        join(serverModuleDir, '..', 'node_modules'),
        join(serverModuleDir, '..', '..', 'node_modules'),
      ].filter(existsSync);
      bashNodePath = nodePathCandidates.join(delimiter);
    } catch {
      bashNodePath = '';
    }
  }

  // ---- 认证（T2-01）：除公开路径外全部要求 Bearer 令牌 ----
  app.use('/api', (req, res, next) => {
    if (PUBLIC_PATHS.has(req.path)) return next();
    const header = req.headers.authorization;
    const user = resolveToken(header?.startsWith('Bearer ') ? header.slice(7) : undefined);
    if (!user) return res.status(401).json({ error: '未登录或会话已过期' });
    (req as AuthedRequest).user = user;
    next();
  });

  function requireAdmin(req: AuthedRequest): PublicUser | null {
    return req.user?.role === 'admin' ? req.user : null;
  }

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, name: 'workpivot', ts: Date.now() });
  });

  // ---- 认证路由 ----
  app.get('/api/auth/state', (req, res) => {
    const header = req.headers.authorization;
    const user = resolveToken(header?.startsWith('Bearer ') ? header.slice(7) : undefined);
    res.json({ needsSetup: needsSetup(), authenticated: Boolean(user), user: user ?? null });
  });

  app.post('/api/auth/register', (req, res) => {
    const { username, password } = req.body as { username?: string; password?: string };
    if (!username || !password) return res.status(400).json({ error: 'username/password 必填' });
    try {
      res.json(registerFirstAdmin(username, password));
    } catch (err) {
      res.status(403).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body as { username?: string; password?: string };
    if (!username || !password) return res.status(400).json({ error: 'username/password 必填' });
    try {
      res.json(authLogin(username, password));
    } catch (err) {
      res.status(401).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/auth/logout', (req, res) => {
    // M0 薄实现：客户端丢弃令牌即可；服务端令牌清理随会话过期策略（M1）
    res.json({ ok: true });
  });

  app.post('/api/auth/password', (req, res) => {
    const user = (req as AuthedRequest).user;
    if (!user) return res.status(401).json({ error: '未登录或会话已过期' });
    const { currentPassword, newPassword } = req.body as { currentPassword?: string; newPassword?: string };
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'currentPassword/newPassword 必填' });
    const result = changePassword(user.id, currentPassword, newPassword);
    if (result.ok) res.json({ ok: true });
    else res.status(400).json({ error: result.error });
  });

  // ---- 用户管理（仅管理员）----
  app.get('/api/users', (req, res) => {
    if (!requireAdmin(req as AuthedRequest)) return res.status(403).json({ error: '仅管理员可查看用户' });
    res.json({ users: listUsers().map((u) => ({ ...u, createdAt: u.createdAt, lastLoginTime: u.lastLoginTime })) });
  });

  app.delete('/api/users/:id', (req, res) => {
    const admin = requireAdmin(req as AuthedRequest);
    if (!admin) return res.status(403).json({ error: '仅管理员可删除用户' });
    const result = deleteUser(req.params['id'] ?? '', admin.id);
    if (result.ok) {
      audit({ user: admin.username, event: 'user_deleted', detail: req.params['id'] });
      res.json({ ok: true });
    } else {
      res.status(400).json({ error: result.error });
    }
  });

  app.put('/api/users/:id/role', (req, res) => {
    const admin = requireAdmin(req as AuthedRequest);
    if (!admin) return res.status(403).json({ error: '仅管理员可修改角色' });
    const { role } = req.body as { role?: Role };
    if (!role || (role !== 'admin' && role !== 'member')) return res.status(400).json({ error: 'role 必填' });
    const result = updateUserRole(req.params['id'] ?? '', role);
    if (result.ok) {
      audit({ user: admin.username, event: 'user_role_changed', detail: `${req.params['id']} → ${role}` });
      res.json({ ok: true });
    } else {
      res.status(400).json({ error: result.error });
    }
  });

  app.patch('/api/users/:id', (req, res) => {
    const admin = requireAdmin(req as AuthedRequest);
    if (!admin) return res.status(403).json({ error: '仅管理员可修改用户' });
    const { email } = req.body as { email?: string | null };
    if (email === undefined) return res.status(400).json({ error: 'email 必填' });
    const result = updateUserProfile(req.params['id'] ?? '', email);
    if (result.ok) res.json({ ok: true });
    else res.status(400).json({ error: result.error });
  });

  app.post('/api/users', (req, res) => {
    const admin = requireAdmin(req as AuthedRequest);
    if (!admin) return res.status(403).json({ error: '仅管理员可创建用户' });
    const { username, password, role, email } = req.body as { username?: string; password?: string; role?: Role; email?: string };
    if (!username || !password || !role) return res.status(400).json({ error: 'username/password/role 必填' });
    try {
      const user = createUser(username, password, role === 'admin' ? 'admin' : 'member', email);
      audit({ user: admin.username, event: 'user_created', detail: `${user.username}(${user.role})` });
      res.json({ user });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ---- 设置：权限档位 ----
  app.get('/api/settings', (_req, res) => {
    res.json({ permissionTier: getTier(), tierLabels: TIER_LABELS, allowDirs: listAllowDirs() });
  });

  app.put('/api/settings/tier', (req, res) => {
    const { tier } = req.body as { tier?: Tier };
    if (!tier || !(tier in TIER_LABELS)) return res.status(400).json({ error: `tier 必须是：${Object.keys(TIER_LABELS).join('/')}` });
    setTier(tier);
    audit({ event: 'tier_changed', decision: tier });
    res.json({ permissionTier: getTier() });
  });

  // ---- 供应商（C02/C03：管理员=本机用户；key 密文落盘，接口永远打码）----
  app.get('/api/providers', (_req, res) => {
    res.json(listProviders());
  });

  // ---- F3 Skill 管理（仅管理员；停用技能不注入目录）----
  app.get('/api/skills', (req, res) => {
    if (requireAdmin(req as AuthedRequest) === null) return res.status(403).json({ error: '仅管理员可查看技能' });
    const skills = listSkills(workspaceRoot(), { includeDisabled: true });
    res.json({
      skills: skills.map((s) => ({ name: s.name, description: s.description, source: s.source, disabled: disabledSkills().includes(s.name) })),
    });
  });
  app.post('/api/skills/toggle', (req, res) => {
    if (requireAdmin(req as AuthedRequest) === null) return res.status(403).json({ error: '仅管理员可启停技能' });
    const { name, disabled } = req.body as { name?: string; disabled?: boolean };
    if (!name || disabled === undefined) return res.status(400).json({ error: 'name/disabled 必填' });
    setSkillDisabled(name, disabled);
    audit({ user: (req as AuthedRequest).user?.username, event: 'skill_toggled', tool: name, decision: disabled ? 'disabled' : 'enabled' });
    res.json({ ok: true });
  });

  app.post('/api/providers/verify', async (req, res) => {
    const { baseUrl, apiKey, protocol } = req.body as { baseUrl?: string; apiKey?: string; protocol?: string };
    if (!baseUrl) return res.status(400).json({ error: 'baseUrl 必填' });
    // M1-06：按协议分流验活
    const result = protocol === 'anthropic' ? await verifyAnthropicProvider(baseUrl, apiKey) : await verifyProvider(baseUrl, apiKey);
    res.json(result);
  });

  app.post('/api/providers', async (req, res) => {
    // F3：模型配置收敛到管理后台——仅管理员（桌面成员 403）
    if (requireAdmin(req as AuthedRequest) === null) return res.status(403).json({ error: '仅管理员可配置模型' });
    const { name, baseUrl, modelId, apiKey, verify, protocol } = req.body as {
      name?: string; baseUrl?: string; modelId?: string; apiKey?: string; verify?: boolean; protocol?: string;
    };
    if (!name || !baseUrl || !modelId) return res.status(400).json({ error: 'name/baseUrl/modelId 必填' });
    try {
      const result = await saveProvider({ name, baseUrl, modelId, apiKey, verify, protocol });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.put('/api/providers/:id', async (req, res) => {
    // F3：编辑供应商（仅管理员；apiKey 留空 = 保留原 key）
    if (requireAdmin(req as AuthedRequest) === null) return res.status(403).json({ error: '仅管理员可配置模型' });
    const { name, baseUrl, modelId, apiKey, verify, protocol } = req.body as {
      name?: string; baseUrl?: string; modelId?: string; apiKey?: string; verify?: boolean; protocol?: string;
    };
    if (!name || !baseUrl || !modelId) return res.status(400).json({ error: 'name/baseUrl/modelId 必填' });
    try {
      const result = await updateProvider(req.params['id'] ?? '', { name, baseUrl, modelId, apiKey, verify, protocol });
      audit({ user: (req as AuthedRequest).user?.username, event: 'provider_updated', detail: name });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete('/api/providers/:id', (req, res) => {
    // F3：删除供应商（仅管理员；删激活项自动顺延）
    if (requireAdmin(req as AuthedRequest) === null) return res.status(403).json({ error: '仅管理员可配置模型' });
    try {
      deleteProvider(req.params['id'] ?? '');
      audit({ user: (req as AuthedRequest).user?.username, event: 'provider_deleted', detail: req.params['id'] });
      res.json({ ok: true });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/providers/active', (req, res) => {
    if (requireAdmin(req as AuthedRequest) === null) return res.status(403).json({ error: '仅管理员可切换模型' });
    const { id } = req.body as { id?: string };
    if (!id) return res.status(400).json({ error: 'id 必填' });
    try {
      res.json({ provider: setActiveProvider(id) });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ---- 任务（B01：任务=对话+真实目录）----
  app.get('/api/tasks', (_req, res) => {
    res.json({ tasks: listTasks() });
  });

  app.post('/api/tasks', (req, res) => {
    const { name, directory, projectId, temp } = req.body as {
      name?: string; directory?: string; projectId?: string; temp?: boolean;
    };
    if (!name || name.trim() === '') return res.status(400).json({ error: 'name 必填' });

    // F1/F2：工作目录解析——临时任务落 _temp；项目任务共享项目目录；显式 directory 优先（兼容旧客户端）
    let resolvedDir = directory ?? '';
    let resolvedProjectId: string | null = projectId ?? null;
    if (temp) {
      resolvedProjectId = null;
      resolvedDir = directory ?? join(workspaceRoot(), '_temp', `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    } else if (projectId) {
      const project = getProject(projectId);
      if (!project) return res.status(404).json({ error: '项目不存在' });
      resolvedDir = project.directory;
    } else {
      resolvedProjectId = ensureDefaultProject().id;
      resolvedDir = directory ?? ensureDefaultProject().directory;
    }

    const task = createTask({ name, directory: resolvedDir, projectId: resolvedProjectId, temp: temp === true });
    if (!temp) initProjectMemory(task.directory);
    audit({ event: 'task_created', taskId: task.id, detail: task.directory, decision: temp ? 'temp' : 'project' });
    res.json({ task });
  });

  app.delete('/api/tasks/:id', (req, res) => {
    const result = deleteTempTask(req.params['id'] ?? '');
    if (result.ok) {
      audit({ event: 'task_deleted', taskId: req.params['id'] });
      res.json({ ok: true });
    } else {
      res.status(400).json({ error: result.error });
    }
  });

  app.get('/api/tasks/:id', (req, res) => {
    const task = getTask(req.params['id'] ?? '');
    if (!task) return res.status(404).json({ error: '任务不存在' });
    res.json({ task, history: readHistory(task.id) });
  });

  // 右栏（W1）：任务目录的文件清单（含 attachments/ 子目录内的文件，前缀显示）
  app.get('/api/tasks/:id/files', (req, res) => {
    const task = getTask(req.params['id'] ?? '');
    if (!task) return res.status(404).json({ error: '任务不存在' });
    const files: string[] = [];
    if (existsSync(task.directory)) {
      files.push(...readdirSync(task.directory).slice(0, 200));
      const attDir = join(task.directory, 'attachments');
      if (existsSync(attDir)) {
        for (const f of readdirSync(attDir)) files.push(`attachments/${f}`);
      }
    }
    res.json({ directory: task.directory, files });
  });

  // U5/附件上传：裸体流，?name= 指定文件名；basename 消毒防穿越；写入 attachments/ 子目录（重名加序号）
  app.post(
    '/api/tasks/:id/attachments',
    express.raw({ type: '*/*', limit: '50mb' }),
    (req, res) => {
      const user = (req as AuthedRequest).user;
      const task = getTask(req.params['id'] ?? '');
      if (!task) return res.status(404).json({ error: '任务不存在' });
      const rawName = String(req.query['name'] ?? '');
      const safe = rawName.replace(/^.*[\/]/, '').replace(/[\/:*?"<>|]/g, '_').trim();
      if (safe === '') return res.status(400).json({ error: 'name 必填' });
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: '空文件' });

      const dir = join(task.directory, 'attachments');
      mkdirSync(dir, { recursive: true });
      const dot = safe.lastIndexOf('.');
      const stem = dot > 0 ? safe.slice(0, dot) : safe;
      const ext = dot > 0 ? safe.slice(dot) : '';
      // 重名自动加序号
      let final = safe;
      let n = 1;
      while (existsSync(join(dir, final))) {
        final = dot > 0 ? `${stem}-${n}${ext}` : `${stem}-${n}`;
        n += 1;
      }
      writeFileSync(join(dir, final), req.body);
      audit({ user: user?.username, taskId: task.id, event: 'attachment_uploaded', tool: 'upload', detail: `${final}（${req.body.length}B）` });
      res.json({ name: final, size: req.body.length });
    },
  );

  // ---- 对话（SSE 流式）----
  app.post('/api/tasks/:id/messages', (req, res) => {
    const user = (req as AuthedRequest).user;
    const task = getTask(req.params['id'] ?? '');
    if (!task) return res.status(404).json({ error: '任务不存在' });
    const { content } = req.body as { content?: string };
    if (!content || content.trim() === '') return res.status(400).json({ error: 'content 必填' });
    if (running.has(task.id)) return res.status(409).json({ error: '该任务正在运行中' });
    if (running.size >= PARALLEL_LIMIT) return res.status(429).json({ error: `并行任务已达上限 ${PARALLEL_LIMIT} 个` });

    let client: ModelClient;
    try {
      // M1-06：按供应商协议选客户端（openai 兼容 / anthropic Messages）
      const cfg = resolveActiveProvider();
      client = cfg.protocol === 'anthropic' ? createAnthropicClient(cfg) : createOpenAICompatibleClient(cfg);
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const send = (payload: unknown): void => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    // T4-01：技能热加载（每任务重读磁盘）+ 斜杠激活
    const skills = listSkills(task.directory);
    let effectiveContent = content;
    const activeSkill = findSkillBySlash(skills, content);
    if (activeSkill) {
      effectiveContent = `【技能 ${activeSkill.name} 已激活——严格按以下技能说明执行】
${activeSkill.content}

【用户消息】
${content}`;
    }

    // @文件引用（T2-02）：把引用文件内容展开进消息
    let expanded = expandFileRefs(effectiveContent, task.directory);
    // U5 附件注入：发送时携带的附件名单（attachments/ 下已上传文件）内容自动进上下文
    const attachNames = (req.body as { attachments?: string[] }).attachments;
    if (Array.isArray(attachNames) && attachNames.length > 0) {
      for (const name of attachNames) {
        const safeName = String(name).replace(/^.*[\/]/, '');
        const p = join(task.directory, 'attachments', safeName);
        if (existsSync(p)) {
          const text = readFileSync(p, 'utf8');
          const capped = text.length > 64_000 ? `${text.slice(0, 64_000)}…（截断）` : text;
          expanded += `

--- 上传附件 ${safeName} ---
${capped}
--- 附件结束 ---`;
        }
      }
    }

    const history: ChatMessage[] = readHistory(task.id).map((m) => ({ role: m.role, content: m.content }));
    history.push({ role: 'user', content: expanded });
    appendTranscript(task.id, 'user_message', { content: expanded });

    const controller = new AbortController();
    running.set(task.id, controller);
    updateTaskStatus(task.id, 'running');
    // 注意：req 的 'close' 在请求体读完即触发（Node 16+），不能作为客户端断开信号
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
      running.delete(task.id);
    });
    // SSE 心跳：长工具执行期无事件流，TCP 缓冲不满时服务端察觉不到客户端断开——
    // 每 15s 写一行注释帧迫使缓冲滚动，socket 死亡即刻触发 res 'close' → abort
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, 15_000);
    const stopHeartbeat = (): void => clearInterval(heartbeat);

    let system = buildSystemPrompt(task.directory, getTier()) + renderSkillDirectory(skills);
    system += renderMemoryInjection(user?.id ?? 'local', task.directory);
    system += renderTemplateInjection();
    system += [
      '',
      '# 记忆纪律',
      '用户明确要求记住信息时,用 remember 工具保存(条目区,静默生效)。',
      '把信息写入长期记忆(手写区)用 promote_memory 工具,调用后会弹出确认卡,用户可拒绝。',
      '用户要求忘掉某事时用 forget 工具。',
      '项目的长期信息写入 .workpivot/memory/MEMORY.md(用 write 工具),随项目目录走。',
      '# 访问纪律（I02）',
      '访问被用户拒绝后，不要改用其他工具或命令达成同一目的；应告知用户并停止。',
      '# 计划纪律（A03）',
      '多步任务（预计 ≥3 步）开工前先用 update_plan 建立阶段计划；每完成一个阶段或计划调整时全量更新；阶段全部完成后收尾。',
    ].join('\n');

    const requestAccess: (req: ToolAccessRequest) => Promise<boolean> = async (access) => {
      const result = await evaluateAccess(
        { tool: access.tool, kind: access.kind, paths: access.paths, command: access.command, taskDir: task.directory },
        (request) => {
          send({ type: 'permission_request', ...request });
          // R002：高危/界外授权卡异步附加 AI 风险解读（不阻塞确认；失败静默无解读）
          const risky = /高危|任务目录之外/.test(request.reason ?? '');
          if (risky) {
            void analyzeRisk({
              id: request.id,
              tool: request.tool,
              kind: request.kind,
              command: request.command,
              paths: request.paths,
              reason: request.reason,
              userContext: expanded,
            }).then((analysis) => {
              if (analysis !== '') send({ type: 'risk_analysis', id: request.id, analysis });
            });
          }
        },
      );
      audit({
        user: user?.username,
        taskId: task.id,
        event: 'tool_access',
        tool: access.tool,
        decision: result.allowed ? 'allow' : 'deny',
        detail: result.auditedReason,
        argsHash: argsHash({ paths: access.paths, command: access.command }),
      });
      return result.allowed;
    };

    // T3-06/K04：大结果落盘到任务目录 .workpivot/results/，模型只拿预览+路径
    const stashResult = async (content: string): Promise<string> => {
      const dir = join(task.directory, '.workpivot', 'results');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `result-${Date.now()}.txt`);
      writeFileSync(file, content, 'utf8');
      appendTranscript(task.id, 'meta', { event: 'result_stashed', path: file, size: content.length });
      return `（工具结果过大已落盘:${file}。可用 read 工具读取完整内容。）\n前 2000 字符预览:\n${content.slice(0, 2000)}`;
    };

    const maxSteps = Number(process.env['WORKPIVOT_MAX_STEPS']) || MAX_STEPS_DEFAULT;
    const maxDurationMs = (Number(process.env['WORKPIVOT_MAX_MINUTES']) || 30) * 60_000;

    // T3-03/F02：带核验闸门的执行——声称产出但文件缺失 → 打回重做（≤2 次）
    const runWithGate = async (attempt: number, baseMessages: ChatMessage[]): Promise<{ stopReason: string; steps: number }> => {
      const result = await runAgentLoop({
        client,
        tools: [...BUILTIN_TOOLS, ...memoryTools, planTool],
        system,
        messages: baseMessages,
        taskDir: task.directory,
        requestAccess,
        maxSteps,
        maxDurationMs,
        stashResult,
        extraEnv: bashNodePath ? { NODE_PATH: bashNodePath } : undefined,
        signal: controller.signal,
        onEvent: (event) => {
          send(event);
          if (event.type === 'tool_use') {
            appendTranscript(task.id, 'tool_use', { toolName: event.toolName, args: event.args });
            audit({ user: user?.username, taskId: task.id, event: 'tool_use', tool: event.toolName, argsHash: argsHash(event.args) });
          }
          if (event.type === 'tool_result') {
            appendTranscript(task.id, 'tool_result', { toolName: event.toolName, ok: event.ok, summary: event.message });
          }
        },
      });

      const finalText = [...result.messages]
        .reverse()
        .find((m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.length > 0)?.content;
      if (typeof finalText === 'string' && finalText.length > 0) {
        appendTranscript(task.id, 'assistant_message', { content: finalText });
      }

      if (result.stopReason === 'completed' && typeof finalText === 'string' && finalText.length > 0) {
        const { missing } = verifyClaimedFiles(finalText, task.directory);
        if (missing.length > 0 && attempt < 2) {
          audit({ user: user?.username, taskId: task.id, event: 'gate_reject', decision: 'retry', detail: missing.join('、') });
          send({ type: 'gate_reject', missing });
          const note = `核验失败:以下声称产出的文件在任务目录中不存在或为空:${missing.join('、')}。请用 write 工具实际生成这些文件,然后重新给出总结。`;
          appendTranscript(task.id, 'user_message', { content: note });
          baseMessages.push({ role: 'user', content: note });
          return runWithGate(attempt + 1, baseMessages);
        }
        if (missing.length > 0) {
          send({ type: 'gate_reject', missing, final: true });
        }
      }
      return { stopReason: result.stopReason, steps: result.steps };
    }

    const memoryTools = buildMemoryTools(user?.id ?? 'local', task.id, send);
    const planTool = buildPlanTool(task.id, send);

    void runWithGate(0, history)
      .then((result) => {
        updateTaskStatus(task.id, result.stopReason === 'completed' ? 'idle' : 'interrupted');
        audit({ user: user?.username, taskId: task.id, event: 'task_done', decision: result.stopReason, detail: `${result.steps} 步` });
        send({ type: 'done', stopReason: result.stopReason, steps: result.steps });
      })
      .catch((err: unknown) => {
        updateTaskStatus(task.id, 'interrupted');
        send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => {
        stopHeartbeat();
        running.delete(task.id);
        res.end();
      });
  });

  // W2/彩排修复：运行中可停止——中止 agent 循环（模型流/工具随即中断，任务转 interrupted）
  app.post('/api/tasks/:id/stop', (req, res) => {
    const task = getTask(req.params['id'] ?? '');
    if (!task) return res.status(404).json({ error: '任务不存在' });
    const controller = running.get(task.id);
    if (!controller) return res.status(409).json({ error: '该任务未在运行中' });
    controller.abort();
    audit({ user: (req as AuthedRequest).user?.username, taskId: task.id, event: 'task_stopped', decision: 'stopped' });
    res.json({ ok: true });
  });

  // M1/E01：记忆确认卡回填 + 查看/开关
  app.post('/api/tasks/:id/memory/confirm', (req, res) => {
    const { id: confirmId, approve } = req.body as { id?: string; approve?: boolean };
    if (!confirmId || approve === undefined) return res.status(400).json({ error: 'id/approve 必填' });
    const ok = resolveMemoryConfirm(confirmId, Boolean(approve));
    audit({ user: (req as AuthedRequest).user?.username, taskId: req.params['id'], event: 'memory_confirm', decision: approve ? 'allow' : 'deny', detail: confirmId });
    if (ok) res.json({ ok: true });
    else res.status(404).json({ error: '确认请求不存在或已处理' });
  });

  app.get('/api/memory', (req, res) => {
    const user = (req as AuthedRequest).user;
    if (!user) return res.status(401).json({ error: '未登录' });
    const taskId = req.query['taskId'] as string | undefined;
    const taskDir = taskId ? (getTask(taskId)?.directory ?? '') : '';
    res.json(memoryView(user.id, taskDir));
  });

  app.post('/api/memory/toggle', (req, res) => {
    const { enabled } = req.body as { enabled?: boolean };
    if (enabled === undefined) return res.status(400).json({ error: 'enabled 必填' });
    setMemoryEnabled(enabled);
    audit({ user: (req as AuthedRequest).user?.username, event: 'memory_toggled', decision: enabled ? 'on' : 'off' });
    res.json({ enabled });
  });

  // M1-11：设置页记忆面板——手写区编辑（MEMORY.md 全量替换，长度封顶防滥用）
  app.put('/api/memory/handbook', (req, res) => {
    const user = (req as AuthedRequest).user;
    if (!user) return res.status(401).json({ error: '未登录' });
    const { content } = req.body as { content?: string };
    if (typeof content !== 'string') return res.status(400).json({ error: 'content 必填（字符串）' });
    if (content.length > 20_000) return res.status(400).json({ error: '手写区超过 20000 字符上限' });
    writeHandbook(user.id, content);
    audit({ user: user.username, event: 'memory_handbook_edited', detail: `${content.length} 字符` });
    res.json({ ok: true });
  });

  // M1-11：设置页记忆面板——按 id 删除单条条目
  app.delete('/api/memory/entries/:id', (req, res) => {
    const user = (req as AuthedRequest).user;
    if (!user) return res.status(401).json({ error: '未登录' });
    const ok = removeEntryById(user.id, req.params['id'] ?? '');
    if (!ok) return res.status(404).json({ error: '条目不存在' });
    audit({ user: user.username, event: 'memory_entry_deleted', detail: req.params['id'] });
    res.json({ ok: true });
  });

  // ---- M1-10：审计查看/导出（I03）+ 回收站清单（B03），仅管理员 ----
  app.get('/api/audit', (req, res) => {
    if (requireAdmin(req as AuthedRequest) === null) return res.status(403).json({ error: '仅管理员可查看审计' });
    const rows = readAllAudit().slice(-500).map((line) => JSON.parse(line) as Record<string, unknown>);
    res.json({ rows });
  });

  app.get('/api/audit/export', (req, res) => {
    if (requireAdmin(req as AuthedRequest) === null) return res.status(403).json({ error: '仅管理员可导出审计' });
    const rows = readAllAudit();
    audit({ user: (req as AuthedRequest).user?.username, event: 'audit_exported', detail: `${rows.length} 行` });
    res.setHeader('content-type', 'application/jsonl; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="workpivot-audit-${new Date().toISOString().slice(0, 10)}.jsonl"`);
    res.send(rows.join('\n'));
  });

  app.get('/api/trash', (req, res) => {
    if (requireAdmin(req as AuthedRequest) === null) return res.status(403).json({ error: '仅管理员可查看回收站' });
    res.json({ items: listTrash() });
  });

  // ---- M1-07/H01：企业 Word 模板（上传/设默认/删除；清单全员可读——生成链要拿路径） ----
  app.get('/api/templates', (req, res) => {
    void req;
    res.json({ templates: listTemplates() });
  });

  app.post(
    '/api/templates',
    express.raw({ type: () => true, limit: '20mb' }),
    (req, res) => {
      const admin = requireAdmin(req as AuthedRequest);
      if (!admin) return res.status(403).json({ error: '仅管理员可上传模板' });
      const name = String(req.query['name'] ?? '');
      const kind = String(req.query['kind'] ?? 'general');
      if (name.trim() === '') return res.status(400).json({ error: 'name 必填' });
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: '请求体必须是 .docx 二进制' });
      try {
        const tpl = addTemplate(name.trim(), kind, req.body);
        audit({ user: admin.username, event: 'template_uploaded', detail: `${tpl.name}(${tpl.kind})` });
        res.json({ template: tpl });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.put('/api/templates/:id/default', (req, res) => {
    const admin = requireAdmin(req as AuthedRequest);
    if (!admin) return res.status(403).json({ error: '仅管理员可设置默认模板' });
    try {
      const tpl = setDefaultTemplate(req.params['id'] ?? '');
      audit({ user: admin.username, event: 'template_default_set', detail: tpl.name });
      res.json({ template: tpl });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete('/api/templates/:id', (req, res) => {
    const admin = requireAdmin(req as AuthedRequest);
    if (!admin) return res.status(403).json({ error: '仅管理员可删除模板' });
    try {
      deleteTemplate(req.params['id'] ?? '');
      audit({ user: admin.username, event: 'template_deleted', detail: req.params['id'] });
      res.json({ ok: true });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ---- M1-09/F06：定时任务（管理=仅管理员；清单/通知全员可读） ----
  app.get('/api/schedules', (req, res) => {
    void req;
    res.json({ schedules: listSchedules() });
  });

  app.post('/api/schedules', (req, res) => {
    const admin = requireAdmin(req as AuthedRequest);
    if (!admin) return res.status(403).json({ error: '仅管理员可创建定时任务' });
    const { name, cron, content, taskName, catchup } = req.body as {
      name?: string; cron?: string; content?: string; taskName?: string; catchup?: boolean;
    };
    if (!name || !cron || !content || !taskName) return res.status(400).json({ error: 'name/cron/content/taskName 必填' });
    if (!cronIsValid(cron)) return res.status(400).json({ error: `cron 表达式非法：${cron}（5 字段：分 时 日 月 周）` });
    try {
      const schedule = addSchedule({ name, cron, content, taskName, catchup: catchup === true, ownerUserId: admin.id });
      audit({ user: admin.username, event: 'schedule_created', detail: `${name} ${cron}` });
      res.json({ schedule });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.put('/api/schedules/:id', (req, res) => {
    const admin = requireAdmin(req as AuthedRequest);
    if (!admin) return res.status(403).json({ error: '仅管理员可修改定时任务' });
    const patch = req.body as { name?: string; cron?: string; content?: string; enabled?: boolean; catchup?: boolean };
    try {
      const schedule = updateSchedule(req.params['id'] ?? '', patch);
      audit({ user: admin.username, event: 'schedule_updated', detail: `${schedule.name} ${JSON.stringify(patch)}`.slice(0, 200) });
      res.json({ schedule });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete('/api/schedules/:id', (req, res) => {
    const admin = requireAdmin(req as AuthedRequest);
    if (!admin) return res.status(403).json({ error: '仅管理员可删除定时任务' });
    try {
      deleteSchedule(req.params['id'] ?? '');
      audit({ user: admin.username, event: 'schedule_deleted', detail: req.params['id'] });
      res.json({ ok: true });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/schedules/:id/run', (req, res) => {
    const admin = requireAdmin(req as AuthedRequest);
    if (!admin) return res.status(403).json({ error: '仅管理员可手动运行' });
    const port = Number(req.app.get('port') ?? process.env['WORKPIVOT_PORT'] ?? 0);
    if (!port) return res.status(500).json({ error: '无法确定服务端口' });
    void runScheduleNow(req.params['id'] ?? '', port)
      .then(() => res.json({ ok: true }))
      .catch((err: unknown) => res.status(400).json({ error: err instanceof Error ? err.message : String(err) }));
  });

  app.get('/api/schedules/notifications', (req, res) => {
    void req;
    res.json({ notifications: listNotifications() });
  });

  // ---- F1 项目（两级结构）----
  app.get('/api/projects', (_req, res) => {
    res.json({ projects: listProjects(), defaultProjectId: DEFAULT_PROJECT_ID });
  });
  app.post('/api/projects', (req, res) => {
    const admin = requireAdmin(req as AuthedRequest);
    if (!admin) return res.status(403).json({ error: '仅管理员可创建项目' });
    const { name, directory } = req.body as { name?: string; directory?: string };
    if (!name || name.trim() === '') return res.status(400).json({ error: 'name 必填' });
    res.json({ project: createProject(name, directory) });
  });
  app.put('/api/projects/:id', (req, res) => {
    const admin = requireAdmin(req as AuthedRequest);
    if (!admin) return res.status(403).json({ error: '仅管理员可重命名项目' });
    const { name } = req.body as { name?: string };
    if (!name || name.trim() === '') return res.status(400).json({ error: 'name 必填' });
    const project = renameProject(req.params['id'] ?? '', name);
    if (!project) return res.status(404).json({ error: '项目不存在' });
    res.json({ project });
  });
  app.delete('/api/projects/:id', (req, res) => {
    const admin = requireAdmin(req as AuthedRequest);
    if (!admin) return res.status(403).json({ error: '仅管理员可删除项目' });
    const result = deleteProject(req.params['id'] ?? '');
    if (result.ok) res.json({ ok: true });
    else res.status(409).json({ error: result.error });
  });

  // T3-01：转写查看器数据源
  app.get('/api/tasks/:id/transcript', (req, res) => {
    const task = getTask(req.params['id'] ?? '');
    if (!task) return res.status(404).json({ error: '任务不存在' });
    res.json({ rows: readTranscript(task.id) });
  });

  // M1-12/A03：任务计划（update_plan 工具落盘，前端打开任务时回显）
  app.get('/api/tasks/:id/plan', (req, res) => {
    const task = getTask(req.params['id'] ?? '');
    if (!task) return res.status(404).json({ error: '任务不存在' });
    res.json({ steps: readPlan(task.id) });
  });

  // 授权卡决策（T2-05）：渲染层回填，唤醒等待中的工具调用
  app.post('/api/tasks/:id/permission', (req, res) => {
    const user = (req as AuthedRequest).user;
    const { id: requestId, decision } = req.body as { id?: string; decision?: Decision };
    if (!requestId || !decision) return res.status(400).json({ error: 'id/decision 必填' });
    const ok = resolvePendingRequest(requestId, decision);
    audit({ user: user?.username, taskId: req.params['id'], event: 'permission_decision', decision, detail: requestId });
    if (ok) res.json({ ok: true });
    else res.status(404).json({ error: '授权请求不存在或已处理' });
  });

  if (opts.webDistDir && existsSync(join(opts.webDistDir, 'index.html'))) {
    app.use(express.static(opts.webDistDir));
    // F3 管理后台页面（静态多页入口）
    const adminHtml = join(opts.webDistDir, 'admin.html');
    app.get('/admin', (_req, res) => {
      if (existsSync(adminHtml)) res.sendFile(adminHtml);
      else res.status(404).send('admin.html 不存在（请重新构建前端）');
    });
    // SPA 回退：非 /api 的 GET 一律回 index.html（Express 5 不再支持 '*' 通配路由）
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api/') || req.path.startsWith('/admin')) return next();
      res.sendFile(join(opts.webDistDir as string, 'index.html'));
    });
  }

  return app;
}

/** @文件引用（T2-02）：消息中的 @路径 展开为文件内容（上限 32KB/个）。 */
function expandFileRefs(content: string, dir: string): string {
  return content.replace(/(^|\s)@([^\s@]+)/g, (match, prefix: string, rel: string) => {
    try {
      const abs = resolvePath(dir, rel);
      if (!existsSync(abs) || !statSync(abs).isFile()) return match;
      const text = readFileSync(abs, 'utf8');
      const capped = text.length > 32_000 ? `${text.slice(0, 32_000)}…（截断）` : text;
      return `${prefix}\n\n--- 引用文件 ${rel} ---\n${capped}\n--- 引用结束 ---`;
    } catch {
      return match;
    }
  });
}

function buildSystemPrompt(taskDirectory: string, tier: Tier): string {
  return [
    `你是 WorkPivot，一个在用户本机工作的智能助手。`,
    ``,
    `# 工作目录`,
    `当前任务绑定的工作目录：${taskDirectory}`,
    `文件操作只能在该目录内进行；访问界外路径会向用户发起授权请求，被拒绝时不要重试同一路径。`,
    `当前权限档位：${TIER_LABELS[tier]}。`,
    ``,
    `# 工具使用纪律`,
    `- 先读后改：修改文件前必须先用 read 工具阅读原文件。`,
    `- 专用工具优先：读文件用 read，写文件用 write，列目录用 ls，搜内容用 grep，找文件用 find，跑命令用 bash。`,
    `- 交付文件命名遵循"{标题} v{X.Y} {日期}.{格式}"，不覆盖旧版本。`,
    `- 同一次回复里相互独立的工具调用应尽量并行发起。`,
    ``,
    `# 输出纪律`,
    `- 用中文回复；结论先行，简明扼要。`,
    `- 引用文件时给出相对路径。`,
  ].join('\n');
}
