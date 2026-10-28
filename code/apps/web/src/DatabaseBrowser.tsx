import { useCallback, useEffect, useRef, useState } from 'react';
import { jsonFetch } from './api';
import { Icon } from './Icon';

interface Frame { available: boolean; open: boolean; busy: boolean; url?: string; title?: string; image?: string; width?: number; height?: number; blockedRequests?: number;blockedUrls?:string[] }
const button = 'rounded px-2 py-1 text-sm hover:bg-neutral-800 disabled:opacity-40';
/** 显示真实远程浏览器画面；鼠标坐标按实际视口缩放，输入只发往当前任务。 */
export function DatabaseBrowser({ taskId, onHide, width }: { taskId: string | null; onHide: () => void; width?: number }) {
  const [frame, setFrame] = useState<Frame | null>(null), [address, setAddress] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const surface = useRef<HTMLDivElement>(null), editing = useRef(false), active = useRef(taskId), current = useRef(frame);
  const chain = useRef(Promise.resolve()), pending = useRef(0), composing = useRef(false), [composition, setComposition] = useState('');
  const imeValue=useRef('');
  const wheelBuffer=useRef(0),wheelTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const textBuffer = useRef(''), textTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  current.current = frame; active.current = taskId;
  const apply = useCallback((value: Frame) => { setFrame(old => !value.open || value.image ? value : { ...old, ...value }); if (!editing.current && value.url) setAddress(value.url); }, []);
  useEffect(() => {
    setFrame(null); setAddress(''); setError(''); editing.current = false;
    const controller = new AbortController(); let inflight = false;
    const poll = async () => {
      if (!taskId || inflight || document.hidden || pending.current) return;
      inflight = true;
      try { const value = await jsonFetch<Frame>(`/api/tasks/${taskId}/browser`, { signal: controller.signal }); if (!controller.signal.aborted) { apply(value); setError(''); } }
      catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : '浏览器连接失败'); }
      finally { inflight = false; }
    };
    void poll(); const timer = setInterval(() => { void poll(); }, 1500);
    return () => { controller.abort(); clearInterval(timer); clearTimeout(textTimer.current);clearTimeout(wheelTimer.current); textBuffer.current = ''; };
  }, [taskId, apply]);
  const command = useCallback((value: Record<string, unknown>) => {
    const task = taskId; if (!task) return;
    pending.current++; setBusy(true);
    chain.current = chain.current.catch(() => undefined).then(async () => {
      if (active.current !== task) return;
      try { const result = await jsonFetch<Frame>(`/api/tasks/${task}/browser`, { method: 'POST', body: JSON.stringify(value) }); if (active.current === task) { apply(result); setError(''); } }
      catch (e) { if (active.current === task) setError(e instanceof Error ? e.message : '浏览器操作失败'); }
    }).finally(() => { pending.current--; if (!pending.current) setBusy(false); });
  }, [taskId, apply]);
  const flush = useCallback(() => { clearTimeout(textTimer.current); if (textBuffer.current) { command({ kind: 'text', text: textBuffer.current }); textBuffer.current = ''; } }, [command]);
  useEffect(() => {
    if (!frame?.open) return;
    const element = surface.current; if (!element) return;
    let timer: ReturnType<typeof setTimeout>;
    const observer = new ResizeObserver(([entry]) => { if (!entry) return; clearTimeout(timer); timer = setTimeout(() => {
      const width = Math.max(320, Math.min(1920, Math.round(entry.contentRect.width))), height = Math.max(240, Math.min(1200, Math.round(entry.contentRect.height)));
      if (current.current?.width !== width || current.current?.height !== height) command({ kind: 'resize', width, height });
    }, 350); });
    observer.observe(element); return () => { observer.disconnect(); clearTimeout(timer); };
  }, [frame?.open, command]);
  const disabled = !taskId || !frame?.available || busy || frame.busy;
  return <aside aria-label="共享浏览器" className="flex min-w-[320px] shrink-0 flex-col border-l border-neutral-800 bg-neutral-950" style={{ width: width ? `${width}px` : 'clamp(360px,42vw,760px)' }}>
    <div className="flex h-12 shrink-0 items-center justify-between border-b border-neutral-800 px-3"><strong className="truncate text-sm">{frame?.title || '浏览器'}</strong><div className="flex items-center gap-1"><span className="text-xs text-neutral-500">{busy || frame?.busy ? '正在操作…' : '与 AI 共享'}</span><button className={button} title="关闭当前网页会话" aria-label="关闭当前网页会话" disabled={!frame?.open || busy} onClick={() => { flush(); command({ kind: 'close' }); }}>×</button><button className={button} aria-label="隐藏浏览器" onClick={onHide}><Icon name="panelClose" size={17} /></button></div></div>
    <form className="flex shrink-0 gap-1 border-b border-neutral-800 p-2" onSubmit={e => { e.preventDefault(); flush(); editing.current = false; command({ kind: 'navigate', url: /^https?:\/\//i.test(address) ? address : 'https://' + address }); }}>
      <button type="button" className={button} aria-label="浏览器后退" disabled={disabled || !frame?.open} onClick={() => { flush(); command({ kind: 'back' }); }}>←</button><button type="button" className={button} aria-label="浏览器前进" disabled={disabled || !frame?.open} onClick={() => { flush(); command({ kind: 'forward' }); }}>→</button><button type="button" className={button} aria-label="刷新网页" disabled={disabled || !frame?.open} onClick={() => { flush(); command({ kind: 'reload' }); }}>↻</button>
      <input aria-label="网页地址" placeholder="输入网址" className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-900 px-2 text-xs outline-none" value={address} onFocus={() => { editing.current = true; }} onBlur={() => { editing.current = false; }} onChange={e => setAddress(e.target.value)} disabled={!taskId || frame?.available === false} /><button className={button} disabled={disabled || !address.trim()}>打开</button>
    </form>
    {!!frame?.blockedUrls?.length&&<details className="max-h-48 shrink-0 overflow-auto border-b border-neutral-800 p-2 text-xs"><summary>严格模式：{frame.blockedUrls.length} 个地址被阻止</summary><p className="my-2">仅允许确认过的完整地址。请核对路径与查询参数；追加许可持续到关闭当前会话，之后可刷新网页重试。</p>{frame.blockedUrls.map(url=><div key={url} className="mb-2"><p className="break-all">{url}</p><button className={button} disabled={disabled} onClick={()=>command({kind:'allow_url',url})}>允许本会话访问此地址</button></div>)}</details>}
    {error && <p role="alert" className="shrink-0 px-3 py-2 text-xs text-amber-300">{error}</p>}
    <div ref={surface} aria-label="网页画面" className="relative min-h-[240px] flex-1 overflow-hidden bg-neutral-900 outline-none" onClick={e => {
      if (!frame?.image || frame.busy) return; flush();
      const rect = e.currentTarget.getBoundingClientRect(), width = frame.width ?? 1280, height = frame.height ?? 800, scale = Math.min(rect.width / width, rect.height / height);
      const x = (e.clientX - rect.left - (rect.width - width * scale) / 2) / scale, y = (e.clientY - rect.top - (rect.height - height * scale) / 2) / scale;
      if (x >= 0 && y >= 0 && x < width && y < height) command({ kind: 'click', x, y });
      e.currentTarget.querySelector('textarea')?.focus({preventScroll:true});
    }} onWheel={e => { if (!frame?.open || frame.busy) return; e.preventDefault(); flush();wheelBuffer.current=Math.max(-5000,Math.min(5000,wheelBuffer.current+Math.round(e.deltaY)));clearTimeout(wheelTimer.current);wheelTimer.current=setTimeout(()=>{command({kind:'scroll',pixels:wheelBuffer.current});wheelBuffer.current=0;},80); }}>
      {frame?.image ? <img alt="当前网页实时画面" draggable={false} src={'data:image/jpeg;base64,' + frame.image} className="h-full w-full select-none object-contain" /> : <div className="flex h-full items-center justify-center p-6 text-center text-sm text-neutral-500">{!taskId ? '选择一个对话后打开网页' : frame?.available === false ? '浏览器服务尚未启用' : '输入网址，或让 Workpivot 打开网页'}</div>}
      <textarea aria-label="网页键盘输入" className="absolute left-0 top-0 h-px w-px opacity-0" value={composition} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={e => { composing.current = false; textBuffer.current += e.data; imeValue.current=e.data; setComposition(''); textTimer.current = setTimeout(flush, 80); }} onChange={e => {if(imeValue.current&&e.target.value===imeValue.current){imeValue.current='';setComposition('');return;} setComposition(e.target.value); if (!composing.current) { textBuffer.current += e.target.value; setComposition(''); textTimer.current = setTimeout(flush, 80); } }} onKeyDown={e => {
        if (composing.current || e.nativeEvent.isComposing || frame?.busy) return;
        const key = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' ? 'Control+A' : e.key;
        if (['Enter','Backspace','Delete','Tab','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','PageUp','PageDown','Escape','Control+A'].includes(key)) { e.preventDefault(); flush(); command({ kind: 'key', key }); }
      }} onPaste={e => { e.preventDefault(); const text = e.clipboardData.getData('text'); if (text.length <= 4000) { flush(); command({ kind: 'text', text }); } else setError('一次最多粘贴4000字符'); }} />
    </div>
    <div className="shrink-0 border-t border-neutral-800 px-3 py-2 text-[11px] text-neutral-500">点击网页后可输入或粘贴；仅支持公开网页，暂不支持登录提交、下载和音视频。{frame?.blockedRequests ? ' 部分请求已被安全策略阻止。' : ''}</div>
  </aside>;
}
