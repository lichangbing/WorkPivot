/**
 * 上下文压缩：长任务里工具结果只增不减，会撑爆窗口并让模型逐渐遗忘目标。
 *
 * 策略保守——只替换 content，不删除消息，保证 assistant(tool_calls) 与 tool(tool_call_id)
 * 的配对结构不被破坏（部分供应商对配对缺失直接报错）。
 * 先压缩较早的工具结果；仍超预算时才截断较早的 assistant 文本；system 与最后若干条不动。
 */
import type { ChatMessage } from './model/openai.js';

/** 粗略字符预算：中英混排按 1 字符≈0.6 token 估，宁小勿大。 */
export const CONTEXT_CHAR_BUDGET = 120_000;
/** 保留最近的消息条数，压缩不动这一段。 */
const KEEP_RECENT = 10;
/** 单条工具结果低于该长度时不值得压缩。 */
const MIN_TOOL_CHARS = 600;
/** 借鉴 DeepSeek Harness 的分级修剪：超过 8192 先保留头 4096 + 尾 1024，仍超预算才整体省略。 */
export const TOOL_RESULT_LIMIT = 8192;
export const TOOL_RESULT_HEAD = 4096;
export const TOOL_RESULT_TAIL = 1024;
/** 截断 assistant 文本时保留的长度。 */
const ASSISTANT_KEEP = 500;

/** 头尾保留的裁剪；短结果原样返回。 */
export function pruneToolResult(content: string): string {
  if (content.length <= TOOL_RESULT_LIMIT) return content;
  const omitted = content.length - TOOL_RESULT_HEAD - TOOL_RESULT_TAIL;
  return `${content.slice(0, TOOL_RESULT_HEAD)}\n…[已裁剪 ${omitted} 字符，原始 ${content.length} 字符；需要时可重新读取]\n${content.slice(-TOOL_RESULT_TAIL)}`;
}

export function contextChars(messages: ChatMessage[]): number {
  let total = 0;
  for (const message of messages) total += (message.content ?? '').length;
  return total;
}

/**
 * 就地压缩，返回是否发生了改动。
 * @param budget 触发阈值（字符数）；≤0 表示不压缩
 */
export function compactMessages(messages: ChatMessage[], budget: number = CONTEXT_CHAR_BUDGET): boolean {
  if (budget <= 0 || messages.length <= KEEP_RECENT + 1) return false;
  if (contextChars(messages) <= budget) return false;
  const lastIndex = messages.length - KEEP_RECENT;
  let changed = false;
  // 第一遍：分级修剪较早的工具结果（头 4096 + 尾 1024），尽量保住关键信息。
  for (let index = 1; index < lastIndex; index += 1) {
    const message = messages[index]!;
    if (message.role !== 'tool' || typeof message.content !== 'string') continue;
    if (message.content.length < MIN_TOOL_CHARS) continue;
    const pruned = pruneToolResult(message.content);
    if (pruned === message.content) continue;
    messages[index] = { ...message, content: pruned };
    changed = true;
    if (contextChars(messages) <= budget) return changed;
  }
  // 第二遍：仍超预算时，较早的工具结果整体省略（保留占位说明）。
  for (let index = 1; index < lastIndex; index += 1) {
    const message = messages[index]!;
    if (message.role !== 'tool' || typeof message.content !== 'string') continue;
    if (message.content.length < MIN_TOOL_CHARS) continue;
    messages[index] = { ...message, content: `[已压缩] 早期工具结果 ${message.content.length} 字符，内容已省略；如需原文请重新读取文件。` };
    changed = true;
    if (contextChars(messages) <= budget) return changed;
  }
  // 第二遍：截断较早的 assistant 文本
  for (let index = 1; index < lastIndex; index += 1) {
    const message = messages[index]!;
    if (message.role !== 'assistant' || typeof message.content !== 'string') continue;
    if (message.content.length <= ASSISTANT_KEEP) continue;
    messages[index] = { ...message, content: `${message.content.slice(0, ASSISTANT_KEEP)}…[已截断]` };
    changed = true;
    if (contextChars(messages) <= budget) return changed;
  }
  return changed;
}
