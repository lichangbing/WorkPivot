import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';

type Grant = Awaited<ReturnType<typeof api.listPathGrants>>['grants'][number];

export function PermissionsPanel(): React.JSX.Element {
  const [grants, setGrants] = useState<Grant[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [users, setUsers] = useState<Record<string, string>>({});
  const [tasks, setTasks] = useState<Record<string, string>>({});
  const reload = useCallback(async () => {
    try {
      const [permissions, people, jobs] = await Promise.all([api.listPathGrants(), api.listUsers(), api.listTasks()]);
      setGrants(permissions.grants);
      setUsers(Object.fromEntries(people.users.map((u) => [u.id, u.username])));
      setTasks(Object.fromEntries(jobs.tasks.map((t) => [t.id, t.name])));
      setError('');
    }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  return <section className="space-y-4">
    <div className="flex items-center justify-between"><h2 className="text-lg font-semibold">永久路径授权</h2><button onClick={() => void reload()} className="rounded bg-neutral-800 px-3 py-2 text-sm">刷新</button></div>
    <p className="text-sm text-neutral-400">授权仅对指定用户和任务生效，读取与写入分别确认。撤销后，后续访问需要重新确认。旧版全局白名单已失效，需要重新授权。</p>
    {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
    {grants.length === 0 && !error && <p className="text-sm text-neutral-500">暂无永久授权。</p>}
    {grants.map((g) => <div key={g.id} className="rounded border border-neutral-800 p-4">
      <div className="flex items-start justify-between gap-4"><div className="min-w-0 space-y-1">
        <p className="break-all text-sm">{g.path}</p>
        <p className="text-xs text-neutral-400">{g.mode === 'read' ? '读取' : '写入'} · {g.subtree ? '包含子目录' : '仅此路径'}</p>
        <p className="break-all text-xs text-neutral-500">用户：{users[g.userId] ?? '已删除用户'} · 任务：{tasks[g.taskId] ?? '已删除任务'}</p>
        <p className="text-xs text-neutral-500">授权时间：{new Date(g.createdAt).toLocaleString()}</p>
      </div><button disabled={busy !== null} className="shrink-0 rounded bg-red-950 px-3 py-1.5 text-sm text-red-300 disabled:opacity-50" onClick={() => {
        setBusy(g.id);
        void api.revokePathGrant(g.id).then(reload).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err))).finally(() => setBusy(null));
      }}>{busy === g.id ? '撤销中…' : '撤销'}</button></div>
    </div>)}
  </section>;
}
