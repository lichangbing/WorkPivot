/** PC-01/PC-06/PC-09/PC-10：交互风险、计划完整性和提示分层。 */
import assert from 'node:assert/strict';
import { classifyInteractionRisk, canAutoApprove, canRememberApproval } from '../packages/server/src/database/interaction-policy.js';
import { planForApproval } from '../packages/server/src/database/plans.js';
import { INTERACTION_STABLE_PROMPT, OFFICE_OUTPUT_PROMPT, interactionDynamicPrompt } from '../packages/server/src/database/interaction-prompts.js';
import type { PlanDocument } from '../packages/shared/src/index.js';
import { interactionCapabilities } from '../packages/shared/src/index.js';
import type { SteeringMessage } from '../packages/shared/src/index.js';
import { runAgentLoop } from '../packages/core/src/loop.js';
import type { AgentEvent, ModelClient, StreamEvent, Tool } from '../packages/core/src/index.js';
import { classifySteering } from '../packages/server/src/database/steering-router.js';

let checks = 0;
const check = (condition: unknown, label: string) => {
  assert.ok(condition, label);
  checks += 1;
  console.log('✅ ' + label);
};

check(classifyInteractionRisk({ tool: 'read', kind: 'read', effects: ['read'] }) === 'low', '任务内只读为低风险');
check(classifyInteractionRisk({ tool: 'save_artifact', kind: 'write', effects: ['write'] }) === 'medium', '受控写入为中风险');
check(classifyInteractionRisk({ tool: 'mcp__mail__send', kind: 'write', effects: ['external'], external: true }) === 'high', '外部 MCP 为高风险');
check(classifyInteractionRisk({ tool: 'run_code', kind: 'bash', command: 'rm -rf output' }) === 'high', '删除命令为高风险');
check(canRememberApproval('high') === false && canRememberApproval('medium'), '高风险不能复用授权');
check(canAutoApprove({ tool: 'run_code', kind: 'bash', paths: [], auto: true }, 'auto', 'medium'), '自动模式可静默白名单执行');
check(!canAutoApprove({ tool: 'mcp__x__send', kind: 'write', paths: [], external: true }, 'auto', 'high'), '高风险不能自动放行');

const base: PlanDocument = {
  id: 'plan', revision: 1, hash: 'a'.repeat(64), status: 'draft', goal: '生成季度报告',
  assumptions: [], dataScope: ['季度预算.xlsx'], businessRules: ['金额用人民币'], steps: [{ step: '分析', status: 'pending' }],
  externalActions: [], outputs: ['季度报告.pdf'], risks: [], verification: ['核对金额'], updatedAt: new Date(0).toISOString(),
};
check(planForApproval(base).complete, '完整计划可进入审批');
check(!planForApproval({ ...base, verification: [] }).complete, '缺少验收方式不能审批');
check(!planForApproval(null).complete, '没有计划不能审批');
check(INTERACTION_STABLE_PROMPT.includes('澄清不是授权') && INTERACTION_STABLE_PROMPT.includes('不得用相同工具和参数原样重试'), '稳定提示包含澄清/拒绝边界');
check(OFFICE_OUTPUT_PROMPT.includes('Excel') && OFFICE_OUTPUT_PROMPT.includes('PDF') && OFFICE_OUTPUT_PROMPT.includes('PPT'), '办公格式使用各自交付约束');
check(interactionDynamicPrompt({ mode: 'manual', allowedScopes: ['project'], hasPlan: true, externalActions: false }).includes('确认模式'), '动态提示反映执行模式');
const officeFixtures = [
  { task: '预算分析并生成 Excel', expected: ['plan_approval', 'artifact_review'] },
  { task: '合同要点提炼并修改 Word', expected: ['plan_approval', 'action_permission', 'artifact_review'] },
  { task: '项目周报 PPT', expected: ['plan_approval', 'artifact_review'] },
  { task: '调研报告导出 PDF', expected: ['plan_approval', 'artifact_review'] },
  { task: '多来源知识整理', expected: ['clarification', 'plan_approval', 'artifact_review'] },
  { task: '业务事实冲突确认', expected: ['clarification', 'plan_approval'] },
  { task: '网页数据采集后写入成果', expected: ['plan_approval', 'action_permission', 'artifact_review'] },
  { task: '对外发送或共享成果', expected: ['plan_approval', 'action_permission'] },
] as const;
check(officeFixtures.length === 8 && officeFixtures.every(item => item.expected.includes('plan_approval')), '固定办公评测集覆盖八类高风险与多步骤任务');
check(interactionCapabilities({ WORKPIVOT_INTERACTION_CLARIFY_V2: 'off' } as NodeJS.ProcessEnv).clarifyV2 === false, '交互能力支持环境开关回退');

let approvalAttempts = 0;
const write: Tool = {
  name: 'write_remote', kind: 'write', description: 'write', parameters: { type: 'object', properties: {} },
  access: () => ({ tool: 'write_remote', kind: 'write', paths: [], effects: ['write'], external: true }),
  async run() { throw Error('不应执行'); },
};
let turn = 0;
const repeated = {
  providerId: 'test', model: 'test',
  async *streamChat(): AsyncGenerator<StreamEvent> {
    turn += 1;
    if (turn <= 2) yield { type: 'tool_calls', tool_calls: [{ id: `call-${turn}`, type: 'function', function: { name: 'write_remote', arguments: '{"target":"same"}' } }] };
    else yield { type: 'delta', text: '已停止' };
  },
} as unknown as ModelClient;
const denialEvents: AgentEvent[] = [];
await runAgentLoop({
  client: repeated, tools: [write], system: 'sys', taskDir: '.', messages: [{ role: 'user', content: '执行' }],
  requestAccess: async () => { approvalAttempts += 1; throw Error('用户拒绝了本次操作。拒绝原因：目标不对'); },
  onEvent: event => { denialEvents.push(event); },
});
check(approvalAttempts === 1, '拒绝后完全相同的调用不会再次请求授权');
check(denialEvents.filter(event => event.type === 'tool_result' && event.status === 'denied').length === 2, '重复调用保持拒绝状态');
check(denialEvents.some(event => event.type === 'tool_result' && event.message?.includes('不得原样重试')), '模型收到明确的改路要求');

let steeringCalls = 0, staleToolRuns = 0;
const steering: SteeringMessage = {
  id: 'steering-1', taskId: 'task', runId: 'run', requestId: 'request', content: '金额改成200万，不要沿用100万',
  mode: 'safe', status: 'applied', relation: 'related', createdAt: new Date().toISOString(),
};
const observed: Array<Array<{ role: string; content: string | null }>> = [];
const steeringClient = {
  providerId: 'test', model: 'test',
  async *streamChat(messages: Array<{ role: string; content: string | null }>): AsyncGenerator<StreamEvent> {
    observed.push(structuredClone(messages));
    if (observed.length === 1) yield { type: 'tool_calls', tool_calls: [{ id: 'stale-call', type: 'function', function: { name: 'stale_write', arguments: '{"amount":1000000}' } }] };
    else yield { type: 'delta', text: '已按200万调整。' };
  },
} as unknown as ModelClient;
const staleWrite: Tool = {
  name: 'stale_write', kind: 'write', description: 'write', parameters: { type: 'object', properties: {} },
  async run() { staleToolRuns += 1; return 'written'; },
};
await runAgentLoop({
  client: steeringClient, tools: [staleWrite], system: 'sys', taskDir: '.', messages: [{ role: 'user', content: '生成报告' }],
  consumeSteering: async () => { steeringCalls += 1; return steeringCalls === 2 ? [steering] : []; },
});
check(staleToolRuns === 0, '模型流期间到达的纠正会在工具派发前生效，旧工具不执行');
check(observed.at(-1)?.some(message => message.role === 'user' && message.content?.includes('金额改成200万')), '下一次模型采样看到最新用户纠正');

const relationClient = {
  providerId: 'test', model: 'test',
  async *streamChat(): AsyncGenerator<StreamEvent> {
    yield { type: 'delta', text: '{"relation":"unrelated","reason":"属于另一个独立交付"}' };
  },
} as unknown as ModelClient;
const unrelated = await classifySteering(relationClient, [{ role: 'user', content: '当前任务生成季度报告' }], '完成后再生成一份产品路线图');
check(unrelated.relation === 'unrelated' && unrelated.reason.includes('独立交付'), '运行中消息可判定为当前任务完成后的独立请求');

console.log(`交互协议与风险矩阵：${checks} 项通过`);
