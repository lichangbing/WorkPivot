import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { getToken } from './api';
import { Icon } from './Icon';
import { fileIcon } from './file-icons';

export interface Attachment { id: string; name: string | null; deleted?: boolean }
export function AttachmentLabel({ attachment }: { attachment: Attachment }) {
  return <span className="inline-flex max-w-full items-center gap-2 rounded border border-neutral-700 px-2 py-1 text-xs"><Icon name={fileIcon(attachment.name ?? '')} size={20} /><span className="break-all">{attachment.deleted ? '附件已删除' : attachment.name}</span></span>;
}
interface Draft { key: string; name: string; size: number; id?: string; error?: string }
export interface AttachmentActions { open: () => void; addFiles: (files: File[]) => void }
export const DatabaseAttachments = forwardRef<AttachmentActions, { taskId: string; disabled: boolean; onChange: (ids: string[], blocked: boolean) => void }>(function DatabaseAttachments({ taskId, disabled, onChange }, ref) {
  const [rows, setRows] = useState<Draft[]>([]);
  const requests = useRef(new Set<AbortController>()), mounted = useRef(true), input = useRef<HTMLInputElement>(null), uploading = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; for (const c of requests.current) c.abort(); }; }, []);
  useEffect(() => { onChange(rows.flatMap(r => r.id ? [r.id] : []), rows.some(r => !r.id)); }, [rows, onChange]);
  const upload = async (files: File[]) => {
    if (uploading.current || disabled) return;
    uploading.current = true;
    for (const file of files.slice(0, Math.max(0, 10 - rows.length))) {
      if (!mounted.current) break;
      const key = crypto.randomUUID(), c = new AbortController(); requests.current.add(c);
      setRows(old => [...old, { key, name: file.name, size: file.size }]);
      try {
        if (file.size > 10485760) throw Error('文件超过10MB');
        const query = new URLSearchParams({ name: file.name, requestId: key });
        const response = await fetch(`/api/tasks/${taskId}/files?${query}`, { method: 'POST', headers: { Authorization: `Bearer ${getToken() ?? ''}`, 'Content-Type': 'application/octet-stream' }, body: file, signal: AbortSignal.any([c.signal, AbortSignal.timeout(120000)]) });
        if (!response.ok) throw Error(((await response.json()) as { error: string }).error);
        const result = await response.json() as { file: { id: string } };
        if (mounted.current) setRows(old => old.map(r => r.key === key ? { ...r, id: result.file.id } : r));
      } catch (e) { if (mounted.current) setRows(old => old.map(r => r.key === key ? { ...r, error: e instanceof Error ? e.message : '上传失败' } : r)); }
      finally { requests.current.delete(c); }
    }
    uploading.current = false;
  };
  useImperativeHandle(ref, () => ({ open: () => { if (!disabled && !uploading.current && rows.length < 10) input.current?.click(); }, addFiles: files => { void upload(files); } }));
  return <>
    {!!rows.length && <div aria-label="待发送附件" className="mb-3 flex max-h-40 flex-wrap gap-2 overflow-y-auto border-b border-neutral-700 px-1 pb-3 pt-2">{rows.map(r => <div key={r.key} className="relative w-44 rounded-lg border border-neutral-700 bg-neutral-900 p-2">
      <p className="flex items-center gap-2 text-xs text-neutral-200" title={r.name}><Icon name={fileIcon(r.name)} size={20} /><span className="min-w-0 truncate">{r.name}</span></p>
      <p role="status" className={`mt-1 text-xs ${r.error ? 'text-red-400' : 'text-neutral-500'}`}>{r.error ?? (r.id ? `已上传 · ${(r.size / 1024).toFixed(1)} KB` : '上传中…')}</p>
      {(r.id || r.error) && <button type="button" disabled={disabled} title="取消本次附带" aria-label={`移除附件 ${r.name}`} className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-neutral-700 text-neutral-100 hover:bg-neutral-600 disabled:opacity-40" onClick={() => setRows(old => old.filter(v => v.key !== r.key))}><Icon name="close" size={12} /></button>}
    </div>)}</div>}
    <input ref={input} type="file" multiple hidden onChange={e => { const files = Array.from(e.target.files ?? []); e.target.value = ''; void upload(files); }} />
  </>;
});
