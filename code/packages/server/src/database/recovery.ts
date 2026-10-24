/**
 * R006 事件溯源会话与中断恢复：恢复期的纯逻辑。
 *
 * 只做两件事，且都不执行工具：
 * 1. 对账：assistant 带 tool_calls 却缺少对应 tool 消息时，为每个缺失调用补一条"结果未知"的合成结果，
 *    让历史重新合法（模型协议要求每个 tool_call 都有响应）；
 * 2. 预算：续跑时继承剩余步数，不重置。
 *
 * 设计约束：at-most-once——已经派发的调用只补结果、绝不重放。
 */
import type { ChatMessage } from '@workpivot/core';

/** 合成结果：明确告诉模型"结果未知，需要就重新调用"，不假装成功也不假装失败。 */
export const INTERRUPTED_TOOL_RESULT = JSON.stringify({ error: '上一轮执行中断，结果未知；如仍需该操作请重新调用' });

export interface RepairRecord {
  callId: string;
  tool: string;
}

export interface ReconcileResult {
  messages: ChatMessage[];
  repaired: RepairRecord[];
}

/** 未闭合的 tool_call 按顺序补合成结果；已闭合的调用保持原样（幂等）。 */
export function reconcileMessages(messages: readonly ChatMessage[]): ReconcileResult {
  const repaired: RepairRecord[] = [];
  const result: ChatMessage[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role === 'assistant' && message.tool_calls?.length) {
      result.push(message);
      // 先把紧随其后的已回填结果按原顺序放回，再为缺失的调用补合成结果。
      const answered = new Set<string>();
      let cursor = index + 1;
      while (cursor < messages.length && messages[cursor]!.role === 'tool') {
        const toolMessage = messages[cursor]!;
        result.push(toolMessage);
        if (toolMessage.tool_call_id) answered.add(toolMessage.tool_call_id);
        cursor += 1;
      }
      for (const call of message.tool_calls) {
        if (answered.has(call.id)) continue;
        result.push({ role: 'tool', tool_call_id: call.id, content: INTERRUPTED_TOOL_RESULT });
        repaired.push({ callId: call.id, tool: call.function.name });
      }
      index = cursor - 1;
      continue;
    }
    result.push(message);
  }
  return { messages: result, repaired };
}

/** 续跑预算：step_limit 为 0 表示不限制；否则只给剩余步数，避免崩溃后重复消耗。 */
export function remainingSteps(stepLimit: number, usedSteps: number): number | undefined {
  if (!Number.isInteger(stepLimit) || stepLimit <= 0) return undefined;
  return Math.max(1, stepLimit - Math.max(0, usedSteps));
}

/** 模型是否在上下文中还有未完成的计划（用于前端提示"可继续"）。 */
export function lastAssistantHasOpenCalls(messages: readonly ChatMessage[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === 'tool') continue;
    return message.role === 'assistant' && !!message.tool_calls?.length;
  }
  return false;
}
