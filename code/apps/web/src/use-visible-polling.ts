import { useEffect, useRef } from 'react';

type Poll = (signal: AbortSignal) => void | Promise<void>;

/**
 * 按固定间隔刷新数据，但标签页隐藏时停止定时器。
 * 恢复可见后立即补拉一次；上一次请求未结束时不会重叠发起下一次。
 */
export function useVisiblePolling(poll: Poll, intervalMs: number, resetKey?: string | null): void {
  const latest = useRef(poll);
  latest.current = poll;

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    let immediate = false;
    let stopped = false;
    const visible = () => !stopped && document.visibilityState === 'visible';
    const schedule = (delay: number) => {
      clearTimeout(timer);
      if (visible()) timer = setTimeout(() => { void run(); }, delay);
    };
    const run = async () => {
      if (!visible() || running) return;
      running = true;
      try {
        await latest.current(controller.signal);
      } catch {
        // 各调用点负责展示错误；轮询失败后继续等待下一次可见刷新。
      } finally {
        running = false;
        schedule(immediate ? 0 : Math.max(100, intervalMs));
        immediate = false;
      }
    };
    const visibilityChanged = () => {
      if (document.visibilityState === 'hidden') {
        clearTimeout(timer);
        return;
      }
      if (running) immediate = true;
      else schedule(0);
    };

    document.addEventListener('visibilitychange', visibilityChanged);
    schedule(0);
    return () => {
      stopped = true;
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', visibilityChanged);
    };
  }, [intervalMs, resetKey]);
}
