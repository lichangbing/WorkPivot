import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../Icon';
import { packagesApi, saveBlob, type PackageDetail, type PackageSummary, type PackageValidation } from './skill-packages-api';

const button = 'rounded border border-neutral-700 bg-neutral-800 px-3 py-2 text-xs hover:bg-neutral-700 disabled:opacity-40';
const input = 'rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm';
const size = (bytes: number) => bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB`;

export function SkillPackagesPanel({ onDirty }: { onDirty: (dirty: boolean) => void }): React.JSX.Element {
  const [list, setList] = useState<PackageSummary[]>([]);
  const [detail, setDetail] = useState<PackageDetail | null>(null);
  const [selected, setSelected] = useState('');
  const [treeSelected, setTreeSelected] = useState('');
  const [targetDirectory, setTargetDirectory] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [content, setContent] = useState<string | null>(null);
  const [original, setOriginal] = useState<string | null>(null);
  const [preview, setPreview] = useState('');
  const [newName, setNewName] = useState('');
  const [filePath, setFilePath] = useState('');
  const uploadRef = useRef<HTMLInputElement>(null);
  const zipRef = useRef<HTMLInputElement>(null);
  const [creation, setCreation] = useState<'file' | 'directory' | null>(null);
  const [version, setVersion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [validation, setValidation] = useState<PackageValidation | null>(null);
  const dirty = content !== original;
  const refresh = useCallback(async () => { setList((await packagesApi.list()).packages); }, []);
  useEffect(() => { void refresh().catch(e => setError(String(e))); }, [refresh]);
  useEffect(() => { onDirty(dirty || busy); return () => onDirty(false); }, [dirty, busy, onDirty]);
  useEffect(() => { const handler = (event: BeforeUnloadEvent) => { if (dirty || busy) { event.preventDefault(); event.returnValue = ''; } }; window.addEventListener('beforeunload', handler); return () => window.removeEventListener('beforeunload', handler); }, [dirty, busy]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  const canLeave = () => !dirty || window.confirm('放弃当前文件尚未保存的修改？已保存的草稿会保留。');
  const work = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const clearFile = () => { setSelected(''); setTreeSelected(''); setTargetDirectory(''); setContent(null); setOriginal(null); setPreview(''); };
  const apply = (value: PackageDetail) => { setDetail(value); setValidation(null); };
  const loadFile = async (name: string, path: string) => {
    const file = await packagesApi.file(name, path);
    setSelected(path); setContent(file.content); setOriginal(file.content); setPreview('');
    setTreeSelected(path); setTargetDirectory(path.split('/').slice(0, -1).join('/'));
    setCollapsed(previous => new Set([...previous].filter(folder => !path.startsWith(folder + '/'))));
    if (file.content === null && /\.(png|jpe?g|webp|gif)$/i.test(path)) {
      const blob = await packagesApi.download(name, path); setPreview(URL.createObjectURL(blob));
    }
  };
  const open = (name: string) => { if (canLeave()) void work(async () => { const value = await packagesApi.open(name); apply(value); clearFile(); setCollapsed(new Set()); setCreation(null); setFilePath(''); setVersion(value.published ?? ''); await loadFile(name, 'SKILL.md'); await refresh(); }); };
  const fileRows = detail ? (() => {
    const rows = new Map<string, { path: string; directory: boolean; size: number }>();
    for (const path of detail.directories ?? []) rows.set(path, { path, directory: true, size: 0 });
    for (const file of detail.files) {
      const parts = file.path.split('/'); for (let i = 1; i < parts.length; i++) { const directory = parts.slice(0, i).join('/'); rows.set(directory, { path: directory, directory: true, size: 0 }); }
      rows.set(file.path, { ...file, directory: false });
    }
    return [...rows.values()].sort((a, b) => a.path.localeCompare(b.path));
  })() : [];
  const inTarget = (name: string) => targetDirectory ? targetDirectory + '/' + name : name;
  const selectDirectory = (path: string) => { setTreeSelected(path); setTargetDirectory(path); };

  return <div className="max-w-[1320px] space-y-4">
    <div><h2 className="text-base font-semibold">Skill 文件包管理</h2><p className="mt-1 text-xs text-neutral-500">管理当前账号的说明、脚本、参考资料与模板。保存草稿后校验发布，任务只使用已发布版本。</p></div>
    {error && <p role="alert" className="whitespace-pre-wrap rounded border border-red-500/30 p-3 text-sm text-red-400">{error}</p>}
    {notice && <p role="status" className="text-sm text-emerald-500">{notice}</p>}
    <div className="flex flex-wrap gap-2">
      <input aria-label="新技能名称" placeholder="新技能名称，如 industry-research" className={`${input} w-72`} disabled={busy} value={newName} onChange={e => setNewName(e.target.value)} />
      <button className={button} disabled={busy || !newName.trim()} onClick={() => { if (canLeave()) void work(async () => { const value = await packagesApi.create(newName.trim()); apply(value); clearFile(); setVersion(''); setNewName(''); await loadFile(value.name, 'SKILL.md'); await refresh(); setNotice('草稿已创建；可编辑文件，也可导入 ZIP。发布前不会供模型加载。'); }); }}>新建技能包</button>
      <button className={button} disabled={busy} onClick={() => void work(refresh)}>刷新列表</button>
    </div>
    <div className="flex min-h-[560px] flex-wrap gap-4">
      <aside className="w-48 shrink-0 space-y-1" aria-label="技能包列表">
        {list.length === 0 && <p className="text-xs text-neutral-500">暂无技能包，可在上方新建。</p>}
        {list.map(skill => <div key={skill.name} className={`rounded-lg border px-3 py-2 ${detail?.name === skill.name ? 'border-blue-500 bg-neutral-900' : 'border-neutral-800'}`}>
          <button className="w-full break-words text-left text-sm font-medium" disabled={busy} onClick={() => open(skill.name)}>{skill.name}</button>
          <div className="flex flex-wrap items-center gap-2 text-xs"><span>{!skill.hasPublished ? '未发布' : skill.disabled ? '已禁用' : '已启用'}{skill.dirty ? ' · 有草稿' : ''}</span>
            <button className="underline" disabled={busy} onClick={() => void work(async () => { await packagesApi.toggle(skill.name, !skill.disabled); await refresh(); })}>{skill.disabled ? '启用' : '禁用'}</button>
          </div>
        </div>)}
      </aside>
      {!detail ? <div className="p-5 text-sm text-neutral-500">选择技能包，查看文件和发布版本。</div> : <section className="min-w-0 flex-1 space-y-3" aria-label="技能包编辑器">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="mr-auto font-medium">{detail.name} <span className="text-xs text-neutral-500">{detail.dirty ? '草稿有变更' : '与发布版本一致'}</span></h3>
        </div>
        <p className="text-xs text-neutral-500">最多256个文件，单文件8MiB，整包16MiB。脚本由现有执行服务按任务权限运行，不会在上传或发布时执行。</p>
        {validation && <div className={`rounded border p-3 text-xs ${validation.valid ? 'border-emerald-600' : 'border-red-500'}`} role="status">
          <strong>{validation.valid ? '校验通过' : '校验未通过'}</strong>{[...validation.errors, ...validation.warnings].map((item, i) => <p className="mt-1" key={i}>{item}</p>)}
        </div>}
        <div className="flex flex-wrap gap-2" role="toolbar" aria-label="技能文件操作">
          <button className={button} title="新建文件" aria-label="新建文件" disabled={busy} onClick={() => { setCreation('file'); setFilePath(inTarget('')); }}><Icon name="filePlus" /></button>
          <button className={button} title="新建文件夹" aria-label="新建文件夹" disabled={busy} onClick={() => { setCreation('directory'); setFilePath(inTarget('')); }}><Icon name="folderPlus" /></button>
          <button className={button} title="上传 / 替换文件" aria-label="上传 / 替换文件" disabled={busy} onClick={() => uploadRef.current?.click()}><Icon name="upload" /></button><input ref={uploadRef} aria-label="上传资源文件" className="hidden" type="file" disabled={busy} onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (!file || !canLeave()) return; const path = inTarget(file.name); if (detail.files.some(f => f.path === path) && !window.confirm(`替换草稿中的 ${path}？`)) return; void work(async () => { if (file.size > 8 * 1024 * 1024) throw new Error('单文件最多8MiB'); apply(await packagesApi.upload(detail.name, path, file, detail.revision)); await loadFile(detail.name, path); setFilePath(''); await refresh(); }); }} />
          <button className={button} title="导入 ZIP" aria-label="导入 ZIP" disabled={busy} onClick={() => zipRef.current?.click()}><Icon name="archive" /></button><input ref={zipRef} aria-label="导入技能 ZIP" className="hidden" type="file" accept=".zip" disabled={busy} onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (!file || !window.confirm('导入会替换此技能包的全部草稿文件，已发布版本保持不变。继续？')) return; void work(async () => { if (file.size > 16 * 1024 * 1024) throw new Error('ZIP 最多16MiB'); apply(await packagesApi.import(detail.name, file, detail.revision)); clearFile(); await loadFile(detail.name, 'SKILL.md'); await refresh(); setNotice('ZIP 已导入草稿，点击发布时会自动校验。'); }); }} />
          <button className={button} title="删除选中项" aria-label="删除选中项" disabled={busy || !treeSelected || treeSelected === 'SKILL.md'} onClick={() => {
            const path = treeSelected; const directory = fileRows.some(f => f.path === path && f.directory);
            if (!window.confirm(directory ? '从草稿删除文件夹 ' + path + ' 及其全部内容？已发布版本保留。' : '从草稿删除 ' + path + '？')) return;
            void work(async () => { apply(directory ? await packagesApi.removeDirectory(detail.name, path, detail.revision) : await packagesApi.remove(detail.name, path, detail.revision));
              if (selected === path || selected.startsWith(path + '/')) clearFile();
              selectDirectory(path.split('/').slice(0, -1).join('/')); await refresh(); setNotice('已从草稿删除，发布后生效。');
            });
          }}><Icon name="trash" /></button>
          <button className={`${button} text-blue-400`} disabled={busy || dirty || !detail.dirty} aria-label="发布" title={dirty ? '请先保存当前文件' : '发布整个技能包'} onClick={() => void work(async () => { const report = await packagesApi.validate(detail.name); setValidation(report); if (!report.valid) return; const value = await packagesApi.publish(detail.name, detail.revision); apply(value); setVersion(value.published ?? ''); await refresh(); setNotice('已发布整个技能包；正在运行的任务继续使用原版本，下一轮使用新版本。'); })}><Icon name="play" /></button>
        </div>
        {creation && <form className="flex flex-wrap items-center gap-2 rounded border border-neutral-700 bg-neutral-900 p-3" onSubmit={e => { e.preventDefault(); if (!canLeave()) return; void work(async () => {
          const path = filePath.trim();
          if (creation === 'directory') { apply(await packagesApi.directory(detail.name, path, detail.revision)); selectDirectory(path); setCollapsed(previous => new Set([...previous].filter(folder => folder !== path && !path.startsWith(folder + '/')))); setNotice('文件夹已创建，可在其中新建文件或脚本。'); }
          else {
            if (detail.files.some(f => f.path.toLowerCase() === path.toLowerCase()) || (detail.directories ?? []).some(d => d.toLowerCase() === path.toLowerCase())) throw new Error('同名文件或文件夹已存在');
            apply(await packagesApi.save(detail.name, path, '', detail.revision)); await loadFile(detail.name, path); setNotice('文件已创建，可编辑并保存草稿。');
          }
          setCreation(null); setFilePath(''); await refresh();
        }); }}>
          <strong className="text-sm">{creation === 'directory' ? '新建文件夹' : '新建文件'}</strong>
          <input autoFocus required aria-label="新建路径" className={`${input} min-w-48 flex-1`} disabled={busy} value={filePath} onChange={e => setFilePath(e.target.value)} placeholder={creation === 'directory' ? '例如 references 或 scripts/helpers' : '例如 references/method.md'} />
          <button type="submit" className={button} disabled={busy || !filePath.trim()}>创建</button><button type="button" className={button} disabled={busy} onClick={() => { setCreation(null); setFilePath(''); }}>取消</button>
        </form>}
        <div className="flex min-h-[420px] rounded-lg border border-neutral-800">
          <nav aria-label="技能文件树" onClick={e => { if (e.target === e.currentTarget) selectDirectory(''); }} className="w-56 shrink-0 overflow-auto border-r border-neutral-800 bg-neutral-900 p-2">
            {fileRows.filter(file => ![...collapsed].some(folder => file.path.startsWith(folder + '/'))).map(file => file.directory ?
              <div key={file.path} className={`flex items-center rounded text-xs ${treeSelected === file.path ? 'bg-neutral-800 text-blue-400' : 'hover:bg-neutral-800'}`} style={{ paddingLeft: (file.path.split('/').length - 1) * 12 }}>
                <button className="shrink-0 rounded p-1.5" disabled={busy} aria-label={`${collapsed.has(file.path) ? '展开' : '折叠'} ${file.path}`} aria-expanded={!collapsed.has(file.path)} onClick={() => setCollapsed(previous => { const next = new Set(previous); if (next.has(file.path)) next.delete(file.path); else next.add(file.path); return next; })}><Icon name={collapsed.has(file.path) ? 'right' : 'down'} size={12} /></button>
                <button className="flex min-w-0 flex-1 items-center gap-2 py-2 text-left" disabled={busy} aria-label={`选择文件夹 ${file.path}`} aria-pressed={treeSelected === file.path} onClick={() => selectDirectory(file.path)}><Icon name="folder" size={14} /><span className="break-all">{file.path.split('/').at(-1)}</span></button>
              </div> : <button key={file.path} title={`${file.path} · ${size(file.size)}`} aria-pressed={treeSelected === file.path} disabled={busy} className={`flex w-full items-center gap-2 break-all rounded py-2 pr-1 text-left text-xs ${treeSelected === file.path ? 'bg-neutral-800 text-blue-400' : 'hover:bg-neutral-800'}`} style={{ paddingLeft: (file.path.split('/').length - 1) * 12 + 24 }} onClick={() => { if (file.path === selected) { selectDirectory(file.path.split('/').slice(0, -1).join('/')); setTreeSelected(file.path); } else if (canLeave()) void work(() => loadFile(detail.name, file.path)); }}><Icon name="file" size={14} />{file.path.split('/').at(-1)}</button>)}
          </nav>
          <div className="min-w-0 flex-1 p-3">
            {selected ? <>
              <div className="mb-3 flex flex-wrap items-center gap-2"><span className="mr-auto break-all text-sm">{selected}{dirty ? ' · 未保存' : ''}</span>
                <button className={button} disabled={busy} onClick={() => void work(async () => saveBlob(await packagesApi.download(detail.name, selected), selected.split('/').at(-1)!))}>下载</button>
              </div>
              {content !== null ? <><textarea aria-label="文件内容" spellCheck={false} disabled={busy} className={`${input} h-[48vh] min-h-64 w-full resize-y font-mono text-xs leading-6`} value={content} onChange={e => setContent(e.target.value)} />
                <button className={`${button} mt-2`} disabled={busy || !dirty} onClick={() => void work(async () => { apply(await packagesApi.save(detail.name, selected, content, detail.revision)); setOriginal(content); await refresh(); setNotice('已保存草稿，发布前不会改变任务使用的版本。'); })}>保存草稿</button>
              </> : preview ? <img className="max-h-[48vh] max-w-full object-contain" src={preview} alt={selected} /> : <p className="p-5 text-sm text-neutral-500">二进制文件或大文本：可下载查看，或通过上传替换。Word、Excel、PPT 模板请下载后用本地软件打开。</p>}
            </> : <p className="text-sm text-neutral-500">选择一个文件开始编辑。</p>}
          </div>
        </div>
        <details className="rounded border border-neutral-800 p-3 text-xs"><summary>依赖与执行权限</summary><p className="my-2 text-neutral-500">在 skill.json 中声明 requiredSkills（依赖技能）和 runtimeDependencies（运行依赖）。发布时检查技能是否可用；运行依赖不会自动安装。技能不能提升任务权限。</p>
          <pre className="whitespace-pre-wrap">{JSON.stringify(detail.dependencies ?? { requiredSkills: [], runtimeDependencies: [] }, null, 2)}</pre>
          {!detail.files.some(f => f.path === 'skill.json') && <button className={`${button} mt-2`} disabled={busy || dirty} onClick={() => void work(async () => { apply(await packagesApi.save(detail.name, 'skill.json', JSON.stringify({ requiredSkills: [], runtimeDependencies: [] }, null, 2), detail.revision)); await loadFile(detail.name, 'skill.json'); await refresh(); })}>添加依赖说明</button>}
        </details>
        <div className="flex flex-wrap items-center gap-2 rounded border border-neutral-800 p-3">
          <span className="text-sm">发布历史</span><select aria-label="发布版本" className={`${input} min-w-48`} value={version} onChange={e => setVersion(e.target.value)} disabled={busy}><option value="">选择版本</option>{[...detail.versions].reverse().map(v => <option key={v.id} value={v.id}>{v.label} · {new Date(v.createdAt).toLocaleString()}{detail.published === v.id ? ' · 当前' : ''}</option>)}</select>
          <button className={button} disabled={busy || !version} onClick={() => void work(async () => saveBlob(await packagesApi.export(detail.name, version), `${detail.name}-${version}.zip`))}>下载此版本</button>
          <button className={button} disabled={busy || !version || version === detail.published} onClick={() => { if (window.confirm('将选中版本设为当前发布版本？草稿会保留，正在运行的任务不受影响。')) void work(async () => { apply(await packagesApi.rollback(detail.name, version, detail.revision)); await refresh(); setNotice('发布版本已回退，草稿保留。'); }); }}>回退到此版本</button>
        </div>
      </section>}
    </div>
  </div>;
}
