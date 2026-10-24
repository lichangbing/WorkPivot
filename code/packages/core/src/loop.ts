/**
 * T1-04/T3：agent 循环（自研微内核，ADR-002）。
 * W3 韧性：强制收尾（步数/时长上限→无工具请求答三件事）、卡循环检测（3 提醒/5 拦截）、
 *          工具结果预算（>50k 交 stashResult 落盘）、循环信号=流中 tool_calls（竞品实证）。
 */
import { createHash } from 'node:crypto';
import { canonicalPath } from '@workpivot/shared/node';
import { compactMessages, CONTEXT_CHAR_BUDGET } from './context.js';
import type { ModelClient, ChatMessage, ToolCall, ToolSchema } from './model/openai.js';
import type { Tool, ToolContext, ToolAccessRequest } from './tools.js';

export type AgentEventType = 'assistant_delta' | 'reasoning_delta' | 'tool_use' | 'tool_status' | 'tool_result' | 'error' | 'ask_user' | 'usage';

export interface AgentEvent {
  displayName?: string;
  callId?: string;
  durationMs?: number;
  status?: 'waiting' | 'running' | 'ok' | 'error' | 'denied' | 'stopped';
  type: AgentEventType;
  text?: string;
  toolName?: string;
  args?: unknown;
  ok?: boolean;
  message?: string;
  /** 子代理事件前缀：非空表示由 delegate 子循环产生，用于前端折叠展示。 */
  delegateId?: string;
  /** 结构化提问事件（type=ask_user）：问题与选项，用户回答作为下一条消息进入历史。 */
  questionId?: string;
  question?: string;
  options?: Array<{ label: string; description?: string }>;
  allowFreeText?: boolean;
  /** 用量事件（type=usage）：整轮累计的输入/输出 token，供成本统计与审计。 */
  inputTokens?: number;
  outputTokens?: number;
}

export type StopReason = 'completed' | 'max_steps' | 'time_limit' | 'aborted' | 'error';

export interface RunAgentOptions {
  client: ModelClient;
  tools: Tool[];
  system: string;
  messages: ChatMessage[];
  /** 任务目录（工具的路径边界） */
  taskDir: string;
  /** 权限判定钩子（服务层实现：档位+授权卡）。缺省 = 全部放行（信任环境）。 */
  requestAccess?: (req: ToolAccessRequest) => Promise<boolean>;
  /** 最大模型采样轮数（默认 200） */
  maxSteps?: number;
  /** 最大执行时长 ms（默认不限；超限触发强制收尾） */
  maxDurationMs?: number;
  /** 工具结果超预算时的落盘钩子：返回替换后的引用文本（K04/T3-06） */
  stashResult?: (content: string) => Promise<string>;
  /** 模型只回文本就停下时的兜底：返回非空字符串则作为用户消息继续，最多 idleLimit 次 */
  onIdle?: (info: { steps: number; toolCalls: number; text: string }) => Promise<string | null> | string | null;
  /** onIdle 的最大触发次数（默认 1；0 关闭） */
  idleLimit?: number;
  /** 消息字符预算，超过后压缩较早的工具结果；≤0 关闭（默认 120k） */
  contextBudget?: number;
  /** bash 子进程附加环境变量（NODE_PATH 等） */
  extraEnv?: Record<string, string>;
  filePolicy?: ToolContext['filePolicy'];
  executeCommand?: ToolContext['executeCommand'];
  onEvent?: (event: AgentEvent) => void | Promise<void>;
  signal?: AbortSignal;
}

export interface RunAgentResult {
  messages: ChatMessage[];
  steps: number;
  stopReason: StopReason;
  /** 本轮累计的供应商用量（O-05）：多次采样求和，用于成本与审计。 */
  usage: { inputTokens: number; outputTokens: number };
}

export const MAX_STEPS_DEFAULT = 200;
export const MAX_DURATION_DEFAULT_MS = 30 * 60_000;
/** 工具结果预算（K04）：超过该字符数的结果交给 stashResult 落盘，模型只拿预览 */
export const RESULT_STASH_THRESHOLD = 50_000;

const FORCED_WRAP_PROMPT =
  '任务执行预算已用尽,请立即停止调用任何工具,只用一段话回答三点:1) 已完成了什么;2) 实际产出了哪些真实文件(给出相对路径);3) 下次从哪里继续。';

function fingerprint(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 12);
}

function safeParse(json: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function runAgentLoop(options: RunAgentOptions): Promise<RunAgentResult> {
  const { client, tools, system, signal, taskDir } = options;
  const maxSteps = options.maxSteps ?? MAX_STEPS_DEFAULT;
  const maxDurationMs = options.maxDurationMs ?? MAX_DURATION_DEFAULT_MS;
  const messages: ChatMessage[] = [{ role: 'system', content: system }, ...options.messages];
  const toolSchemas: ToolSchema[] = tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
  const ctx: ToolContext = {
    taskDir,
    signal,
    requestAccess: options.requestAccess,
    extraAllowedDirs: [],
    extraEnv: options.extraEnv,
    filePolicy: options.filePolicy,
    executeCommand: options.executeCommand,
  };

  const startedAt = Date.now();
  let steps = 0;
  let stopReason: StopReason = 'completed';
  let wrapAttempted = false;
  let toolCallCount = 0;
  let idleContinues = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  const idleLimit = options.idleLimit ?? 1;
  const contextBudget = options.contextBudget ?? CONTEXT_CHAR_BUDGET;

  // 卡循环检测（T3-05/F05）：同工具+同入参+同结果 连续计数
  let lastCallFp = '';
  let lastResultFp = '';
  let identicalCount = 0;

  while (true) {
    if (signal?.aborted) {
      stopReason = 'aborted';
      break;
    }
    const overSteps = steps >= maxSteps;
    const overTime = Date.now() - startedAt > maxDurationMs;
    if ((overSteps || overTime) && !wrapAttempted) {
      // F03 强制收尾：追加一次无工具请求，只答三件事
      wrapAttempted = true;
      stopReason = overSteps ? 'max_steps' : 'time_limit';
      messages.push({ role: 'user', content: FORCED_WRAP_PROMPT });
      await options.onEvent?.({ type: 'assistant_delta', text: '\n\n⚠ 预算已用尽,强制收尾:\n' });
      let finalText = '';
      try {
        for await (const event of client.streamChat(messages, [], signal)) {
          if (event.type === 'delta') {
            finalText += event.text;
            await options.onEvent?.({ type: 'assistant_delta', text: event.text });
          } else if (event.type === 'usage') {
            inputTokens += event.inputTokens;
            outputTokens += event.outputTokens;
          }
        }
        messages.push({ role: 'assistant', content: finalText });
      } catch (err) {
        if (signal?.aborted) {
          stopReason = 'aborted';
        } else {
          await options.onEvent?.({ type: 'error', message: err instanceof Error ? err.message : String(err) });
          stopReason = 'error';
        }
      }
      break;
    }
    if (overSteps || overTime) {
      stopReason = overSteps ? 'max_steps' : 'time_limit';
      break;
    }
    steps += 1;
    // 每轮先压一次：工具结果只增不减，长任务会撑爆窗口并让模型遗忘目标。
    compactMessages(messages, contextBudget);

    let assistantText = '';
    let toolCalls: ToolCall[] | null = null;
    for (let attempt = 0; ; attempt += 1) {
      try {
        for await (const event of client.streamChat(messages, toolSchemas, signal)) {
          if (event.type === 'delta') {
            assistantText += event.text;
            await options.onEvent?.({ type: 'assistant_delta', text: event.text });
          } else if (event.type === 'reasoning_delta') {
            await options.onEvent?.({ type: 'reasoning_delta', text: event.text });
          } else if (event.type === 'tool_calls') {
            toolCalls = event.tool_calls;
          } else if (event.type === 'usage') {
            inputTokens += event.inputTokens;
            outputTokens += event.outputTokens;
          }
        }
        break;
      } catch (err) {
        if (signal?.aborted) {
          stopReason = 'aborted';
          break;
        }
        // 只在尚未产生任何增量时重试一次：已输出的文本不能重放。
        if (attempt === 0 && assistantText === '') {
          await new Promise((resolve) => setTimeout(resolve, 400));
          continue;
        }
        await options.onEvent?.({ type: 'error', message: err instanceof Error ? err.message : String(err) });
        stopReason = 'error';
        break;
      }
    }
    if (stopReason === 'aborted' || stopReason === 'error') break;

    if (toolCalls === null || toolCalls.length === 0) {
      // 纯文本回复：默认结束；但弱模型常“表态就停”，由 onIdle 兜底追问一次。
      const nudge = idleLimit > 0 && idleContinues < idleLimit && options.onIdle
        ? await options.onIdle({ steps, toolCalls: toolCallCount, text: assistantText })
        : null;
      if (nudge) {
        idleContinues += 1;
        // 空文本不能作为 assistant 消息发给供应商；有内容才保留这一轮的回答。
        if (assistantText) messages.push({ role: 'assistant', content: assistantText });
        messages.push({ role: 'user', content: nudge });
        continue;
      }
      messages.push({ role: 'assistant', content: assistantText });
      break; // 纯文本回复 → 循环完成
    }
    toolCallCount += toolCalls.length;

    messages.push({ role: 'assistant', content: assistantText || null, tool_calls: toolCalls });
    // O-13：同一轮里的只读工具互不依赖，可以并行；写入/执行类保持串行，避免权限与文件竞争。
    const callable = toolCalls.map((call) => ({ call, tool: tools.find((t) => t.name === call.function.name) }));
    const parallel = callable.length > 1 && callable.every(({ tool }) => tool?.kind === 'read' && tool.endsTurn !== true);

    type CallResult = { identity: { toolName: string; displayName?: string; callId: string }; tool: (typeof callable)[number]['tool']; argFp: string; ok: boolean; outcome?: AgentEvent['status']; resultText: string; startedAt?: number };
    const runOne = async ({ call, tool }: (typeof callable)[number]): Promise<CallResult> => {
      const identity = { toolName: call.function.name, displayName: tool?.displayName, callId: call.id };
      let startedAt: number | undefined;
      let outcome: AgentEvent['status'];
      let resultText: string;
      let ok = true;
      const argFp = fingerprint(`${call.function.name}:${call.function.arguments}`);
      if (!tool) {
        ok = false;
        resultText = `错误：未知工具 ${call.function.name}`;
      } else if (argFp === lastCallFp && identicalCount >= 4) {
        // F05：已连续 4 次相同调用与结果，第 5 次直接拦截，不再执行
        ok = false;
        resultText = '错误:已连续多次产生完全相同的调用与结果,本次执行被拦截。请必须更换思路、修改参数,或向用户说明情况。';
      } else {
        // 并行的只读调用各自持有独立上下文，避免 extraAllowedDirs 互相覆盖。
        const callCtx: ToolContext = { ...ctx, extraAllowedDirs: [] };
        try {
          let allowed = true;
          let request: ToolAccessRequest | null = null;
          if (callCtx.requestAccess && tool.access) {
            request = tool.access(safeParse(call.function.arguments), callCtx);
            request.paths = request.paths.map((p) => ({ ...p, path: canonicalPath(p.path, callCtx.taskDir) }));
            allowed = await callCtx.requestAccess(request);
            if (allowed) callCtx.extraAllowedDirs = request.paths.map((p) => p.path);
          }
          if (signal?.aborted) {
            return { identity, tool, argFp, ok: false, outcome: 'stopped', resultText: '任务已停止，工具未执行', startedAt: 0 };
          }
          if (allowed) {
            startedAt = Date.now();
            await options.onEvent?.({ type: 'tool_status', ...identity, status: 'running' });
            resultText = await tool.run(safeParse(call.function.arguments), callCtx);
          } else {
            outcome = 'denied';
            ok = false;
            resultText = request?.external ? '外部工具调用未获授权：用户拒绝或当前策略禁止本次外部操作。' : '权限不足：用户拒绝或当前策略禁止本次访问。请改用任务目录内的路径，或提示用户调整权限档位。';
          }
        } catch (err) {
          ok = false;
          resultText = `错误：${err instanceof Error ? err.message : String(err)}`;
        }
      }
      return { identity, tool, argFp, ok, outcome, resultText, startedAt };
    };

    for (const entry of callable) {
      await options.onEvent?.({ type: 'tool_use', toolName: entry.call.function.name, displayName: entry.tool?.displayName, callId: entry.call.id, status: entry.tool?.displayName ? 'waiting' : 'running', args: safeParse(entry.call.function.arguments) });
    }
    const results = parallel ? await Promise.all(callable.map(runOne)) : await (async () => {
      const collected: CallResult[] = [];
      for (const entry of callable) collected.push(await runOne(entry));
      return collected;
    })();

    for (let index = 0; index < callable.length; index += 1) {
      if (signal?.aborted) {
        stopReason = 'aborted';
        break;
      }
      const { identity, tool, argFp, ok, outcome, startedAt } = results[index]!;
      let { resultText } = results[index]!;
      if (results[index]!.outcome === 'stopped') {
        stopReason = 'aborted';
        await options.onEvent?.({ type: 'tool_result', ...identity, ok: false, status: 'stopped', durationMs: 0, message: resultText });
        break;
      }

      // 卡循环计数更新（仅在真实执行后）
      if (ok) {
        const resultFp = fingerprint(resultText);
        if (argFp === lastCallFp && resultFp === lastResultFp) {
          identicalCount += 1;
        } else {
          identicalCount = 1;
          lastCallFp = argFp;
          lastResultFp = resultFp;
        }
      }
      if (ok && identicalCount >= 3 && identicalCount < 5) {
        resultText = `[系统] 注意:这是第 ${identicalCount} 次完全相同的调用与结果,继续重复将被拦截。请更换思路或向用户说明。\n${resultText}`;
      }

      // 工具结果预算（K04/T3-06）：超阈值先落盘，再以预览回填/外发
      if (options.stashResult && resultText.length > RESULT_STASH_THRESHOLD) {
        resultText = await options.stashResult(resultText);
      }
      await options.onEvent?.({ type: 'tool_result', ...identity, ok, status: signal?.aborted ? 'stopped' : outcome ?? (ok ? 'ok' : 'error'), durationMs: startedAt === undefined ? 0 : Date.now() - startedAt, message: resultText.slice(0, tool?.displayName ? 8000 : 200) });
      messages.push({ role: 'tool', tool_call_id: callable[index]!.call.id, content: resultText });
    }
    // 声明 endsTurn 的工具（如结构化提问）执行后结束本轮：等用户回答，不进入下一次采样。
    if (toolCalls.some((call) => tools.find((t) => t.name === call.function.name)?.endsTurn)) {
      stopReason = 'completed';
      break;
    }
    if (stopReason === 'aborted') break;
  }

  // 用量作为独立事件发出，服务层据此写转写与审计（不改变对话内容）。
  await options.onEvent?.({ type: 'usage', inputTokens, outputTokens });
  return { messages, steps, stopReason, usage: { inputTokens, outputTokens } };
}
