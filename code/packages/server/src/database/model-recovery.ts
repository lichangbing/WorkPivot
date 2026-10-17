import { setTimeout as delay } from 'node:timers/promises';
import type { ModelClient, StreamEvent } from '@workpivot/core';
import { modelFailureDetails } from './model-error.js';

export function retryableModelError(error: unknown): boolean {
  const details = modelFailureDetails(error);
  if (details.name === 'AbortError') return false;
  // 明确的 HTTP 响应优先于嵌套的传输错误。
  if (details.status !== undefined) return ['502', '503', '504'].includes(details.status);
  return details.code !== undefined;
}

/** 只重试一次尚无输出的模型请求，不重试工具或已输出部分内容的流。 */
export async function* streamWithRecovery(client: ModelClient, args: Parameters<ModelClient['streamChat']>, delayMs = 500): AsyncGenerator<StreamEvent> {
  const signal = args[2];
  for (let attempt = 0; attempt < 2; attempt++) {
    signal?.throwIfAborted();
    let emitted = false;
    try {
      for await (const event of client.streamChat(...args)) {
        emitted = true;
        yield event;
      }
      return;
    } catch (error) {
      if (attempt === 1 || emitted || signal?.aborted || !retryableModelError(error)) throw error;
      await delay(delayMs, undefined, { signal });
    }
  }
}
