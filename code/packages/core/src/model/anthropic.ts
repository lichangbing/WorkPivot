/**
 * M1-06：Anthropic Messages 协议客户端（Claude 官方 / 兼容代理）。
 * 与 openai.ts 实现同一 ModelClient 接口，对 loop 透明：
 * - 请求：system 抽到顶层；tool_calls → tool_use 块；tool 结果 → user 的 tool_result 块（相邻合并）。
 * - 流式：content_block_delta(text_delta/input_json_delta) 累积；结束组装 tool_calls 事件。
 * Bedrock/Vertex 直连留 P2（需各自签名头）。
 */
import type { ChatMessage, ModelClient, ModelClientOptions, StreamEvent, ToolCall, ToolSchema } from './openai.js';
import { parseSSEStream } from './sse.js';

const ANTHROPIC_VERSION = '2023-06-01';

/** baseUrl 规范到端点前缀：`https://api.anthropic.com` 与 `…/v1` 都接受。 */
function endpointBase(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return base.endsWith('/v1') ? base : `${base}/v1`;
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
}
interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

/** 内部消息 → Anthropic 消息（system 顶层化；tool 结果合并进相邻 user）。 */
function toAnthropicPayload(messages: ChatMessage[]): { system?: string; messages: AnthropicMessage[] } {
  let system = '';
  const out: AnthropicMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      system += (system ? '\n\n' : '') + (m.content ?? '');
    } else if (m.role === 'user') {
      out.push({ role: 'user', content: m.content ?? '' });
    } else if (m.role === 'assistant') {
      const blocks: AnthropicContentBlock[] = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const tc of m.tool_calls ?? []) {
        let input: unknown = {};
        try {
          input = JSON.parse(tc.function.arguments || '{}');
        } catch {
          input = {};
        }
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
      }
      out.push({ role: 'assistant', content: blocks.length > 0 ? blocks : [{ type: 'text', text: '' }] });
    } else {
      // tool 结果：与上一条（同为 tool 结果合并出的）user 数组消息并块，保持角色交替
      const block: AnthropicContentBlock = { type: 'tool_result', tool_use_id: m.tool_call_id ?? '', content: m.content ?? '' };
      const last = out[out.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content) && last.content[0]?.type === 'tool_result') {
        last.content.push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
    }
  }
  return { system: system || undefined, messages: out };
}

export function createAnthropicClient(options: ModelClientOptions): ModelClient {
  const base = endpointBase(options.baseUrl);

  async function* streamChat(
    messages: ChatMessage[],
    tools: ToolSchema[],
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent, void, unknown> {
    const payload = toAnthropicPayload(messages);
    const response = await fetch(`${base}/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': options.apiKey ?? '',
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: options.model,
        ...(payload.system ? { system: payload.system } : {}),
        messages: payload.messages,
        max_tokens: 8192,
        ...(tools.length > 0
          ? { tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) }
          : {}),
        stream: true,
      }),
      signal,
    });
    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '');
      throw new Error(`模型请求失败 HTTP ${response.status}：${detail.slice(0, 300)}`);
    }

    // tool_use 块按 index 累积（input_json_delta 分片拼接）
    const toolBlocks = new Map<number, { id: string; name: string; json: string }>();

    for await (const data of parseSSEStream(response.body, signal)) {
      let parsed: {
        type?: string;
        index?: number;
        content_block?: { type?: string; id?: string; name?: string };
        delta?: { type?: string; text?: string; partial_json?: string };
      };
      try {
        parsed = JSON.parse(data);
      } catch {
        continue; // ping/心跳等非 JSON 载荷跳过
      }
      if (parsed.type === 'content_block_start' && parsed.content_block?.type === 'tool_use') {
        toolBlocks.set(parsed.index ?? 0, {
          id: parsed.content_block.id ?? '',
          name: parsed.content_block.name ?? '',
          json: '',
        });
      } else if (parsed.type === 'content_block_delta' && parsed.delta) {
        if (parsed.delta.type === 'text_delta' && parsed.delta.text) {
          yield { type: 'delta', text: parsed.delta.text };
        } else if (parsed.delta.type === 'input_json_delta' && parsed.delta.partial_json) {
          const acc = toolBlocks.get(parsed.index ?? 0);
          if (acc) acc.json += parsed.delta.partial_json;
        }
      } else if (parsed.type === 'message_stop') {
        break;
      }
    }

    if (toolBlocks.size > 0) {
      const tool_calls: ToolCall[] = [...toolBlocks.entries()].map(([i, b]) => ({
        id: b.id || `toolu_${Date.now()}_${i}`,
        type: 'function',
        function: { name: b.name, arguments: b.json || '{}' },
      }));
      yield { type: 'tool_calls', tool_calls };
    }
  }

  return { providerId: options.providerId, model: options.model, streamChat };
}

/** M1-06：Anthropic 保存前验活——GET /v1/models 带 x-api-key，200 即通过。 */
export async function verifyAnthropicProvider(baseUrl: string, apiKey?: string): Promise<{ ok: boolean; detail: string }> {
  const base = endpointBase(baseUrl);
  try {
    const response = await fetch(`${base}/models`, {
      headers: { 'x-api-key': apiKey ?? '', 'anthropic-version': ANTHROPIC_VERSION },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) return { ok: true, detail: '验活通过（GET /v1/models 200）' };
    return { ok: false, detail: `HTTP ${response.status}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
