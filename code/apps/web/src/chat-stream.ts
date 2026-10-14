import type { ChatEvent } from './api';

export async function readChatStream<T extends { type: string } = ChatEvent>(body: ReadableStream<Uint8Array>, onEvent: (event: T) => void, signal?: AbortSignal, idleMs = 45000): Promise<void> {
  const reader = body.getReader(), decoder = new TextDecoder();
  let buffer = '';
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      signal?.throwIfAborted();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const chunk = await Promise.race([reader.read(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('连接长时间无响应，任务状态待确认，请恢复连接后查看任务。')), idleMs); })]).finally(() => clearTimeout(timer));
      signal?.throwIfAborted();
      if (chunk.done) throw new Error('连接提前中断，未收到任务结束确认。请查看任务状态后再决定是否继续，系统不会自动重发。');
      buffer += decoder.decode(chunk.value, { stream: true });
      if (buffer.length > 1024 * 1024) throw new Error('服务器响应超过大小限制');
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).trimEnd(); buffer = buffer.slice(end + 1);
        if (!line.startsWith('data:')) continue;
        const event = JSON.parse(line.slice(5).trim()) as T;
        if (!event || typeof event.type !== 'string') throw new Error('服务器响应格式无效');
        onEvent(event);
        if (event.type === 'done' || event.type === 'error') return;
      }
    }
  } finally { signal?.removeEventListener('abort', abort); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
