/**
 * T1-05/T2-06：内置工具 read/write/ls/bash/grep/find。
 * 纪律（写进工具描述，中文，随工具面注入）：先读后改、专用工具优先。
 * 边界：默认限制在任务目录内；界外访问经 requestAccess 授权后放行（I08，W2），
 *       工具内 resolveWithin 仍作为最后一道防线（纵深防御）。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';

export interface ToolContext {
  taskDir: string;
  signal?: AbortSignal;
  /** 界外访问授权钩子（服务层实现：档位判定+授权卡）。返回 false = 拒绝执行。 */
  requestAccess?: (req: ToolAccessRequest) => Promise<boolean>;
  /** 本次执行被授权的界外路径（纵深防御的白名单） */
  extraAllowedDirs?: string[];
}

export interface ToolAccessRequest {
  tool: string;
  kind: 'read' | 'write' | 'bash';
  paths: Array<{ path: string; mode: 'read' | 'write' }>;
  command?: string;
}

export interface Tool {
  name: string;
  kind: 'read' | 'write' | 'bash';
  description: string;
  parameters: Record<string, unknown>;
  /** 声明本次调用涉及的路径/命令，供权限引擎判定 */
  access?(args: Record<string, unknown>, ctx: ToolContext): ToolAccessRequest;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

function resolveWithin(taskDir: string, p: string, extraDirs: string[] = []): string {
  const base = resolve(taskDir);
  const abs = isAbsolute(p) ? resolve(p) : resolve(base, p);
  if (abs === base || abs.startsWith(base + sep)) return abs;
  if (extraDirs.some((dir) => abs === resolve(dir) || abs.startsWith(resolve(dir) + sep))) return abs;
  throw new Error(`路径越界：${p} 不在允许范围内（界外访问需用户授权）`);
}

function walkFiles(root: string, opts: { maxFiles?: number } = {}): string[] {
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
      let stat;
      try {
        stat = statSync(full);
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

export const readTool: Tool = {
  name: 'read',
  kind: 'read',
  description: '读取任务目录内一个文本文件的内容。修改文件前必须先 read 原文件（先读后改）。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对任务目录的文件路径，如 "data/说明.md"' },
    },
    required: ['path'],
  },
  access: (args) => ({ tool: 'read', kind: 'read' as const, paths: [{ path: String(args['path'] ?? ''), mode: 'read' as const }] }),
  async run(args, ctx) {
    const path = resolveWithin(ctx.taskDir, String(args['path'] ?? ''), ctx.extraAllowedDirs);
    if (!existsSync(path)) return `错误：文件不存在：${path}`;
    const stat = statSync(path);
    if (stat.isDirectory()) return `错误：${path} 是目录，请用 ls 列出`;
    if (stat.size > READ_MAX_BYTES) {
      const head = readFileSync(path, 'utf8').slice(0, READ_MAX_BYTES);
      return `文件过大（${stat.size} 字节），仅返回前 ${READ_MAX_BYTES} 字节：\n${head}\n…（截断）`;
    }
    return readFileSync(path, 'utf8');
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
    const content = String(args['content'] ?? '');
    mkdirSync(path.slice(0, Math.max(path.lastIndexOf(sep), path.lastIndexOf('/'))), { recursive: true });
    writeFileSync(path, content, 'utf8');
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
    if (!existsSync(path)) return `错误：目录不存在：${path}`;
    const entries = readdirSync(path).map((name) => {
      const full = join(path, name);
      const st = statSync(full);
      return `${st.isDirectory() ? '[目录]' : `[文件 ${st.size}B]`} ${name}`;
    });
    return entries.length > 0 ? entries.join('\n') : '（空目录）';
  },
};

const BASH_TIMEOUT_MS = 120_000;
const BASH_OUTPUT_CAP = 64 * 1024;

export const bashTool: Tool = {
  name: 'bash',
  kind: 'bash',
  description:
    '在任务目录内执行一条 shell 命令（Windows 走 cmd，其他走 sh）。高危命令（删除系统目录/格式化/强推等）会被拦截并请求用户确认。输出超长会截断，超时 120 秒自动终止。',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的命令' },
    },
    required: ['command'],
  },
  access: (args) => ({ tool: 'bash', kind: 'bash' as const, paths: [] as Array<{ path: string; mode: 'read' | 'write' }>, command: String(args['command'] ?? '') }),
  async run(args, ctx) {
    const command = String(args['command'] ?? '').trim();
    if (command === '') return '错误：command 必填';
    const isWin = process.platform === 'win32';
    return new Promise((resolve) => {
      const child = spawn(isWin ? 'cmd.exe' : '/bin/sh', isWin ? ['/d', '/s', '/c', command] : ['-c', command], {
        cwd: ctx.taskDir,
        windowsHide: true,
        timeout: BASH_TIMEOUT_MS,
      });
      let out = '';
      child.stdout?.on('data', (d: Buffer) => {
        if (out.length < BASH_OUTPUT_CAP) out += d.toString();
      });
      child.stderr?.on('data', (d: Buffer) => {
        if (out.length < BASH_OUTPUT_CAP) out += d.toString();
      });
      child.on('error', (err) => resolve(`执行失败：${err.message}`));
      child.on('close', (code, signal) => {
        const head = out.length > 0 ? `\n${out.slice(0, BASH_OUTPUT_CAP)}` : '\n（无输出）';
        resolve(`exit=${code ?? signal ?? '?'}${head}`);
      });
    });
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
    for (const file of walkFiles(base)) {
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
    const files = walkFiles(base).filter((f) => regex.test(f.slice(base.length + 1)));
    return files.length > 0
      ? `${files.map((f) => f.slice(base.length + 1)).join('\n')}${files.length >= 200 ? '\n…（截断）' : ''}`
      : '（无匹配）';
  },
};

export const BUILTIN_TOOLS: Tool[] = [readTool, writeTool, lsTool, bashTool, grepTool, findTool];
