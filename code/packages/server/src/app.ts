/**
 * Express 应用与全部路由（M0：供应商/任务/SSE 对话）。
 */
import express, { type Express } from 'express';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  BUILTIN_TOOLS,
  createOpenAICompatibleClient,
  runAgentLoop,
  type ChatMessage,
} from '@workpivot/core';
import { listProviders, resolveActiveProvider, saveProvider, setActiveProvider } from './providers.js';
import { appendTranscript, createTask, getTask, listTasks, readHistory, updateTaskStatus } from './tasks.js';

export interface AppOptions {
  /** 前端构建产物目录（apps/web/dist）。存在则托管静态资源并提供 SPA 回退。 */
  webDistDir?: string;
}

/** 运行中的 agent 会话（taskId → 中止控制器）。 */
const running = new Map<string, AbortController>();

export function createApp(opts: AppOptions = {}): Express {
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, name: 'workpivot', ts: Date.now() });
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
    if (!existsSync(task.directory)) return res.json({ directory: task.directory, files: [] });
    const files = existsSync(task.directory) ? readdirSync(task.directory).slice(0, 200) : [];
    res.json({ directory: task.directory, files });
  });

  // ---- 对话（SSE 流式）----
  app.post('/api/tasks/:id/messages', (req, res) => {
    const task = getTask(req.params['id'] ?? '');
    if (!task) return res.status(404).json({ error: '任务不存在' });
    const { content } = req.body as { content?: string };
    if (!content || content.trim() === '') return res.status(400).json({ error: 'content 必填' });
    if (running.has(task.id)) return res.status(409).json({ error: '该任务正在运行中' });

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

    const controller = new AbortController();
    running.set(task.id, controller);
    updateTaskStatus(task.id, 'running');
    // 注意：req 的 'close' 在请求体读完即触发（Node 16+），不能作为客户端断开信号；
    // 客户端断开 = 响应流未正常结束就 close。
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
      running.delete(task.id);
    });

    const history: ChatMessage[] = readHistory(task.id).map((m) => ({ role: m.role, content: m.content }));
    history.push({ role: 'user', content });
    appendTranscript(task.id, 'user_message', { content });

    const system = buildSystemPrompt(task.directory);

    void runAgentLoop({
      client,
      tools: BUILTIN_TOOLS,
      system,
      messages: history,
      taskDir: task.directory,
      signal: controller.signal,
      onEvent: (event) => {
        send(event);
        if (event.type === 'tool_use') appendTranscript(task.id, 'tool_use', { toolName: event.toolName, args: event.args });
        if (event.type === 'tool_result') appendTranscript(task.id, 'tool_result', { toolName: event.toolName, ok: event.ok, summary: event.message });
      },
    })
      .then((result) => {
        const lastAssistant = [...result.messages].reverse().find((m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.length > 0);
        if (lastAssistant) appendTranscript(task.id, 'assistant_message', { content: lastAssistant.content });
        updateTaskStatus(task.id, result.stopReason === 'completed' ? 'idle' : 'interrupted');
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

  app.post('/api/tasks/:id/stop', (req, res) => {
    const controller = running.get(req.params['id'] ?? '');
    if (!controller) return res.status(404).json({ error: '任务未在运行' });
    controller.abort();
    res.json({ ok: true });
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

function buildSystemPrompt(taskDirectory: string): string {
  return [
    `你是 WorkPivot，一个在用户本机工作的智能助手。`,
    ``,
    `# 工作目录`,
    `当前任务绑定的工作目录：${taskDirectory}`,
    `你的文件操作只能在该目录内进行；界外路径会被拒绝。`,
    ``,
    `# 工具使用纪律`,
    `- 先读后改：修改文件前必须先用 read 工具阅读原文件。`,
    `- 专用工具优先：读文件用 read，写文件用 write，列目录用 ls。`,
    `- 交付文件命名遵循"{标题} v{X.Y} {日期}.{格式}"，不覆盖旧版本。`,
    ``,
    `# 输出纪律`,
    `- 用中文回复；结论先行，简明扼要。`,
    `- 引用文件时给出相对路径。`,
  ].join('\n');
}
