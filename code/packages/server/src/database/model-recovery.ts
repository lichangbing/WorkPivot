import { setTimeout as delay } from 'node:timers/promises';
import type { ModelClient, StreamEvent } from '@workpivot/core';
import { modelFailureDetails } from './model-error.js';

export function retryableModelError(error: unknown): boolean {
  const details = modelFailureDetails(error);
  return ['502', '503', '504'].includes(details.status ?? '') || details.code !== undefined;
}

/** Retry one unanswered model request, never a tool or a partially delivered stream. */
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
