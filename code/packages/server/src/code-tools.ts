/**
 * run_code：面向工作目录的代码执行工具（文件链路）。
 *
 * 与 bash 共用执行通道：worker/docker 模式下任务目录快照进一次性容器，执行后只回写有变化的文件；
 * trusted-local 模式直接在任务目录执行。脚本写进任务目录的 .workpivot/run-code/，用户可见可复核。
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canonicalPath, pathWithin } from '@workpivot/shared/node';
import type { Tool, ToolContext } from '@workpivot/core';

/** O-07：脚本目录只保留最近 20 份，避免频繁使用后无限增长；清理失败不影响执行。 */
const RUN_CODE_KEEP = 20;
function pruneRunCodeScripts(taskDir: string): void {
  try {
    const root = canonicalPath('.workpivot/run-code', taskDir);
    const names = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    for (const name of names.slice(0, Math.max(0, names.length - RUN_CODE_KEEP))) rmSync(join(root, name), { recursive: true, force: true });
  } catch { /* 目录不存在或清理失败都不影响本次执行 */ }
}

/** Node 依赖通过 NODE_PATH 提供，而 NODE_PATH 只对 CommonJS 生效，所以入口固定 .cjs。 */
const LANGUAGES = {
  python: { file: 'main.py', container: 'python3', posix: 'python3', win32: 'python' },
  node: { file: 'main.cjs', container: 'node', posix: 'node', win32: 'node' },
  sh: { file: 'run.sh', container: '/bin/sh', posix: '/bin/sh', win32: null },
} as const;
type Language = keyof typeof LANGUAGES;
const isLanguage = (value: unknown): value is Language => typeof value === 'string' && Object.hasOwn(LANGUAGES, value);

function interpreterFor(language: Language, container: boolean, platform: NodeJS.Platform): string | null {
  const entry = LANGUAGES[language];
  return container ? entry.container : platform === 'win32' ? entry.win32 : entry.posix;
}

export interface RunCodeOptions {
  /** worker/docker 模式为容器执行；trusted-local 为宿主执行。 */
  container: boolean;
  /** 执行通道由调用方注入：与 bash 共用 core 的 executeShell，测试可替换。 */
  execute: (command: string, ctx: ToolContext) => Promise<string>;
  platform?: NodeJS.Platform;
}

export function runCodeTool(options: RunCodeOptions): Tool {
  const platform = options.platform ?? process.platform;
  const where = options.container
    ? '命令在一次性 Linux 容器里执行，无网络、无宿主路径、最长 120 秒；工作目录是副本，只有发生变化的文件会回写。'
    : '命令在当前机器上直接执行。';
  return {
    name: 'run_code',
    displayName: '运行代码',
    kind: 'bash',
    description:
      '把一段代码写进工作目录并执行，用于没有专用工具时的数据处理、格式转换和自定义计算。先判断能否用已有工具；能用 read/write/bash 组合完成的小事不必写脚本。' +
      'language 取 python、node 或 sh，脚本保存在 .workpivot/run-code/ 下，输出与改动都留在工作目录。' +
      where +
      'Python 只有标准库与 Pillow；Node 用 CommonJS 的 require 加载 docx、exceljs、pptxgenjs；不能联网安装依赖，也不要把密钥写进脚本。',
    parameters: {
      type: 'object',
      properties: {
        language: { type: 'string', enum: ['python', 'node', 'sh'], description: 'python 执行 main.py；node 执行 main.cjs（CommonJS）；sh 执行 run.sh' },
        code: { type: 'string', description: '完整可执行代码；输出写到标准输出' },
      },
      required: ['language', 'code'],
      additionalProperties: false,
    },
    access: (args) => {
      const code = typeof args['code'] === 'string' ? args['code'] : '';
      return { tool: 'run_code', kind: 'bash' as const, paths: [], command: `${String(args['language'] ?? 'unknown')} 代码 ${code.split('\n').length} 行` };
    },
    async run(args, ctx) {
      const language = args['language'];
      if (!isLanguage(language)) return '错误：language 只能是 python、node 或 sh';
      const code = args['code'];
      if (typeof code !== 'string' || !code.trim()) return '错误：code 必填';
      if (code.length > 65536) return '错误：代码不能超过 65536 字符';
      const interpreter = interpreterFor(language, options.container, platform);
      if (!interpreter) return '错误：当前环境不支持 sh，请改用 python 或 node';
      const id = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
      const relative = `.workpivot/run-code/${id}/${LANGUAGES[language].file}`;
      const absolute = canonicalPath(relative, ctx.taskDir);
      if (!pathWithin(absolute, ctx.taskDir)) return '错误：脚本路径越界';
      if (ctx.filePolicy && !ctx.filePolicy(absolute, 'write')) return '错误：无权在工作目录写入脚本';
      // 串行化已上移到 executeCommand 一层（bash 与 run_code 共用同一把锁），这里不再重复加锁。
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, code, 'utf8');
      pruneRunCodeScripts(ctx.taskDir);
      const output = await options.execute(`${interpreter} ${relative}`, ctx);
      return `${output}\n脚本：${relative}`;
    },
  };
}
