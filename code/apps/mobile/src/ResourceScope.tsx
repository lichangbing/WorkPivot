import { useEffect, useState } from 'react';
import type { MobileClient } from './client';
export interface ResourceSelection {
  scheduleIds?: string[]; versionIds: string[]; memoryScopes: ('user' | 'project' | 'task')[];
  expert: boolean; baseRunId?: string | null;
}
interface Snapshot { scope: ResourceSelection; files: { id: string; name: string }[] }
export function ResourceScope({ client, taskId, refresh, disabled, onChange, onError }: {
  client: MobileClient; taskId: string; refresh: number; disabled: boolean;
  onChange: (value: ResourceSelection | null) => void; onError: (error: unknown) => void;
}) {
  const [data, setData] = useState<Snapshot>(), [scope, setScope] = useState<ResourceSelection>();
  const [error, setError] = useState(''), [retry, setRetry] = useState(0);
  useEffect(() => {
    const c = new AbortController(); onChange(null); setError('');
    void client.json<Snapshot>(`/api/tasks/${taskId}/resource-scope`, { signal: c.signal }).then(result => {
      if (c.signal.aborted) return;
      setData(result); setScope(result.scope); onChange(result.scope);
    }).catch(reason => { if (!c.signal.aborted) { setError(reason instanceof Error ? reason.message : '资料范围读取失败'); onError(reason); } });
    return () => c.abort();
  }, [client, taskId, refresh, retry, onChange]);
  const update = (value: ResourceSelection) => { setScope(value); onChange(value); };
  return <details className="resource-scope"><summary>本轮资料{scope ? ` · ${scope.memoryScopes.length} 层记忆 / ${scope.versionIds.length} 个文件` : ''}</summary>
    <p className="muted">仅使用所选资料；勾选记忆也允许后台提出该层的整理建议，仍需确认后保存。本次添加的附件自动包含。</p>
    <button type="button" disabled={disabled} onClick={() => setRetry(value => value + 1)}>读取后台最新范围</button>
    {error ? <p className="error" role="alert">{error}<button type="button" onClick={() => setRetry(value => value + 1)}>重新读取</button></p> : scope && <>
      {(['user', 'project', 'task'] as const).map(value => <label key={value}><input type="checkbox" disabled={disabled} checked={scope.memoryScopes.includes(value)} onChange={event => update({ ...scope, memoryScopes: event.target.checked ? [...scope.memoryScopes, value].sort() : scope.memoryScopes.filter(item => item !== value) })} />{({ user: '个人记忆', project: '项目记忆', task: '任务记忆' })[value]}</label>)}
      <label><input type="checkbox" disabled={disabled} checked={scope.expert} onChange={event => update({ ...scope, expert: event.target.checked })} />当前专家与经验</label>
      {data?.files.map(file => <label key={file.id}><input type="checkbox" disabled={disabled} checked={scope.versionIds.includes(file.id)} onChange={event => update({ ...scope, versionIds: event.target.checked ? [...scope.versionIds, file.id].sort() : scope.versionIds.filter(id => id !== file.id) })} />{file.name}</label>)}
    </>}
  </details>;
}
