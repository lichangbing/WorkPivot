/**
 * T1-04：agent 循环（自研微内核，ADR-002）。
 * 朴素 while 主循环＋工具回填；循环信号=流中组装出的 tool_calls；
 * 每次续转带 stopReason 便于调试审计；错误恢复从简（M0）。
 */
import type { ModelClient, ChatMessage, ToolCall, ToolSchema } from './model/openai.js';
import type { Tool, ToolContext, ToolAccessRequest } from './tools.js';

export type AgentEventType = 'assistant_delta' | 'tool_use' | 'tool_result' | 'error';

export interface AgentEvent {
  type: AgentEventType;
  text?: string;
  toolName?: string;
  args?: unknown;
  ok?: boolean;
  message?: string;
}

export type StopReason = 'completed' | 'max_steps' | 'aborted' | 'error';

export interface RunAgentOptions {
  client: ModelClient;
  tools: Tool[];
  system: string;
  messages: ChatMessage[];
  /** 任务目录（工具的路径边界） */
  taskDir: string;
  /** 权限判定钩子（服务层实现：档位+授权卡）。缺省 = 全部放行（信任环境）。 */
  requestAccess?: (req: ToolAccessRequest) => Promise<boolean>;
  maxSteps?: number;
  onEvent?: (event: AgentEvent) => void;
  signal?: AbortSignal;
}

export interface RunAgentResult {
  messages: ChatMessage[];
  steps: number;
  stopReason: StopReason;
}

const MAX_STEPS_DEFAULT = 200;

export async function runAgentLoop(options: RunAgentOptions): Promise<RunAgentResult> {
  const { client, tools, system, signal, taskDir } = options;
  const maxSteps = options.maxSteps ?? MAX_STEPS_DEFAULT;
  const messages: ChatMessage[] = [{ role: 'system', content: system }, ...options.messages];
  const toolSchemas: ToolSchema[] = tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
  const ctx: ToolContext = {
    taskDir,
    signal,
    requestAccess: options.requestAccess,
    extraAllowedDirs: [],
  };

  let steps = 0;
  let stopReason: StopReason = 'completed';

  while (true) {
    if (signal?.aborted) {
      stopReason = 'aborted';
      break;
    }
    if (steps >= maxSteps) {
      stopReason = 'max_steps';
      break;
    }
    steps += 1;

    let assistantText = '';
    let toolCalls: ToolCall[] | null = null;
    try {
      for await (const event of client.streamChat(messages, toolSchemas, signal)) {
        if (event.type === 'delta') {
          assistantText += event.text;
          options.onEvent?.({ type: 'assistant_delta', text: event.text });
        } else {
          toolCalls = event.tool_calls;
        }
      }
    } catch (err) {
      if (signal?.aborted) {
        stopReason = 'aborted';
        break;
      }
      options.onEvent?.({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      stopReason = 'error';
      break;
    }

    if (toolCalls === null || toolCalls.length === 0) {
      messages.push({ role: 'assistant', content: assistantText });
      break; // 纯文本回复 → 循环完成
    }

    // 有工具调用：先落 assistant（含 tool_calls），再逐个执行回填
    messages.push({ role: 'assistant', content: assistantText || null, tool_calls: toolCalls });
    for (const call of toolCalls) {
      if (signal?.aborted) {
        stopReason = 'aborted';
        break;
      }
      const tool = tools.find((t) => t.name === call.function.name);
      options.onEvent?.({ type: 'tool_use', toolName: call.function.name, args: safeParse(call.function.arguments) });
      let resultText: string;
      let ok = true;
      if (!tool) {
        ok = false;
        resultText = `错误：未知工具 ${call.function.name}`;
      } else {
        try {
          // 权限判定（T2-04/05）：声明访问 → 钩子判定；拒绝则以错误回填，不执行
          let allowed = true;
          if (ctx.requestAccess && tool.access) {
            const request = tool.access(safeParse(call.function.arguments), ctx);
            allowed = await ctx.requestAccess(request);
            if (allowed) ctx.extraAllowedDirs = request.paths.map((p) => p.path);
          }
          if (allowed) {
            resultText = await tool.run(safeParse(call.function.arguments), ctx);
          } else {
            ok = false;
            resultText = '权限不足：用户拒绝或当前策略禁止本次访问。请改用任务目录内的路径，或提示用户调整权限档位。';
          }
        } catch (err) {
          ok = false;
          resultText = `错误：${err instanceof Error ? err.message : String(err)}`;
        }
      }
      options.onEvent?.({ type: 'tool_result', toolName: call.function.name, ok, message: resultText.slice(0, 200) });
      messages.push({ role: 'tool', tool_call_id: call.id, content: resultText });
    }
    if (stopReason === 'aborted') break;
  }

  return { messages, steps, stopReason };
}

function safeParse(json: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
