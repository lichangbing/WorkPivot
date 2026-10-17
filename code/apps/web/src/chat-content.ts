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

/** 将回复正文与思考、工具内容分离，兼容交错输出的流。 */
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

export function retrievalStatus(content:string):string|null {
 try{const event=JSON.parse(content);if(event.toolName!=='search_project_documents'||event.ok!==true||typeof event.message!=='string')return null;const mode=event.message.match(/^\{"mode":"(hybrid|keyword)"/);return mode?.[1]==='hybrid'?'已使用关键词＋语义混合检索':mode?.[1]==='keyword'?'当前使用关键词检索：向量服务未启用、未就绪或暂时不可用':null;}catch{return null;}
}
