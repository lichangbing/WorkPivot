import { useEffect, useRef, useState } from 'react';
import type { MobileClient } from './client';

export function ComposerSettings({ client, disabled, onError }: { client: MobileClient; disabled: boolean; onError: (error: unknown) => void }) {
  const [mode, setMode] = useState<{ value: string; revision: number }>();
  const [model, setModel] = useState<{ available: boolean; name?: string; modelId?: string }>();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const life = useRef(new AbortController());
  const generation = useRef(0);
  useEffect(() => {
    const c = new AbortController(); life.current = c;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      const current = generation.current;
      const results = await Promise.allSettled([
        client.json<{ setting: { value: string; revision: number } | null }>('/api/preferences/execution.mode', { signal: c.signal }),
        client.json<{ available: boolean; name?: string; modelId?: string }>('/api/model-status', { signal: c.signal }),
      ]);
      if (c.signal.aborted) return;
      if (results[0].status === 'fulfilled' && current === generation.current) setMode(results[0].value.setting ?? { value: 'manual', revision: 0 });
      if (results[1].status === 'fulfilled') setModel(results[1].value);
      if (results.every(result => result.status === 'fulfilled')) setError('');
      for (const result of results) if (result.status === 'rejected') { setError(result.reason instanceof Error ? result.reason.message : '配置读取失败'); onError(result.reason); }
      timer = setTimeout(() => void load(), 10000);
    };
    void load(); return () => { c.abort(); clearTimeout(timer); };
  }, [client]);
  const change = async (value: string) => {
    if (!mode || busy) return;
    ++generation.current;
    setBusy(true); setError('');
    try {
      const result = await client.json<{ revision: number }>('/api/preferences/execution.mode', { method: 'PUT', body: JSON.stringify({ value, revision: mode.revision }), signal: life.current.signal });
      setMode({ value, revision: result.revision });
    } catch (reason) { if (!life.current.signal.aborted) { setError(reason instanceof Error ? reason.message : '模式修改失败'); onError(reason); } }
    finally { ++generation.current; setBusy(false); }
  };
  return <div className="composer-settings">
    <select aria-label="执行模式" title="确认模式：执行前需要你确认；自动模式：仅外部调用、取消定时任务等危险操作需要确认" value={mode?.value ?? 'manual'} disabled={!mode || busy || disabled} onChange={event => void change(event.target.value)}>
      <option value="manual">确认模式</option><option value="auto">自动模式</option>
    </select>
    <small title={model?.modelId}>{model ? model.available ? model.name ?? model.modelId : '请管理员配置模型' : '读取模型…'}</small>
    {error && <span role="alert" className="error">{error}</span>}
  </div>;
}
