import { randomUUID } from 'node:crypto';
import { runAgentLoop, type AgentEvent, type ModelClient, type RunAgentOptions, type Tool } from '@workpivot/core';

/**
 * R005 子代理（单层、同步）。
 *
 * 目的：把"上下文很长、可以独立完成"的子任务放到独立循环里跑，父上下文只拿结论。
 * 与事后压缩的区别：压缩是补救，子任务是事前隔离。
 *
 * 边界（与路线图一致，不在这里扩展）：
 * - 只支持单层：子工具集剔除 delegate 与 ask_user，子代理不能再委派、不能向用户提问；
 * - 同步：父循环阻塞等待，不做后台并发；同一父运行内的多次调用严格串行，避免成本与文件冲突叠加；
 * - 不切换模型/供应商：沿用父级 client；
 * - 不跨任务/跨目录：沿用父级 taskDir、filePolicy、executeCommand 与 requestAccess；
 * - 失败不炸父任务：抛错、超预算、被取消都以工具结果文本返回，父代理可以决定重试或换做法。
 */

const DEFAULT_STEPS = 20;
const MAX_STEPS_LIMIT = 50;
const MAX_DURATION_MS = 10 * 60_000;
const CONTEXT_LIMIT = 4000;

export const DELEGATE_TOOL_NAME = 'delegate';
/** 子代理工具集里必须剔除的工具：禁止递归委派，提问统一由父代理负责。 */
export const DELEGATE_EXCLUDED = [DELEGATE_TOOL_NAME, 'ask_user'] as const;

const SUB_SYSTEM = [
  '[子代理模式] 你只负责下面这一个子任务，完成后给出结论。',
  '看不到父对话历史，也不要把父级未提供的信息当作已知；缺少必要信息时在结论里说明缺什么。',
  '不要向用户提问，不要委派新的子任务，不要声称执行了未调用的工具。',
  '可以用工具读取资料、写文件；写入直接落在工作目录，父代理能看到。',
  '结论要包含：完成了什么、产出了哪些相对路径、还剩什么问题。资源边界与权限规则沿用父级。',
].join('\n');

export interface DelegationOptions {
  client: ModelClient;
  /** 父级工具集；构造时会剔除 delegate 与 ask_user，避免递归与两处弹卡。 */
  tools: Tool[];
  system: string;
  requestAccess?: RunAgentOptions['requestAccess'];
  filePolicy?: RunAgentOptions['filePolicy'];
  executeCommand?: RunAgentOptions['executeCommand'];
  contextBudget?: number;
  signal?: AbortSignal;
  /** 子事件带 delegateId 转发给父级运行，前端按前缀折叠展示。 */
  emit: (event: AgentEvent, delegateId: string) => void | Promise<void>;
}

function text(value: unknown, field: string, limit: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw Error(`${field} 不能为空`);
  const trimmed = value.trim();
  if (trimmed.length > limit) throw Error(`${field} 不能超过 ${limit} 字`);
  return trimmed;
}

function stepLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_STEPS;
  const steps = Number(value);
  if (!Number.isInteger(steps) || steps < 1 || steps > MAX_STEPS_LIMIT) throw Error(`max_steps 必须是 1-${MAX_STEPS_LIMIT} 的整数`);
  return steps;
}

/** 子循环的最终答复：取最后一条有正文的 assistant 消息。 */
function finalText(messages: { role: string; content?: string | null }[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === 'assistant' && typeof message.content === 'string' && message.content.trim()) return message.content;
  }
  return '';
}

export function delegateTool(options: DelegationOptions): Tool {
  const subTools = options.tools.filter((tool) => !DELEGATE_EXCLUDED.includes(tool.name as (typeof DELEGATE_EXCLUDED)[number]));
  const contextBudget = options.contextBudget ?? 120_000;
  // 同一父运行内串行：并发调用排队等待，不并行叠加成本。
  let queue: Promise<unknown> = Promise.resolve();

  const tool: Tool = {
    name: DELEGATE_TOOL_NAME,
    displayName: '委派子任务',
    kind: 'write',
    description:
      '把一件独立、可自包含的子任务交给子代理单独执行，只返回结论，父对话上下文不进入子代理。' +
      '适用于：需要读完很长的资料再汇总、批量处理多个文件、可以并行的独立步骤。' +
      '子代理看不到当前对话，task 必须自包含；不要把「你刚才说的」这类指代写进 task。' +
      '不能提问、不能再次委派；同步执行，调用会等到子任务结束。' +
      '失败或超出预算时返回带 stopReason 的文本，可以据此重试或改用别的做法。',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '子任务目标，自包含，不含指代' },
        context: { type: 'string', description: `必要背景，最多 ${CONTEXT_LIMIT} 字；不传父对话历史` },
        max_steps: { type: 'integer', description: `模型采样轮数上限，1-${MAX_STEPS_LIMIT}，默认 ${DEFAULT_STEPS}` },
      },
      required: ['task'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const task = text(args['task'], 'task', 4000);
      const context = args['context'] === undefined ? '' : text(args['context'], 'context', CONTEXT_LIMIT);
      const maxSteps = stepLimit(args['max_steps']);
      const delegateId = randomUUID();
      if (subTools.length === 0) {
        return JSON.stringify({ result: '子任务未执行：当前没有可用的子工具。', steps: 0, stopReason: 'error' });
      }

      const run = queue.then(async () => {
        const signals = [options.signal, ctx.signal].filter((value): value is AbortSignal => value !== undefined);
        const signal = signals.length > 0 ? AbortSignal.any(signals) : undefined;
        try {
          const result = await runAgentLoop({
            client: options.client,
            tools: subTools,
            system: `${SUB_SYSTEM}\n\n父级规则（同样适用）：\n${options.system}`,
            messages: [{ role: 'user', content: context ? `${task}\n\n【背景】\n${context}` : task }],
            taskDir: ctx.taskDir,
            requestAccess: options.requestAccess,
            filePolicy: options.filePolicy,
            executeCommand: options.executeCommand,
            maxSteps,
            maxDurationMs: MAX_DURATION_MS,
            contextBudget,
            // 子代理不追问：模型只回文本就结束，交给父代理判断。
            idleLimit: 0,
            onEvent: (event) => options.emit({ ...event, delegateId }, delegateId),
            signal,
          });
          return JSON.stringify({ result: finalText(result.messages), steps: result.steps, stopReason: result.stopReason, delegateId });
        } catch (error) {
          // 子循环失败不能中断父任务：转成工具结果文本，父代理可重试或换做法。
          const reason = error instanceof Error ? error.message : String(error);
          return JSON.stringify({ result: `子任务未完成：${reason.slice(0, 300)}`, steps: 0, stopReason: 'error', delegateId });
        }
      });
      queue = run.catch(() => undefined);
      return run;
    },
  };
  return tool;
}
