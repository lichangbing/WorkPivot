import { useEffect, useRef, useState } from 'react';
import { Icon } from '../../web/src/Icon';
import { fileIcon } from '../../web/src/file-icons';
import type { MobileClient } from './client';

export function FileLabel({ name }: { name: string }) {
  return <span className="file-label"><Icon name={fileIcon(name)} /><span>{name}</span></span>;
}
interface Upload { key: string; name: string; id?: string; error?: string }
export function Attachments({ client, taskId, disabled, onChange, onError }: {
  client: MobileClient; taskId: string; disabled: boolean;
  onChange: (ids: string[], blocked: boolean) => void; onError: (error: unknown) => void;
}) {
  const [rows, setRows] = useState<Upload[]>([]);
  const input = useRef<HTMLInputElement>(null), uploading = useRef(false);
  const controller = useRef(new AbortController());
  useEffect(() => { const c = new AbortController(); controller.current = c; return () => c.abort(); }, []);
  useEffect(() => onChange(rows.flatMap(row => row.id ? [row.id] : []), rows.some(row => !row.id)), [rows, onChange]);
  const upload = async (files: File[]) => {
    if (uploading.current || disabled) return;
    uploading.current = true;
    const signal = controller.current.signal;
    for (const file of files.slice(0, Math.max(0, 10 - rows.length))) {
      if (signal.aborted) break;
      const key = crypto.randomUUID();
      setRows(old => [...old, { key, name: file.name }]);
      try {
        if (file.size > 10485760) throw new Error('文件超过 10MB');
        const query = new URLSearchParams({ name: file.name, requestId: key });
        const response = await client.response(`/api/tasks/${taskId}/files?${query}`, {
          method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file, signal,
        }, 120000);
        const result = await response.json() as { file: { id: string } };
        if (!signal.aborted) setRows(old => old.map(row => row.key === key ? { ...row, id: result.file.id } : row));
      } catch (error) {
        if (!signal.aborted) {
          setRows(old => old.map(row => row.key === key ? { ...row, error: error instanceof Error ? error.message : '上传失败' } : row));
          onError(error);
        }
      }
    }
    uploading.current = false;
  };
  return <div className="attachments">
    {!!rows.length && <div className="attachment-drafts" aria-label="待发送附件">{rows.map(row => <div key={row.key}>
      <FileLabel name={row.name} /><small role="status">{row.error ?? (row.id ? '已上传' : '上传中…')}</small>
      {(row.id || row.error) && <button type="button" disabled={disabled} aria-label={`移除附件 ${row.name}`} onClick={() => setRows(old => old.filter(item => item.key !== row.key))}><Icon name="close" /></button>}
    </div>)}</div>}
    <button type="button" aria-label="添加文件" disabled={disabled || rows.length >= 10 || rows.some(row => !row.id && !row.error)} onClick={() => input.current?.click()}><Icon name="plus" /></button>
    <input hidden ref={input} type="file" multiple onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ''; void upload(files); }} />
  </div>;
}
