import assert from 'node:assert/strict';
import { readChatStream, StreamIdleError, StreamInterruptedError } from '../packages/shared/src/chat-stream.js';
import {
  NetworkError,
  isAuthenticationError,
  isRoutineStreamRotation,
  isTransientConnectionError,
  reconnectDelay,
} from '../apps/mobile/src/connection.js';
import { requestIdFor } from '../apps/mobile/src/send-request.js';

let passed = 0;
const check = (name: string, run: () => Promise<void> | void) => Promise.resolve(run()).then(() => {
  passed += 1;
  console.log(`✅ ${name}`);
});
const emptyStream = () => new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });

await check('网络故障进入可恢复状态', () => {
  assert.equal(isTransientConnectionError(new NetworkError()), true);
  assert.equal(isTransientConnectionError(new Error('network error')), true);
  assert.equal(isTransientConnectionError({ status: 503 }), true);
  assert.equal(isTransientConnectionError({ status: 409 }), false);
});
await check('401 不进入网络重试', () => {
  assert.equal(isAuthenticationError({ status: 401 }), true);
  assert.equal(isTransientConnectionError({ status: 401 }), false);
});
await check('SSE 正常 EOF 使用可识别错误而非任务失败', async () => {
  await assert.rejects(() => readChatStream(emptyStream(), () => undefined), (error: unknown) => error instanceof StreamInterruptedError);
});
await check('SSE 空闲错误保留待确认语义', async () => {
  await assert.rejects(
    () => readChatStream(new ReadableStream<Uint8Array>({ cancel() {} }), () => undefined, undefined, 10),
    (error: unknown) => error instanceof StreamIdleError && /任务状态待确认/.test(error.message),
  );
});
await check('稳定运行后的换流不显示网络中断', () => {
  assert.equal(isRoutineStreamRotation(new StreamInterruptedError(), 1_000, 301_000), true);
  assert.equal(isRoutineStreamRotation(new StreamInterruptedError(), 299_000, 301_000), false);
  assert.equal(isRoutineStreamRotation(new StreamIdleError(), 1_000, 301_000), false);
});
await check('重连采用有上限的指数退避和抖动', () => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const low = reconnectDelay(attempt, () => 0);
    const high = reconnectDelay(attempt, () => 1);
    assert(low >= 800 && high <= 12_000 && low < high);
  }
  assert.equal(reconnectDelay(20, () => 0), 8_000);
});
await check('同一待确认消息在断线后复用请求标识', () => {
  const first = requestIdFor(null, 'same-message', () => 'request-1');
  assert.equal(requestIdFor(first, 'same-message', () => 'request-2').id, 'request-1');
  assert.equal(requestIdFor(first, 'changed-message', () => 'request-2').id, 'request-2');
});

console.log(`Mobile reconnect: ${passed}/${passed}`);
