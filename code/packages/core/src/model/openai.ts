/**
 * T1-06：OpenAI 兼容协议客户端（手写 SSE 累积解析，不用 SDK 的 partial JSON）。
 * 覆盖 DeepSeek/Qwen/GLM/Kimi/Ollama/LM Studio 等一切 OpenAI 兼容端点。
 * 循环信号依据竞品实证：只认流中组装出的 tool_calls，不依赖 finish_reason。
 */
import { parseSSEStream } from './sse.js';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export type StreamEvent =
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'tool_calls'; tool_calls: ToolCall[] };

export interface ModelClient {
  readonly providerId: string;
  readonly model: string;
  streamChat(messages: ChatMessage[], tools: ToolSchema[], signal?: AbortSignal): AsyncGenerator<StreamEvent, void, unknown>;
}

export interface ModelClientOptions {
  providerId: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
}

interface AccumulatedToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** 连接超时：等待响应头上限（首字节前的停滞由它兜底；流中停滞由 sse 空闲超时兜底）。 */
const CONNECT_TIMEOUT_MS = 120_000;

/** 组合外部 signal 与连接超时：响应头到达后撤销计时器，外部中止始终生效。 */
function connectSignal(external: AbortSignal | undefined): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  external?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', onAbort);
    },
  };
}

export function createOpenAICompatibleClient(options: ModelClientOptions): ModelClient {
  const base = options.baseUrl.replace(/\/+$/, '');

  async function* streamChat(
    messages: ChatMessage[],
    tools: ToolSchema[],
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent, void, unknown> {
    const conn = connectSignal(signal);
    let response: Response;
    try {
      response = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: options.model,
          max_tokens: 8192,
          messages,
          ...(tools.length > 0 ? { tools: tools.map((t) => ({ type: 'function', function: t })) } : {}),
          stream: true,
          stream_options: { include_usage: true },
        }),
        signal: conn.signal,
      });
    } finally {
      conn.done();
    }
    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '');
      throw new Error(`模型请求失败 HTTP ${response.status}：${detail.slice(0, 300)}`);
    }

    let content = '';
    const calls = new Map<number, AccumulatedToolCall>();

    for await (const data of parseSSEStream(response.body, signal)) {
      if (data === '[DONE]') break;
      let parsed: {
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        choices?: Array<{
          delta?: {
            content?: string | null;
            tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
          };
        }>;
      };
      try {
        parsed = JSON.parse(data);
      } catch {
        continue; // 非 JSON 行（心跳/注释）跳过
      }
      const usage = parsed.usage;
      if (usage && Number.isSafeInteger(usage.prompt_tokens) && usage.prompt_tokens! >= 0 && Number.isSafeInteger(usage.completion_tokens) && usage.completion_tokens! >= 0) {
        yield { type: 'usage', inputTokens: usage.prompt_tokens!, outputTokens: usage.completion_tokens! };
      }
      const delta = parsed.choices?.[0]?.delta;
      if (!delta) continue;
      // S228：思考过程（DeepSeek reasoning_content / Qwen reasoning）——与正文增量分开推送
      const reasoning = (delta as { reasoning_content?: string; reasoning?: string }).reasoning_content
        ?? (delta as { reasoning?: string }).reasoning;
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        yield { type: 'reasoning_delta', text: reasoning };
      }
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        content += delta.content;
        yield { type: 'delta', text: delta.content };
      }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const index = tc.index ?? 0;
          const acc = calls.get(index) ?? { id: '', name: '', arguments: '' };
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name += tc.function.name;
          if (tc.function?.arguments) acc.arguments += tc.function.arguments;
          calls.set(index, acc);
        }
      }
    }

    if (calls.size > 0) {
      const tool_calls: ToolCall[] = [...calls.values()].map((c, i) => ({
        id: c.id || `call_${Date.now()}_${i}`,
        type: 'function',
        function: { name: c.name, arguments: c.arguments || '{}' },
      }));
      yield { type: 'tool_calls', tool_calls };
    } else if (content.length === 0) {
      // 无内容也无工具调用：让上层决定（视为空回复结束）
    }
  }

  return { providerId: options.providerId, model: options.model, streamChat };
}

/** C02 保存前验活：真实请求 GET /models，200 即通过。 */
export async function verifyProvider(baseUrl: string, apiKey?: string): Promise<{ ok: boolean; detail: string }> {
  const base = baseUrl.replace(/\/+$/, '');
  try {
    const response = await fetch(`${base}/models`, {
      headers: { ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) return { ok: true, detail: '验活通过（GET /models 200）' };
    return { ok: false, detail: `HTTP ${response.status}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
