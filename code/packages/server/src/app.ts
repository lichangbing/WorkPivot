/**
 * Express 应用与全部路由。
 * W1：供应商/任务/SSE 对话；W2：登录门/权限档位/授权卡/审计/@引用/并行上限。
 */
import express, { type Express, type Request } from 'express';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import {
  BUILTIN_TOOLS,
  MAX_STEPS_DEFAULT,
  createOpenAICompatibleClient,
  runAgentLoop,
  type ChatMessage,
  type ToolAccessRequest,
} from '@workpivot/core';
import { verifyClaimedFiles } from './chat-gate.js';
import {
  needsSetup,
  registerFirstAdmin,
  login as authLogin,
  resolveToken,
  createUser,
  listUsers,
  type PublicUser,
  type Role,
} from './auth.js';
import { evaluateAccess, getTier, resolvePendingRequest, setTier, TIER_LABELS, listAllowDirs, type Decision, type Tier } from './permissions.js';
import { appendTranscript, createTask, getTask, listTasks, readHistory, readTranscript, updateTaskStatus } from './tasks.js';
import { audit, argsHash } from './audit.js';
import { listProviders, resolveActiveProvider, saveProvider, setActiveProvider } from './providers.js';

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

  // ---- 认证（T2-01）：除公开路径外全部要求 Bearer 令牌 ----
  app.use('/api', (req, res, next) => {
    if (PUBLIC_PATHS.has(req.path) || req.path.startsWith('/auth/')) return next();
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

  // ---- 用户管理（仅管理员）----
  app.get('/api/users', (req, res) => {
    if (!requireAdmin(req as AuthedRequest)) return res.status(403).json({ error: '仅管理员可查看用户' });
    res.json({ users: listUsers() });
  });

  app.post('/api/users', (req, res) => {
    const admin = requireAdmin(req as AuthedRequest);
    if (!admin) return res.status(403).json({ error: '仅管理员可创建用户' });
    const { username, password, role } = req.body as { username?: string; password?: string; role?: Role };
    if (!username || !password || !role) return res.status(400).json({ error: 'username/password/role 必填' });
    try {
      const user = createUser(username, password, role === 'admin' ? 'admin' : 'member');
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

  app.post('/api/providers/verify', async (req, res) => {
    const { baseUrl, apiKey } = req.body as { baseUrl?: string; apiKey?: string };
    if (!baseUrl) return res.status(400).json({ error: 'baseUrl 必填' });
    const { verifyProvider } = await import('@workpivot/core');
    res.json(await verifyProvider(baseUrl, apiKey));
  });

  app.post('/api/providers', async (req, res) => {
    const { name, baseUrl, modelId, apiKey, verify } = req.body as {
      name?: string; baseUrl?: string; modelId?: string; apiKey?: string; verify?: boolean;
    };
    if (!name || !baseUrl || !modelId) return res.status(400).json({ error: 'name/baseUrl/modelId 必填' });
    try {
      const result = await saveProvider({ name, baseUrl, modelId, apiKey, verify });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/providers/active', (req, res) => {
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
    const { name, directory } = req.body as { name?: string; directory?: string };
    if (!name || name.trim() === '') return res.status(400).json({ error: 'name 必填' });
    const task = createTask(name, directory);
    audit({ event: 'task_created', taskId: task.id, detail: task.directory });
    res.json({ task });
  });

  app.get('/api/tasks/:id', (req, res) => {
    const task = getTask(req.params['id'] ?? '');
    if (!task) return res.status(404).json({ error: '任务不存在' });
    res.json({ task, history: readHistory(task.id) });
  });

  // 右栏占位（W1）：任务目录的文件清单
  app.get('/api/tasks/:id/files', (req, res) => {
    const task = getTask(req.params['id'] ?? '');
    if (!task) return res.status(404).json({ error: '任务不存在' });
    const files = existsSync(task.directory) ? readdirSync(task.directory).slice(0, 200) : [];
    res.json({ directory: task.directory, files });
  });

  // ---- 对话（SSE 流式）----
  app.post('/api/tasks/:id/messages', (req, res) => {
    const user = (req as AuthedRequest).user;
    const task = getTask(req.params['id'] ?? '');
    if (!task) return res.status(404).json({ error: '任务不存在' });
    const { content } = req.body as { content?: string };
    if (!content || content.trim() === '') return res.status(400).json({ error: 'content 必填' });
    if (running.has(task.id)) return res.status(409).json({ error: '该任务正在运行中' });
    if (running.size >= PARALLEL_LIMIT) return res.status(429).json({ error: `并行任务已达上限 ${PARALLEL_LIMIT} 个` });

    let client: ReturnType<typeof createOpenAICompatibleClient>;
    try {
      client = createOpenAICompatibleClient(resolveActiveProvider());
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

    // @文件引用（T2-02）：把引用文件内容展开进消息
    const expanded = expandFileRefs(content, task.directory);

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

    const system = buildSystemPrompt(task.directory, getTier());

    const requestAccess: (req: ToolAccessRequest) => Promise<boolean> = async (access) => {
      const result = await evaluateAccess(
        { tool: access.tool, kind: access.kind, paths: access.paths, command: access.command, taskDir: task.directory },
        (request) => send({ type: 'permission_request', ...request }),
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
        tools: BUILTIN_TOOLS,
        system,
        messages: baseMessages,
        taskDir: task.directory,
        requestAccess,
        maxSteps,
        maxDurationMs,
        stashResult,
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
        running.delete(task.id);
        res.end();
      });
  });

  // T3-01：转写查看器数据源
  app.get('/api/tasks/:id/transcript', (req, res) => {
    const task = getTask(req.params['id'] ?? '');
    if (!task) return res.status(404).json({ error: '任务不存在' });
    res.json({ rows: readTranscript(task.id) });
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
    // SPA 回退：非 /api 的 GET 一律回 index.html（Express 5 不再支持 '*' 通配路由）
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
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
