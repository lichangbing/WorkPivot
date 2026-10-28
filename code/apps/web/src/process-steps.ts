import type { StoredEvent } from './database-chat-state';

export interface ProcessStep {
  id: string;
  events: StoredEvent[];
}

/** 新思考开始，或上一步工具完成后出现新工具调用，即进入下一步骤。 */
export function groupProcessSteps(events: StoredEvent[]): ProcessStep[] {
  const steps: ProcessStep[] = [];
  let current: ProcessStep | undefined;
  for (const event of events) {
    const currentHasResult = current?.events.some(item => item.kind === 'tool_result') ?? false;
    const startsNext = current && currentHasResult && (event.kind === 'thinking' || event.kind === 'tool_use');
    if (!current || startsNext) {
      current = { id: event.id, events: [] };
      steps.push(current);
    }
    current.events.push(event);
  }
  return steps;
}

export function processToolMeta(event: StoredEvent): { name: string; displayName: string; status: string; durationMs?: number } {
  try {
    const value = JSON.parse(event.content) as Record<string, unknown>;
    const name = typeof value['toolName'] === 'string' ? value['toolName'] : '工具';
    return {
      name,
      displayName: typeof value['displayName'] === 'string' ? value['displayName'] : name,
      status: typeof value['status'] === 'string' ? value['status'] : event.kind === 'tool_result' ? (value['ok'] === true ? 'ok' : 'error') : 'running',
      durationMs: typeof value['durationMs'] === 'number' ? value['durationMs'] : undefined,
    };
  } catch {
    return { name: '工具', displayName: '工具', status: event.kind === 'tool_result' ? 'done' : 'running' };
  }
}

/** 工具事件只展示可读摘要；没有摘要时显示执行状态，不把内部 JSON 原样甩给用户。 */
export function processToolText(event: StoredEvent): string {
  try {
    const value = JSON.parse(event.content) as Record<string, unknown>;
    if (typeof value['message'] === 'string' && value['message'].trim()) return value['message'];
    if (typeof value['output'] === 'string' && value['output'].trim()) return value['output'];
    const args = value['args'];
    if (args && typeof args === 'object' && !Array.isArray(args)) {
      const code = (args as Record<string, unknown>)['code'];
      const language = (args as Record<string, unknown>)['language'];
      if (typeof code === 'string' && code.trim()) return `${typeof language === 'string' ? language + '\n' : ''}${code}`;
    }
  } catch {
    // 历史纯文本事件继续按原文展示。
  }
  return event.kind === 'tool_use' ? (processToolMeta(event).status === 'running' ? '正在执行…' : '已提交执行') : '工具执行完成';
}
