import { useEffect, useState } from 'react';
import { api, getToken, type PlanStep, type Task } from './api';
import { Icon } from './Icon';
import { MemoryCenter } from './MemoryCenter';
import { ArtifactBrowser } from './ArtifactBrowser';
import type { MemoryLayer } from './memory-api';

export interface SidebarData {
  tasks: Array<Task & { steps: PlanStep[] }>;
  artifacts: Array<{ name: string; size: number; updatedAt: number; state?: 'generating' | 'ready' | 'failed'; versions?: Array<{ id: string; createdAt: number; size: number; status: 'ready' | 'failed' }> }>;
  skills: Array<{ name: string; description: string; source: string }>;
  mcp: Array<{ name: string; enabled?: boolean; status?: string; toolCount?: number; tools?: Array<{ name: string; description: string; enabled: boolean }> }>;
}
export function TaskSidebar({ taskId, steps, onSelect, onTranscript, onTasks, onRetry }: {
  taskId?: string; steps: PlanStep[]; onSelect: (task: Task) => void; onTranscript: () => void; onTasks: (tasks: Task[]) => void; onRetry: (task: Task) => void;
}): React.JSX.Element {
  const [data, setData] = useState<SidebarData | null>(null);
  const [error, setError] = useState('');
  const [opening, setOpening] = useState('');
  const [message, setMessage] = useState('');
  const [memoryLayer, setMemoryLayer] = useState<MemoryLayer | null>(null);
  const [browseFiles, setBrowseFiles] = useState(false);
  useEffect(() => {
    let canceled = false;
    let timer: ReturnType<typeof setTimeout>;
    setData(null); setMessage('');
    const refresh = async (): Promise<void> => {
      try { const result = await api.getSidebar(taskId); if (!canceled) { setData(result); onTasks(result.tasks); setError(''); } }
      catch { if (!canceled) setError('暂时无法刷新任务信息'); }
      if (!canceled) timer = setTimeout(() => { void refresh(); }, 2500);
    };
    void refresh();
    return () => { canceled = true; clearTimeout(timer); };
  }, [taskId]);
  const open = async (name: string): Promise<void> => {
    if (!taskId || opening) return;
    setOpening(name); setMessage('');
    try {
      const version = data?.artifacts.find(f => f.name === name)?.versions?.at(-1)?.id;
      if (window.workpivotDesktop?.openArtifact) {
        await window.workpivotDesktop.openArtifact(taskId, name, getToken() ?? '', version);
      } else {
        await api.downloadArtifact(taskId, name, version);
        setMessage('文件已下载。桌面客户端可直接用本地软件打开。');
      }
    } catch (err) { setMessage(err instanceof Error ? err.message : '打开产物失败'); }
    finally { setOpening(''); }
  };
  return <div className="flex-1 space-y-5 overflow-y-auto p-4 text-xs">
    {error && <p role="alert" className="text-red-400">{error}</p>}
    <section aria-label="任务监控" className="flex h-52 flex-col">
      <div className="mb-3 flex shrink-0 items-center justify-between"><h2 className="font-medium text-neutral-100">任务监控</h2>
        {taskId && <button title="查看当前任务转写" className="text-neutral-500 hover:text-neutral-100" onClick={onTranscript}><Icon name="file" /></button>}
      </div>
      {!data?.tasks.length && <p className="text-neutral-500">暂无任务</p>}
      <ul className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain">
        {data?.tasks.map((task) => {
          const selected = task.id === taskId;
          const plan = selected && task.status === 'running' && steps.length ? steps : task.steps;
          const completed = task.status === 'idle' && task.lastStopReason === 'completed' && (!plan.length || plan.every((s) => s.status === 'completed'));
          const busy = ['queued', 'running', 'waiting'].includes(task.status);
          const label = completed ? '已完成' : task.status === 'queued' ? '排队中' : task.status === 'waiting' ? '等待授权' : task.status === 'failed' ? '失败' : task.status === 'running' ? '执行中' : task.status === 'stopped' ? '已停止' : task.status === 'interrupted' ? '已中断' : '待处理';
          return <li key={task.id}>
            <button className="flex w-full items-start gap-2 text-left" onClick={() => onSelect(task)} title={label}>
              <span aria-label={label} className={`mt-1 h-2 w-2 shrink-0 rounded-full ${completed ? 'bg-emerald-500' : task.status === 'waiting' ? 'bg-amber-500' : task.status === 'failed' ? 'bg-red-500' : busy ? 'bg-blue-500 animate-pulse' : 'bg-neutral-500'}`} />
              <span className={`break-words ${completed ? 'text-neutral-500 line-through' : selected ? 'font-medium text-neutral-100' : 'text-neutral-400'}`}>{task.name}</span>
            </button>
            <div className="ml-4 mt-1 flex items-center gap-2 text-[10px] text-neutral-500"><span>{label}</span>
              {busy ? <button className="text-neutral-300 hover:text-red-400" onClick={() => { void api.stop(task.id).catch((e: unknown) => setMessage(String(e))); }}>停止</button>
                : !completed && ['failed', 'stopped', 'interrupted'].includes(task.status) && <button className="text-blue-400" onClick={() => onRetry(task)}>{task.status === 'failed' ? '重试' : '继续'}</button>}
            </div>
            {selected && plan.length > 0 && <ul className="ml-4 mt-2 space-y-2 border-l border-neutral-700 pl-3">
              {plan.map((step, i) => <li key={i} className="flex items-start gap-2">
                <span aria-label={step.status === 'completed' ? '已完成' : step.status === 'in_progress' ? '进行中' : '待处理'} className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${step.status === 'completed' ? 'bg-emerald-500' : step.status === 'in_progress' ? 'bg-blue-500' : 'bg-neutral-500'}`} />
                <span className={step.status === 'completed' ? 'text-neutral-500 line-through' : 'text-neutral-300'}>{step.step}</span>
              </li>)}
            </ul>}
          </li>;
        })}
      </ul>
    </section>
    <section aria-label="产物" className="flex h-40 flex-col border-t border-neutral-800 pt-4">
      <div className="mb-3 flex shrink-0 items-center justify-between"><h2 className="font-medium text-neutral-100">产物</h2><button title="浏览服务端文件与成果同步" aria-label="浏览服务端文件与成果同步" onClick={() => setBrowseFiles(true)}><Icon name="folder" /></button></div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {!data?.artifacts.length && <p className="text-neutral-500">{taskId ? '生成的文件会显示在这里' : '选择任务后查看产物'}</p>}
        <ul className="space-y-1">{data?.artifacts.map((file) => <li key={file.name}>
          <button disabled={Boolean(opening) || file.state === 'generating' || file.state === 'failed'} title={`${file.name}${opening === file.name ? ' · 正在打开' : file.state === 'generating' ? ' · 生成中' : file.state === 'failed' ? ' · 生成失败' : ''}`} className="block w-full truncate rounded px-1 py-1.5 text-left text-neutral-300 hover:bg-neutral-800 disabled:opacity-50" onClick={() => void open(file.name)}>{file.name}</button>
        </li>)}</ul>
        {message && <p role="status" className="mt-2 text-neutral-400">{message}</p>}
      </div>
    </section>
    <section aria-label="技能与 MCP" className="flex h-44 flex-col border-t border-neutral-800 pt-4">
      <h2 className="mb-3 shrink-0 font-medium text-neutral-100">技能与 MCP</h2><div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      <ul className="space-y-2">{data?.skills.map((skill) => <li key={skill.name} title={skill.description} className="flex items-start gap-2 text-neutral-300"><Icon name="skill" /><span className="break-all">{skill.name}</span></li>)}</ul>
      {!data?.skills.length && <p className="text-neutral-500">暂无可用技能</p>}
      <div className="mt-3 text-neutral-500">MCP：{data?.mcp.length ? data.mcp.map(m => <details key={m.name} className="mt-2"><summary className="cursor-pointer break-words">{m.name} · {m.enabled ? `${m.toolCount ?? 0} 个可用工具` : m.status === 'error' ? '连接异常' : '未启用'}</summary><ul className="mt-2 space-y-2 pl-3">{m.tools?.map(t => <li key={t.name} title={t.description} className="break-all">{t.name} · {t.enabled ? '可用' : '未启用'}</li>)}</ul></details>) : '未接入服务'}</div>
    </div></section>
    <section aria-label="三层记忆" className="border-t border-neutral-800 pt-4">
      <h2 className="mb-3 font-medium text-neutral-100">记忆</h2>
      {([['task', '任务记忆'], ['project', '项目记忆'], ['personal', '个人记忆']] as const).map(([layer, label]) => <button key={layer} className="mb-2 flex w-full items-center gap-2 rounded p-1 text-left text-neutral-300 hover:bg-neutral-800" onClick={() => setMemoryLayer(layer)}><Icon name="memory" />{label}<span className="ml-auto"><Icon name="right" /></span></button>)}
      <p className="text-[10px] text-neutral-500">点击查看、修改和设置自动加载</p>
    </section>
    {memoryLayer && <MemoryCenter key={taskId} taskId={taskId} initialLayer={memoryLayer} onClose={() => setMemoryLayer(null)} />}
    {browseFiles && <ArtifactBrowser key={taskId} taskId={taskId} onClose={() => setBrowseFiles(false)} />}
  </div>;
}
