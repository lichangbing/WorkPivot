/**
 * T1-05/T2-06：内置工具 read/write/ls/bash/grep/find。
 * 纪律（写进工具描述，中文，随工具面注入）：先读后改、专用工具优先。
 * 边界：默认限制在任务目录内；界外访问经 requestAccess 授权后放行（I08，W2），
 *       工具内 resolveWithin 仍作为最后一道防线（纵深防御）。
 */
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { canonicalPath, pathWithin } from '@workpivot/shared/node';
import { commandEnvironment } from './command-env.js';

export interface ToolContext {
  taskDir: string;
  signal?: AbortSignal;
  /** 界外访问授权钩子（服务层实现：档位判定+授权卡）。返回 false = 拒绝执行。 */
  requestAccess?: (req: ToolAccessRequest) => Promise<boolean>;
  /** 本次执行被授权的界外路径（纵深防御的白名单） */
  extraAllowedDirs?: string[];
  /** bash 子进程附加环境变量（如 NODE_PATH，指向应用内置依赖） */
  extraEnv?: Record<string, string>;
  filePolicy?: (path: string, mode: 'read' | 'write') => boolean;
  executeCommand?: (command: string) => Promise<string>;
}

export interface ToolAccessRequest {
  effects?:('read'|'write'|'execution'|'network'|'external')[];
  /** 服务端固定的单次调用；模型参数不能自行签发许可。 */
  binding?: Record<string, unknown>;
  invocation?: { id: string; definition: string; arguments: Record<string, unknown>; digest: string };
  external?: boolean;
  /** 服务端工具声明静默放行：不弹授权卡，直接记为已批准。由工具实现固定，模型参数不能设置。 */
  auto?: boolean;
  tool: string;
  kind: 'read' | 'write' | 'bash';
  paths: Array<{ path: string; mode: 'read' | 'write' }>;
  command?: string;
}

export interface Tool {
  /** 数据库运行时注册的副作用与返回来源，不能由模型参数覆盖。 */
  effects?:('read'|'write'|'execution'|'network'|'external')[];
  resultSource?:'reference'|'operation'|'web'|'execution'|'external';
  displayName?: string;
  name: string;
  kind: 'read' | 'write' | 'bash';
  description: string;
  parameters: Record<string, unknown>;
  /** 声明本次调用涉及的路径/命令，供权限引擎判定 */
  access?(args: Record<string, unknown>, ctx: ToolContext): ToolAccessRequest;
  /** 工具返回后立即结束本轮（结构化提问用：等用户回答，不进入下一轮采样）。 */
  endsTurn?: boolean;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

function resolveWithin(taskDir: string, p: string, extraDirs: string[] = []): string {
  const abs = canonicalPath(p, taskDir);
  if (pathWithin(abs, taskDir)) return abs;
  if (extraDirs.some((dir) => pathWithin(abs, canonicalPath(dir, taskDir)))) return abs;
  throw new Error(`路径越界：${p} 不在允许范围内（界外访问需用户授权）`);
}

function walkFiles(root: string, opts: { maxFiles?: number; allowed?: (path: string) => boolean } = {}): string[] {
  const maxFiles = opts.maxFiles ?? 2000;
  const skip = new Set(['node_modules', '.git', 'dist', 'out', '.workpivot', '__pycache__']);
  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0 && files.length < maxFiles) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (files.length >= maxFiles) break;
      const full = join(dir, name);
      if (opts.allowed && !opts.allowed(full)) continue;
      let stat;
      try {
        stat = lstatSync(full);
        if (stat.isSymbolicLink()) continue;
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (!skip.has(name)) stack.push(full);
      } else {
        files.push(full);
      }
    }
  }
  return files;
}

const READ_MAX_BYTES = 512 * 1024;
const READ_DEFAULT_LINES = 2000;
const READ_MAX_LINES = 5000;

/** 写临时文件再 rename：进程中断不会留下半截文件（O-08）。 */
function writeAtomic(path: string, content: string): void {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, content, 'utf8');
  try {
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* 清理失败不能掩盖原始错误 */ }
    throw error;
  }
}

/** 按行编号返回片段；超长文件用 offset/limit 续读，避免一次读满上下文。 */
function numberedSlice(lines: string[], start: number, count: number): string {
  const end = Math.min(lines.length, start - 1 + count);
  const body = lines.slice(start - 1, end).map((line, index) => `${start + index}\t${line}`).join('\n');
  const more = end < lines.length ? `\n…（还有 ${lines.length - end} 行，用 offset=${end + 1} 继续）` : '\n（已到文件末尾）';
  return `${body}${more}`;
}

export const readTool: Tool = {
  name: 'read',
  kind: 'read',
  description:
    '读取任务目录内一个文本文件的内容。大文件用 offset/limit 按行分段读取，返回带行号与总行数。修改文件前必须先 read 原文件（先读后改）。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对任务目录的文件路径，如 "data/说明.md"' },
      offset: { type: 'integer', description: '起始行号（从 1 开始），默认 1' },
      limit: { type: 'integer', description: `本次最多返回多少行，默认 ${READ_DEFAULT_LINES}，上限 ${READ_MAX_LINES}` },
    },
    required: ['path'],
  },
  access: (args) => ({ tool: 'read', kind: 'read' as const, paths: [{ path: String(args['path'] ?? ''), mode: 'read' as const }] }),
  async run(args, ctx) {
    const path = resolveWithin(ctx.taskDir, String(args['path'] ?? ''), ctx.extraAllowedDirs);
    if (ctx.filePolicy && !ctx.filePolicy(path, 'read')) throw new Error('无权读取该项目或任务文件');
    if (!existsSync(path)) return `错误：文件不存在：${path}`;
    const stat = statSync(path);
    if (stat.isDirectory()) return `错误：${path} 是目录，请用 ls 列出`;

    const rawOffset = args['offset'], rawLimit = args['limit'];
    if (rawOffset !== undefined && (!Number.isInteger(rawOffset) || (rawOffset as number) < 1)) throw new Error('offset 必须是 ≥1 的整数');
    if (rawLimit !== undefined && (!Number.isInteger(rawLimit) || (rawLimit as number) < 1 || (rawLimit as number) > READ_MAX_LINES)) throw new Error(`limit 必须是 1-${READ_MAX_LINES} 的整数`);
    const start = (rawOffset as number | undefined) ?? 1;
    const count = (rawLimit as number | undefined) ?? READ_DEFAULT_LINES;

    // 小文件且未指定分页时保持原文返回，避免给普通读取加噪声。
    if (rawOffset === undefined && rawLimit === undefined && stat.size <= READ_MAX_BYTES) return readFileSync(path, 'utf8');

    const text = readFileSync(path, 'utf8');
    const lines = text.split(/\r?\n/);
    if (start > lines.length) return `错误：offset=${start} 超出范围（共 ${lines.length} 行）`;
    return numberedSlice(lines, start, count);
  },
};

export const writeTool: Tool = {
  name: 'write',
  kind: 'write',
  description:
    '把完整内容写入任务目录内一个文件（覆盖写；新文件自动创建父目录）。产物文件命名遵循"{标题} v{X.Y} {日期}.{格式}"，不覆盖旧版本。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对任务目录的文件路径' },
      content: { type: 'string', description: '完整的文件内容（UTF-8 文本）' },
    },
    required: ['path', 'content'],
  },
  access: (args) => ({ tool: 'write', kind: 'write' as const, paths: [{ path: String(args['path'] ?? ''), mode: 'write' as const }] }),
  async run(args, ctx) {
    const path = resolveWithin(ctx.taskDir, String(args['path'] ?? ''), ctx.extraAllowedDirs);
    if (ctx.filePolicy && !ctx.filePolicy(path, 'write')) throw new Error('无权修改该项目或任务文件');
    const content = String(args['content'] ?? '');
    mkdirSync(path.slice(0, Math.max(path.lastIndexOf(sep), path.lastIndexOf('/'))), { recursive: true });
    writeAtomic(path, content);
    return `已写入 ${path}（${Buffer.byteLength(content, 'utf8')} 字节）`;
  },
};

export const lsTool: Tool = {
  name: 'ls',
  kind: 'read',
  description: '列出任务目录内一个目录的内容（文件名/类型/大小）。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对任务目录的目录路径，默认任务根目录' },
    },
  },
  access: (args) => ({ tool: 'ls', kind: 'read' as const, paths: [{ path: String(args['path'] ?? '.'), mode: 'read' as const }] }),
  async run(args, ctx) {
    const path = resolveWithin(ctx.taskDir, String(args['path'] ?? '.'), ctx.extraAllowedDirs);
    if (ctx.filePolicy && !ctx.filePolicy(path, 'read')) throw new Error('无权读取该目录');
    if (!existsSync(path)) return `错误：目录不存在：${path}`;
    const entries = readdirSync(path).filter((name) => !ctx.filePolicy || ctx.filePolicy(join(path, name), 'read')).map((name) => {
      const full = join(path, name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) return `[链接] ${name}`;
      return `${st.isDirectory() ? '[目录]' : `[文件 ${st.size}B]`} ${name}`;
    });
    return entries.length > 0 ? entries.join('\n') : '（空目录）';
  },
};

const BASH_TIMEOUT_MS = 120_000;
const BASH_OUTPUT_CAP = 64 * 1024;

/**
 * 执行一条 shell 命令：有 executeCommand（worker/docker）时交给隔离执行服务，
 * 否则在宿主任务目录里直接 spawn。bash 与 run_code 共用这一条通道。
 */
export async function executeShell(command: string, ctx: ToolContext): Promise<string> {
  if (command === '') return '错误：command 必填';
  if (ctx.executeCommand) return ctx.executeCommand(command);
  const isWin = process.platform === 'win32';
  return new Promise((resolve) => {
    // I01：POSIX 用进程组（detached），Windows 用 taskkill /T——终止时整树带走，防孤儿进程
    const child = spawn(isWin ? 'cmd.exe' : '/bin/sh', isWin ? ['/d', '/s', '/c', command] : ['-c', command], {
      cwd: ctx.taskDir,
      windowsHide: true,
      ...(isWin ? {} : { detached: true }),
      env: commandEnvironment(ctx.extraEnv),
    });
    /** 整棵进程树强制终止（超时/中止时；不再依赖 spawn 的 timeout 只杀直接子进程）。 */
    const killTree = (): void => {
      if (child.killed || child.exitCode !== null) return;
      if (isWin) {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      } else if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      } else {
        child.kill('SIGKILL');
      }
    };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, BASH_TIMEOUT_MS);
    const onAbort = (): void => killTree();
    ctx.signal?.addEventListener('abort', onAbort, { once: true });
    // O-04：头尾各留一半，命令失败时错误栈在末尾也能看到。
    const half = BASH_OUTPUT_CAP / 2;
    let head = '';
    let tail = '';
    let totalBytes = 0;
    const collect = (chunk: Buffer): void => {
      const text = chunk.toString();
      totalBytes += chunk.length;
      if (head.length < half) {
        const room = half - head.length;
        head += text.slice(0, room);
        const rest = text.slice(room);
        if (rest) tail = (tail + rest).slice(-half);
      } else {
        tail = (tail + text).slice(-half);
      }
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.on('error', (err) => resolve(`执行失败：${err.message}`));
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      ctx.signal?.removeEventListener('abort', onAbort);
      if (ctx.signal?.aborted) return resolve('（已中止：命令随任务停止被终止）');
      const status = timedOut ? '超时强制终止（整棵进程树已结束）' : `exit=${code ?? signal ?? '?'}`;
      if (totalBytes === 0) return resolve(`${status}\n（无输出）`);
      const keptBytes = Buffer.byteLength(head, 'utf8') + Buffer.byteLength(tail, 'utf8');
      const body = totalBytes > keptBytes
        ? `\n${head}\n…（中间省略约 ${totalBytes - keptBytes} 字节，输出总计 ${totalBytes} 字节）…\n${tail}`
        : `\n${head}${tail}`;
      resolve(`${status}${body}`);
    });
  });
}

export const bashTool: Tool = {
  name: 'bash',
  kind: 'bash',
  description:
    '在任务隔离环境中执行一条 shell 命令，使用系统提示中指定的 shell 和相对路径。高危命令会请求用户确认。输出超长会截断，超时 120 秒自动终止。',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的命令' },
    },
    required: ['command'],
  },
  access: (args) => ({ tool: 'bash', kind: 'bash' as const, paths: [] as Array<{ path: string; mode: 'read' | 'write' }>, command: String(args['command'] ?? '') }),
  async run(args, ctx) {
    return executeShell(String(args['command'] ?? '').trim(), ctx);
  },
};

export const grepTool: Tool = {
  name: 'grep',
  kind: 'read',
  description: '在任务目录内按正则搜索文件内容（跳过 node_modules/.git 等，返回 文件:行号:内容，最多 100 条）。',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '正则表达式' },
      path: { type: 'string', description: '搜索起点，默认任务根目录' },
    },
    required: ['pattern'],
  },
  access: (args) => ({ tool: 'grep', kind: 'read' as const, paths: [{ path: String(args['path'] ?? '.'), mode: 'read' as const }] }),
  async run(args, ctx) {
    const pattern = String(args['pattern'] ?? '');
    if (pattern === '') return '错误：pattern 必填';
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, 'i');
    } catch (err) {
      return `错误：正则无效——${err instanceof Error ? err.message : String(err)}`;
    }
    const base = resolveWithin(ctx.taskDir, String(args['path'] ?? '.'), ctx.extraAllowedDirs);
    const matches: string[] = [];
    for (const file of walkFiles(base, { allowed: (path) => !ctx.filePolicy || ctx.filePolicy(path, 'read') })) {
      if (matches.length >= 100) break;
      let stat;
      try {
        stat = statSync(file);
      } catch {
        continue;
      }
      if (stat.size > 1024 * 1024) continue;
      let content: string;
      try {
        content = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      if (content.includes('\0')) continue; // 二进制跳过
      const rel = file.slice(base.length + 1);
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i]!)) {
          matches.push(`${rel}:${i + 1}: ${lines[i]!.trim().slice(0, 200)}`);
          if (matches.length >= 100) break;
        }
      }
    }
    return matches.length > 0
      ? `${matches.join('\n')}${matches.length >= 100 ? '\n…（已达 100 条上限）' : ''}`
      : '（无匹配）';
  },
};

export const findTool: Tool = {
  name: 'find',
  kind: 'read',
  description: '在任务目录内按文件名（子串或正则）查找文件，返回相对路径（最多 200 条）。',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '文件名匹配串（子串或正则）' },
      path: { type: 'string', description: '搜索起点，默认任务根目录' },
    },
    required: ['pattern'],
  },
  access: (args) => ({ tool: 'find', kind: 'read' as const, paths: [{ path: String(args['path'] ?? '.'), mode: 'read' as const }] }),
  async run(args, ctx) {
    const pattern = String(args['pattern'] ?? '');
    if (pattern === '') return '错误：pattern 必填';
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, 'i');
    } catch {
      regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); // 退化为子串
    }
    const base = resolveWithin(ctx.taskDir, String(args['path'] ?? '.'), ctx.extraAllowedDirs);
    const files = walkFiles(base, { allowed: (path) => !ctx.filePolicy || ctx.filePolicy(path, 'read') }).filter((f) => regex.test(f.slice(base.length + 1)));
    return files.length > 0
      ? `${files.map((f) => f.slice(base.length + 1)).join('\n')}${files.length >= 200 ? '\n…（截断）' : ''}`
      : '（无匹配）';
  },
};

export const editTool: Tool = {
  name: 'edit',
  kind: 'write',
  description:
    '在任务目录内按精确文本替换编辑文件：old_string 必须在文件中唯一匹配（否则补充上下文或设 replace_all=true）。先 read 再改；不做正则，整文件重写用 write。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对任务目录的文件路径' },
      old_string: { type: 'string', description: '要被替换的原文，必须与文件内容逐字一致（含空格与缩进）' },
      new_string: { type: 'string', description: '替换后的文本；为空表示删除这段内容' },
      replace_all: { type: 'boolean', description: '为 true 时替换全部匹配；默认要求唯一匹配' },
    },
    required: ['path', 'old_string', 'new_string'],
    additionalProperties: false,
  },
  access: (args) => ({
    tool: 'edit',
    kind: 'write' as const,
    paths: [{ path: String(args['path'] ?? ''), mode: 'read' as const }, { path: String(args['path'] ?? ''), mode: 'write' as const }],
  }),
  async run(args, ctx) {
    const path = resolveWithin(ctx.taskDir, String(args['path'] ?? ''), ctx.extraAllowedDirs);
    if (ctx.filePolicy && !ctx.filePolicy(path, 'read')) throw new Error('无权读取该项目或任务文件');
    if (ctx.filePolicy && !ctx.filePolicy(path, 'write')) throw new Error('无权修改该项目或任务文件');
    if (!existsSync(path)) throw new Error(`文件不存在：${String(args['path'] ?? '')}；新建文件请用 write`);
    const oldString = String(args['old_string'] ?? '');
    const newString = String(args['new_string'] ?? '');
    if (oldString === '') throw new Error('old_string 不能为空；整文件重写请用 write');
    if (oldString === newString) throw new Error('old_string 与 new_string 相同，无需修改');
    const original = readFileSync(path, 'utf8');
    const occurrences = original.split(oldString).length - 1;
    if (occurrences === 0) throw new Error('未找到目标文本：请先 read 确认原文，注意空格、缩进与换行必须逐字一致');
    if (occurrences > 1 && args['replace_all'] !== true) throw new Error(`目标文本出现 ${occurrences} 次；请补充上下文使其唯一，或设置 replace_all=true`);
    // 用函数式替换，避免 new_string 中的 $& 等被当成替换模式。
    const updated = occurrences > 1 ? original.split(oldString).join(newString) : original.replace(oldString, () => newString);
    writeAtomic(path, updated);
    return `已编辑 ${path}（替换 ${occurrences} 处，${Buffer.byteLength(updated, 'utf8')} 字节）`;
  },
};

export const BUILTIN_TOOLS: Tool[] = [readTool, writeTool, editTool, lsTool, bashTool, grepTool, findTool];
