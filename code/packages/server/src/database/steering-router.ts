import type { ChatMessage, ModelClient, StreamEvent } from '@workpivot/core';

export type SteeringRelation = 'related' | 'unrelated';

export interface SteeringClassification {
  relation: SteeringRelation;
  reason: string;
}

function fallback(content: string): SteeringClassification {
  if (/(另做|另一个|新任务|单独任务|完成后|接下来再|顺便|另外)/.test(content)) {
    return { relation: 'unrelated', reason: '模型分类不可用，按明确的后续任务表达进入队列' };
  }
  return { relation: 'related', reason: '模型分类不可用，默认优先作为当前任务纠正，避免遗漏即时约束' };
}

function recentContext(messages: readonly ChatMessage[]): string {
  return messages
    .filter(message => message.role === 'user' || message.role === 'assistant' || message.role === 'tool')
    .slice(-12)
    .map(message => {
      const calls = message.tool_calls?.map(call => call.function.name).join(',') ?? '';
      return `[${message.role}${calls ? `:${calls}` : ''}] ${(message.content ?? '').slice(0, 900)}`;
    })
    .join('\n')
    .slice(-9000);
}

/**
 * 轻量关系路由：判断运行中消息应修改当前任务，还是排到当前任务之后。
 * 分类失败不会阻断任务；明确“另外/新任务”进入后续队列，其余默认视为当前纠正。
 */
export async function classifySteering(
  client: ModelClient,
  messages: readonly ChatMessage[],
  content: string,
  signal?: AbortSignal,
): Promise<SteeringClassification> {
  let output = '';
  try {
    const classifierMessages: ChatMessage[] = [
      {
        role: 'system',
        content:
          '你是任务关系分类器，只输出一行JSON。判断“新消息”是否会改变当前任务的已在执行目标、数据范围、业务规则、步骤、成果或验收方式。' +
          '如果是在当前目标内纠正、补充、增加分析维度或要求重做，归为 related。' +
          '如果是另一个独立交付、与当前成果无关，或用户明确说“完成后再做/另外/新任务”，归为 unrelated。' +
          '不确定时优先 related，避免当前任务继续使用过时要求。格式：{"relation":"related|unrelated","reason":"不超过80字"}',
      },
      { role: 'user', content: `当前对话与执行上下文：\n${recentContext(messages)}\n\n新消息：${content.slice(0, 4000)}` },
    ];
    for await (const event of client.streamChat(classifierMessages, [], signal ?? AbortSignal.timeout(15000))) {
      if ((event as StreamEvent).type === 'delta') output += (event as { text: string }).text;
      if (output.length > 2000) break;
    }
    const match = /\{[^{}]*\}/.exec(output);
    if (!match) return fallback(content);
    const parsed = JSON.parse(match[0]) as { relation?: unknown; reason?: unknown };
    if (parsed.relation !== 'related' && parsed.relation !== 'unrelated') return fallback(content);
    return {
      relation: parsed.relation,
      reason: typeof parsed.reason === 'string' && parsed.reason.trim() ? parsed.reason.trim().slice(0, 1000) : parsed.relation === 'related' ? '与当前目标相关' : '属于后续独立请求',
    };
  } catch {
    return fallback(content);
  }
}
