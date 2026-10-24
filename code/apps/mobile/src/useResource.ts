import { useCallback, useEffect, useRef, useState } from 'react';
import type { MobileClient } from './client';

/** 统一取消离页请求，防止旧轮询覆盖操作后的刷新结果。 */
export function useResource<T>(client: MobileClient, path: string, onError: (error: unknown) => void, interval = 0) {
  const [value, setValue] = useState<T>(), [error, setError] = useState('');
  const controller = useRef(new AbortController()), serial = useRef(0), handler = useRef(onError);
  handler.current = onError;
  const refresh = useCallback(async () => {
    const current = ++serial.current, signal = controller.current.signal;
    try {
      const result = await client.json<T>(path, { signal });
      if (!signal.aborted && current === serial.current) { setValue(result); setError(''); }
    } catch (reason) {
      if (!signal.aborted && current === serial.current) { setError(reason instanceof Error ? reason.message : '读取失败'); handler.current(reason); }
    }
  }, [client, path]);
  useEffect(() => {
    const c = new AbortController(); controller.current = c; setValue(undefined); setError('');
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => { await refresh(); if (!c.signal.aborted && interval) timer = setTimeout(() => void poll(), interval); };
    void poll(); return () => { c.abort(); ++serial.current; clearTimeout(timer); };
  }, [refresh, interval]);
  return { value, error, refresh, signal: () => controller.current.signal };
}
