/**
 * T1-05：首批内置工具 read/write/ls（edit 滑到 W2）。
 * 纪律（写进工具描述，中文，随工具面注入）：先读后改、专用工具优先。
 * 边界预演（完整版是 I08，W2）：所有路径必须在任务目录内。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';

export interface ToolContext {
  taskDir: string;
  signal?: AbortSignal;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

/** 路径守卫：相对/绝对路径都限制在任务目录内（symlink 逃逸防护是 I08，W2）。 */
function resolveWithin(taskDir: string, p: string): string {
  const base = resolve(taskDir);
  const abs = isAbsolute(p) ? resolve(p) : resolve(base, p);
  if (abs !== base && !abs.startsWith(base + sep)) {
    throw new Error(`路径越界：${p} 不在任务目录内（${base}）。界外访问需用户授权（W2 实现）。`);
  }
  return abs;
}

const READ_MAX_BYTES = 512 * 1024;

export const readTool: Tool = {
  name: 'read',
  description: '读取任务目录内一个文本文件的内容。修改文件前必须先 read 原文件（先读后改）。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对任务目录的文件路径，如 "data/说明.md"' },
    },
    required: ['path'],
  },
  async run(args, ctx) {
    const path = resolveWithin(ctx.taskDir, String(args['path'] ?? ''));
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
  description: '把完整内容写入任务目录内一个文件（覆盖写；新文件会自动创建父目录）。产物文件命名遵循"{标题} v{X.Y} {日期}.{格式}"，不覆盖旧版本。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对任务目录的文件路径' },
      content: { type: 'string', description: '完整的文件内容（UTF-8 文本）' },
    },
    required: ['path', 'content'],
  },
  async run(args, ctx) {
    const path = resolveWithin(ctx.taskDir, String(args['path'] ?? ''));
    const content = String(args['content'] ?? '');
    mkdirSync(path.slice(0, path.lastIndexOf(sep)), { recursive: true });
    writeFileSync(path, content, 'utf8');
    return `已写入 ${path}（${Buffer.byteLength(content, 'utf8')} 字节）`;
  },
};

export const lsTool: Tool = {
  name: 'ls',
  description: '列出任务目录内一个目录的内容（文件名/类型/大小）。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对任务目录的目录路径，默认任务根目录' },
    },
  },
  async run(args, ctx) {
    const path = resolveWithin(ctx.taskDir, String(args['path'] ?? '.'));
    if (!existsSync(path)) return `错误：目录不存在：${path}`;
    const entries = readdirSync(path).map((name) => {
      const full = join(path, name);
      const st = statSync(full);
      return `${st.isDirectory() ? '[目录]' : `[文件 ${st.size}B]`} ${name}`;
    });
    return entries.length > 0 ? entries.join('\n') : '（空目录）';
  },
};

export const BUILTIN_TOOLS: Tool[] = [readTool, writeTool, lsTool];
