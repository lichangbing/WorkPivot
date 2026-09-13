/** Opt-in live test: run inside deployed container. No account changes or command tools. */
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveActiveProvider } from '../packages/server/src/providers.js';
import { availableTools, executionGuidance } from '../packages/server/src/execution-policy.js';
import { BUILTIN_TOOLS, createOpenAICompatibleClient, createAnthropicClient, runAgentLoop } from '../packages/core/src/index.js';
import { pathWithin } from '../packages/shared/src/path-guard.js';

if (process.env['WORKPIVOT_LIVE_EVAL'] !== '1') throw new Error('Set WORKPIVOT_LIVE_EVAL=1 to authorize a live model test');
const config = resolveActiveProvider();
const client = config.protocol === 'anthropic' ? createAnthropicClient(config) : createOpenAICompatibleClient(config);
const root = mkdtempSync(join(tmpdir(), 'workpivot-live-files-'));
const nonce = randomUUID();
writeFileSync(join(root, 'input.json'), JSON.stringify({ income: [125, 75], cost: 35, reference: nonce }));
const events: Array<{ name: string; ok: boolean }> = [];
const options = {
  client, tools: availableTools(BUILTIN_TOOLS, 'disabled'), taskDir: root,
  system: '你是文件处理助手。必须读取真实输入，再保存真实文件。先读后改，不能编造文件内容。' + executionGuidance('disabled'),
  maxSteps: 8, maxDurationMs: 120000, signal: AbortSignal.timeout(150000),
  filePolicy: (path: string) => pathWithin(path, root),
  requestAccess: async (access: { kind: string; paths: Array<{ path: string }> }) => access.kind !== 'bash' && access.paths.every((item) => pathWithin(item.path, root)),
  onEvent: (event: { type: string; toolName?: string; ok?: boolean }) => { if (event.type === 'tool_result') events.push({ name: event.toolName ?? '', ok: event.ok === true }); },
};
try {
  const first = await runAgentLoop({ ...options, messages: [{ role: 'user', content: '读取 input.json，将所有income求和再减cost，把结果和原始reference保存到 result.json，格式为 {"net":数字,"reference":"原始值"}。完成后简短说明。' }] });
  const result1 = JSON.parse(readFileSync(join(root, 'result.json'), 'utf8'));
  const second = await runAgentLoop({ ...options, messages: [...first.messages.filter((message) => message.role !== 'system'), { role: 'user', content: '继续刚才的任务：先读取 result.json，将 net 增加5，reference保持不变，写回 result.json 并简短说明。' }] });
  const result2 = JSON.parse(readFileSync(join(root, 'result.json'), 'utf8'));
  const checks = {
    firstCompleted: first.stopReason === 'completed', firstCalculation: result1.net === 165,
    inputReferencePreserved: result1.reference === nonce, continuationCompleted: second.stopReason === 'completed',
    continuedCalculation: result2.net === 170, referencePreserved: result2.reference === nonce,
    realRead: events.some((event) => event.name === 'read' && event.ok), realWrite: events.filter((event) => event.name === 'write' && event.ok).length >= 2,
    noCommand: events.every((event) => event.name !== 'bash'),
  };
  console.log(JSON.stringify({ model: config.model, checks, passed: Object.values(checks).every(Boolean), scope: 'live core file tools; isolated temporary directory; no business account changes' }));
  if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
} catch { console.error('LIVE_FILE_EVAL_FAILED'); process.exitCode = 1; }
finally { rmSync(root, { recursive: true, force: true }); }
