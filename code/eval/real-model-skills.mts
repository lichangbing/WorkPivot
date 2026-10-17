/** 显式启用的真实服务评测，使用现有模型配置及隔离的临时技能和文件。 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { resolveActiveProvider } from '../packages/server/src/providers.js';
import { listSkills, renderSkillDirectory } from '../packages/server/src/skills.js';
import { buildSkillTools } from '../packages/server/src/skill-tools.js';
import { availableTools, executionGuidance } from '../packages/server/src/execution-policy.js';
import { BUILTIN_TOOLS, createOpenAICompatibleClient, createAnthropicClient, runAgentLoop } from '../packages/core/src/index.js';
import { pathWithin } from '../packages/shared/src/path-guard.js';
if (process.env['WORKPIVOT_LIVE_EVAL'] !== '1') throw new Error('Set WORKPIVOT_LIVE_EVAL=1 to run live evaluation');
const config = resolveActiveProvider();
const root = mkdtempSync(join(tmpdir(), 'wp-live-skills-'));
const directory = join(root, '.workpivot/skills/acceptance-note');
mkdirSync(join(directory, 'references'), { recursive: true });
const marker = randomUUID();
writeFileSync(join(directory, 'SKILL.md'), '---\nname: acceptance-note\ndescription: 用户要求按验收摘要规范生成Markdown说明时使用。\n---\n必须先加载本技能references/format.md，按其格式生成摘要。内容数据读取input.txt。');
writeFileSync(join(directory, 'references/format.md'), `输出summary.md，包含一级标题“验收摘要”、输入数据中的负责人及交付日期，并在最后一行写“核验标识：${marker}”。`);
writeFileSync(join(root, 'input.txt'), '负责人：测试人员甲\n交付日期：2026-09-09');
const allowed = (path: string) => pathWithin(path, root);
const discover = () => listSkills(root, { projectFileAllowed: allowed }).filter((skill) => skill.name === 'acceptance-note');
const loaded: string[] = [];
let wrote = false;
try {
  const result = await runAgentLoop({
    client: config.protocol === 'anthropic' ? createAnthropicClient(config) : createOpenAICompatibleClient(config),
    tools: [...availableTools(BUILTIN_TOOLS, 'disabled'), ...buildSkillTools(discover, allowed)], taskDir: root,
    system: '按用户要求处理文件。' + renderSkillDirectory(discover()) + executionGuidance('disabled'),
    messages: [{ role: 'user', content: '请根据input.txt按验收摘要规范生成summary.md，保存文件并简短说明。' }],
    filePolicy: allowed, requestAccess: async (request) => request.kind !== 'bash' && request.paths.every((item) => allowed(item.path)),
    maxSteps: 10, maxDurationMs: 120000, signal: AbortSignal.timeout(150000),
    onEvent: (event) => { if (event.type === 'tool_use' && event.toolName === 'load_skill') loaded.push(String((event.args as { file?: string }).file ?? 'SKILL.md')); if (event.type === 'tool_result' && event.toolName === 'write' && event.ok) wrote = true; },
  });
  const output = readFileSync(join(root, 'summary.md'), 'utf8');
  const checks = { completed: result.stopReason === 'completed', autonomousSkillLoad: loaded.includes('SKILL.md'), referenceLoaded: loaded.includes('references/format.md'), actualFileWrite: wrote, heading: output.includes('# 验收摘要'), sourceData: output.includes('测试人员甲') && output.includes('2026-09-09'), referenceFollowed: output.includes(marker) };
  console.log(JSON.stringify({ model: config.model, checks, passed: Object.values(checks).every(Boolean), scope: 'live core skill selection and resource loading; isolated temporary fixture' }));
  if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
} catch { console.error('LIVE_SKILL_EVAL_FAILED'); process.exitCode = 1; }
finally { rmSync(root, { recursive: true, force: true }); }
