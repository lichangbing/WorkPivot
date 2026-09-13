export interface ContentItem {
  attachments?: string[];
  kind: 'user' | 'assistant' | 'tool' | 'error' | 'permission' | 'gate' | 'memory' | 'thought';
  text: string;
  toolName?: string;
  toolInput?: string;
  toolOutput?: string;
  toolState?: 'waiting' | 'running' | 'ok' | 'error' | 'denied' | 'stopped';
  toolDisplayName?: string;
  callId?: string;
  durationMs?: number;
}

/** Keep response text separate from reasoning and tools, including interleaved streams. */
export function appendContent<T extends ContentItem>(items: T[], kind: 'assistant' | 'thought', text: string): Array<T | ContentItem> {
  if (!text) return items;
  const last = items.at(-1);
  return last?.kind === kind
    ? [...items.slice(0, -1), { ...last, text: last.text + text }]
    : [...items, { kind, text }];
}

export function toolSummary(name: string, args: unknown): string {
  if (!args || typeof args !== 'object') return name;
  const data = args as Record<string, unknown>;
  const detail = data['path'] ?? data['pattern'] ?? data['command'] ?? data['name'];
  return typeof detail === 'string' ? detail.split('\n')[0]!.slice(0, 180) : name;
}
