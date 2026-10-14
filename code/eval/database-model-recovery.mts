import assert from 'node:assert/strict';
import type { ModelClient } from '@workpivot/core';
import { streamWithRecovery } from '../packages/server/src/database/model-recovery.js';

export async function testModelRecovery(check: (v: unknown, label: string) => void) {
  const timeout = () => new TypeError('fetch failed private-provider-secret', { cause: { code: 'ETIMEDOUT' } });
  let calls = 0;
  const client: ModelClient = { providerId: 'fixture', model: 'fixture', async *streamChat() {
    if (++calls === 1) throw timeout();
    yield { type: 'delta', text: '已生成成果' };
  } };
  const output = [];
  for await (const event of streamWithRecovery(client, [[{ role: 'user', content: 'continue' }], []], 0)) output.push(event);
  check(calls === 2 && output.length === 1, 'unanswered connection timeout retries once without duplicate output');
  for (const type of ['delta', 'reasoning_delta', 'tool_calls'] as const) {
    calls = 0;
    const partial: ModelClient = { ...client, async *streamChat() {
      calls++;
      if (type === 'tool_calls') yield { type, tool_calls: [{ id: 'call-one', type: 'function', function: { name: 'execute_skill', arguments: '{}' } }] };
      else yield { type, text: 'partial' };
      throw timeout();
    } };
    await assert.rejects(async () => { for await (const _ of streamWithRecovery(partial, [[], []], 0)) { void _; } });
    check(calls === 1, `no retry after ${type} output`);
  }
  calls = 0;
  const broken: ModelClient = { ...client, async *streamChat() { calls++; if (calls > 0) throw timeout(); yield { type: 'delta', text: '' }; } };
  await assert.rejects(async () => { for await (const _ of streamWithRecovery(broken, [[], []], 0)) { void _; } });
  check(calls === 2, 'repeated timeout stops after the single retry budget');
  for (const status of [400, 401, 403, 429]) {
    calls = 0;
    const invalid: ModelClient = { ...client, async *streamChat() { calls++; if (calls > 0) throw Error(`HTTP ${status}`); yield { type: 'delta', text: '' }; } };
    await assert.rejects(async () => { for await (const _ of streamWithRecovery(invalid, [[], []], 0)) { void _; } });
    check(calls === 1, `HTTP ${status} is not retried automatically`);
  }
  calls = 0;
  const unavailable: ModelClient = { ...client, async *streamChat() { if (++calls === 1) throw Error('HTTP 503: private'); yield { type: 'delta', text: 'recovered' }; } };
  for await (const event of streamWithRecovery(unavailable, [[], []], 0)) assert.equal(event.type, 'delta');
  check(calls === 2, 'transient upstream 503 retries once');
  const alreadyStopped = new AbortController(); alreadyStopped.abort(); calls = 0;
  await assert.rejects(async () => { for await (const event of streamWithRecovery(client, [[], [], alreadyStopped.signal], 0)) void event; });
  check(calls === 0, 'already cancelled request never reaches the provider');
  const controller = new AbortController(); calls = 0;
  const cancelled: ModelClient = { ...client, async *streamChat() { calls++; controller.abort(); if (calls > 0) throw timeout(); yield { type: 'delta', text: '' }; } };
  await assert.rejects(async () => { for await (const _ of streamWithRecovery(cancelled, [[], [], controller.signal], 0)) { void _; } });
  check(calls === 1, 'cancellation prevents retry');
  for (const status of [400, 401, 403, 429, 500]) {
    calls = 0;
    const failure = new Error(`HTTP ${status}`, { cause: { code: 'ETIMEDOUT' } });
    const rejected: ModelClient = { ...client, async *streamChat() {
      calls++;
      if (calls > 0) throw failure;
      yield { type: 'delta', text: '' };
    } };
    await assert.rejects(async () => {
      for await (const event of streamWithRecovery(rejected, [[], []], 0)) void event;
    }, (error) => error === failure);
    check(calls === 1, `HTTP ${status} overrides nested transport timeout`);
  }
  calls = 0;
  const abort = new Error('provider cancelled', { cause: { code: 'ETIMEDOUT' } });
  abort.name = 'AbortError';
  const aborted: ModelClient = { ...client, async *streamChat() {
    calls++;
    if (calls > 0) throw abort;
    yield { type: 'delta', text: '' };
  } };
  await assert.rejects(async () => {
    for await (const event of streamWithRecovery(aborted, [[], []], 0)) void event;
  }, (error) => error === abort);
  check(calls === 1, 'provider abort never retries even without caller cancellation');
}
