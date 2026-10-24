import type { ChatEvent } from './api';
import { readChatStream as readStream } from '@workpivot/shared';

/** 保留桌面调用方的默认事件类型，共用不依赖界面的流解析器。 */
export function readChatStream<T extends { type: string } = ChatEvent>(body: ReadableStream<Uint8Array>, onEvent: (event: T) => void, signal?: AbortSignal, idleMs = 45000): Promise<void> {
  return readStream(body, onEvent, signal, idleMs);
}
