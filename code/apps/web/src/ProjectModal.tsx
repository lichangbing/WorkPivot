import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';

interface Props {
  value: { name: string; directory: string; localDirectory?: boolean };
  error: string | null;
  onChange: (value: Props['value']) => void;
  onCreate: () => Promise<void>;
  onClose: () => void;
}

export function ProjectModal({ value, error, onChange, onCreate, onClose }: Props): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  const submitting = useRef(false);
  const [busy, setBusy] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    element.querySelector('input')?.focus();
    return () => element.close();
  }, []);

  return <dialog ref={dialog} aria-labelledby="project-dialog-title" className="m-auto w-[480px] max-w-[calc(100vw-32px)] rounded-2xl border border-neutral-700 bg-neutral-900 p-6 text-neutral-100 shadow-2xl backdrop:bg-black/50" onCancel={(event) => {
    event.preventDefault();
    if (!submitting.current) onClose();
  }}>
    <div className="mb-5 flex items-center justify-between">
      <h2 id="project-dialog-title" className="text-lg font-semibold">新建项目</h2>
      <button type="button" aria-label="关闭新建项目" disabled={busy} onClick={onClose} className="rounded p-1 text-neutral-400 hover:bg-neutral-800 disabled:opacity-40"><Icon name="close" /></button>
    </div>
    <form className="space-y-4" onSubmit={(event) => {
      event.preventDefault();
      if (submitting.current || !value.name.trim()) return;
      submitting.current = true;
      setBusy(true);
      void onCreate().finally(() => { submitting.current = false; setBusy(false); });
    }}>
      <div>
        <label htmlFor="project-name" className="mb-2 block text-sm">项目名称</label>
        <input id="project-name" autoFocus required disabled={busy} placeholder="输入项目名称" value={value.name} onChange={(event) => onChange({ ...value, name: event.target.value })} className="w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm" />
      </div>
      <div>
        <label htmlFor="project-directory" className="mb-2 block text-sm">工作目录</label>
        <button id="project-directory" type="button" disabled={busy || choosing} aria-describedby="project-directory-hint" className="flex w-full items-center gap-2 rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-left text-sm hover:bg-neutral-800 disabled:opacity-40" onClick={() => {
          const desktop = window.workpivotDesktop;
          if (!desktop) { setPickerError('请使用新版桌面客户端选择本机文件夹。'); return; }
          setPickerError(null);
          setChoosing(true);
          void desktop.selectDirectory().then((directory) => {
            if (directory) onChange({ ...value, directory, localDirectory: true });
          }).catch(() => setPickerError('无法打开文件夹选择窗口，请重试。')).finally(() => setChoosing(false));
        }}><Icon name="folder" /><span className="min-w-0 break-all">{choosing ? '正在选择…' : value.directory || '点击选择本机文件夹'}</span></button>
        <p id="project-directory-hint" className="mt-2 text-xs text-neutral-500">选择本机已连接到后台的文件夹；不选择则由后台自动创建。</p>
        {pickerError && <p role="alert" className="mt-2 text-sm text-red-400">{pickerError}</p>}
      </div>
      {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
      <div className="flex justify-end gap-2 pt-2">
        <button type="button" disabled={busy} onClick={onClose} className="rounded-lg bg-neutral-800 px-4 py-2 text-sm hover:bg-neutral-700 disabled:opacity-40">取消</button>
        <button type="submit" disabled={busy || choosing || !value.name.trim()} className="rounded-lg bg-blue-600 px-4 py-2 text-sm hover:bg-blue-500 disabled:opacity-40">{busy ? '创建中…' : '创建项目'}</button>
      </div>
    </form>
  </dialog>;
}
