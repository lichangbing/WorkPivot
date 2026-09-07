/**
 * M1-06：SSE 行解析器（协议客户端共用）。
 * 只抽取 `data:` 载荷行；`event:` 名行与非 JSON 心跳由调用方自行判别/跳过。
 * 空闲超时：单次 read 等待超过 idleTimeoutMs 视为流停滞（模型端挂起），抛错中止——
 * 否则一次网络停滞会让任务永久卡在 running（maxDuration 无法打断永不返回的 await）。
 */
const DEFAULT_IDLE_TIMEOUT_MS = 180_000;

export async function* parseSSEStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  idleTimeoutMs: number = DEFAULT_IDLE_TIMEOUT_MS,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    if (signal?.aborted) throw new Error('aborted');
    if (idleTimeoutMs > 0) {
      let timerHandle: ReturnType<typeof setTimeout> | undefined;
      const timer = new Promise<never>((_, reject) => {
        timerHandle = setTimeout(() => reject(new Error(`模型流空闲超时（${Math.round(idleTimeoutMs / 1000)}s 无输出，已中止）`)), idleTimeoutMs);
      });
      const chunk = await Promise.race([reader.read(), timer]);
      clearTimeout(timerHandle); // 读先返回时必须撤销计时器，否则 late rejection 会变成 unhandledRejection
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
    } else {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
    }
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trimEnd();
      buffer = buffer.slice(idx + 1);
      if (line.startsWith('data:')) yield line.slice(5).trim();
    }
  }
}
