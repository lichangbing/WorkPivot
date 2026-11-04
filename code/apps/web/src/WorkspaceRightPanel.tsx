import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getToken, jsonFetch } from './api';
import { DatabaseBrowser } from './DatabaseBrowser';
import { fileIcon } from './file-icons';
import { Icon } from './Icon';
import { useVisiblePolling } from './use-visible-polling';
import './workspace-right.css';

type Tab = 'preview' | 'files' | 'browser';
interface Artifact {
  id: string;
  documentId: string;
  name: string;
  revision: number;
  current?: boolean;
  knowledgeStatus?: 'none' | 'pending' | 'confirmed' | 'rejected';
  hasTextLayer?: boolean | null;
  previewSha256?: string | null;
  previewConverterVersion?: string | null;
  previewGeneratedAt?: string | null;
  previewFontSha256?: string | null;
  previewHasTextLayer?: boolean | null;
}
interface PreviewProblem { message: string; code?: string }
const tabs: Array<{ id: Tab; label: string }> = [
  { id: 'preview', label: '预览' },
  { id: 'files', label: '文件' },
  { id: 'browser', label: '浏览器' },
];
const textExtensions = new Set(['md', 'txt', 'csv', 'json', 'html', 'htm']);
const previewExtensions = new Set(['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'docx', 'xlsx', 'pptx', ...textExtensions]);
const control = 'rounded-lg border border-neutral-700 px-2.5 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-40';
const extension = (name: string) => name.split('.').at(-1)?.toLowerCase() ?? '';
const canPreview = (name: string) => previewExtensions.has(extension(name));
const knowledgeLabel = { none: '未入库', pending: '待确认', confirmed: '已入库', rejected: '已拒绝' } as const;
const isTab = (value: string): value is Tab => tabs.some(item => item.id === value);

function storageKey(owner: string, taskId: string | null, name: string): string {
  return `wp-right-${name}:${owner}:${taskId ?? 'empty'}`;
}
function remembered(owner: string, taskId: string | null, name: string): string {
  try { return localStorage.getItem(storageKey(owner, taskId, name)) ?? ''; } catch { return ''; }
}
function remember(owner: string, taskId: string | null, name: string, value: string): void {
  try { localStorage.setItem(storageKey(owner, taskId, name), value); } catch { /* 存储禁用时仍保留当前会话状态。 */ }
}

function sanitizedHtml(source: string): string {
  const document = new DOMParser().parseFromString(source, 'text/html');
  for (const element of document.querySelectorAll('script,iframe,object,embed,link,meta,base,form')) element.remove();
  for (const element of document.querySelectorAll('*')) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase(), value = attribute.value.trim().toLowerCase();
      if (name.startsWith('on') || name === 'srcdoc') element.removeAttribute(attribute.name);
      if ((name === 'src' || name === 'href' || name === 'xlink:href') && !value.startsWith('data:image/')) element.removeAttribute(attribute.name);
      if (name === 'style' && /url\s*\(|expression\s*\(/i.test(attribute.value)) element.removeAttribute(attribute.name);
    }
  }
  return document.body.innerHTML;
}

function CsvPreview({ text }: { text: string }) {
  const rows = text.split(/\r?\n/).slice(0, 500).map(line => {
    const cells: string[] = [];
    let value = '', quoted = false;
    for (let index = 0; index < line.length; index++) {
      const char = line[index];
      if (char === '"' && quoted && line[index + 1] === '"') { value += '"'; index++; }
      else if (char === '"') quoted = !quoted;
      else if (char === ',' && !quoted) { cells.push(value); value = ''; }
      else value += char;
      if (cells.length >= 20) break;
    }
    cells.push(value);
    return cells;
  });
  return <div className="workspace-preview-table-wrap"><table className="workspace-preview-table"><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => rowIndex === 0 ? <th key={cellIndex}>{cell}</th> : <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody></table></div>;
}

function PreviewSurface({ taskId, file, onDownload }: { taskId: string | null; file: Artifact | null; onDownload: () => void }) {
  const [kind, setKind] = useState<'empty'|'loading'|'error'|'image'|'pdf'|'text'|'html'|'csv'>('empty');
  const [text, setText] = useState(''), [error, setError] = useState<PreviewProblem | null>(null), [objectUrl, setObjectUrl] = useState('');
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    let object: string | null = null;
    const controller = new AbortController();
    if (!taskId || !file) { setKind('empty'); setText(''); setError(null); setObjectUrl(''); return () => controller.abort(); }
    const type = extension(file.name);
    setKind('loading'); setText(''); setError(null); setObjectUrl('');
    void (async () => {
      try {
        const response = await fetch(`/api/tasks/${taskId}/file-versions/${file.id}/preview`, {
          headers: { Authorization: `Bearer ${getToken() ?? ''}` },
          signal: controller.signal,
        });
        if (!response.ok) {
          const value = await response.json().catch(() => ({ error: `预览失败（HTTP ${response.status}）` })) as { error?: string; code?: string };
          throw Object.assign(Error(value.error ?? `预览失败（HTTP ${response.status}）`), { code: value.code });
        }
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        if (textExtensions.has(type)) {
          const content = await blob.text();
          if (controller.signal.aborted) return;
          if (content.length > 1_000_000) throw Error('文本超过 1 MB，请下载后查看完整内容');
          setText(content);
          setKind(type === 'html' || type === 'htm' ? 'html' : type === 'csv' ? 'csv' : 'text');
        } else {
          object = URL.createObjectURL(blob);
          setObjectUrl(object);
          setKind(type === 'pdf' || ['docx','xlsx','pptx'].includes(type) ? 'pdf' : 'image');
        }
      } catch (reason) {
        if (!controller.signal.aborted) {
          setError({
            message: reason instanceof Error ? reason.message : '文件预览失败',
            code: reason && typeof reason === 'object' && 'code' in reason && typeof reason.code === 'string' ? reason.code : undefined,
          });
          setKind('error');
        }
      }
    })();
    return () => { controller.abort(); if (object) URL.revokeObjectURL(object); };
  }, [taskId, file?.id, file?.revision, file?.name, generation]);
  if (kind === 'empty') return <div className="workspace-preview-empty"><Icon name="file" size={28} /><p>{taskId ? '从“文件”页签选择资料或成果进行预览' : '选择任务后查看文件'}</p></div>;
  if (kind === 'loading') return <div className="workspace-preview-empty"><span className="workspace-preview-spinner" />{['docx','xlsx','pptx'].includes(extension(file?.name ?? '')) ? '正在转换为 PDF，首次打开可能需要一些时间…' : '正在加载预览…'}</div>;
  if (kind === 'error' && error) {
    const capability = error.code === 'PREVIEW_UNSUPPORTED' || error.code === 'PREVIEW_CAPABILITY_UNAVAILABLE';
    return <div role="alert" className="workspace-preview-empty"><Icon name="warning" size={26} /><p>{error.message}</p><div className="flex gap-2">{capability && <button className={control} onClick={onDownload}>下载原件</button>}{!capability && <button className={control} onClick={() => setGeneration(value => value + 1)}>重试</button>}</div></div>;
  }
  if (kind === 'image' && objectUrl) return <div className="workspace-preview-image"><img src={objectUrl} alt={file?.name ?? '图片预览'} /></div>;
  // Chrome 内置 PDF 阅读器在任意 sandbox 属性下都会显示“This page has been blocked by Chrome”。
  // PDF 内容来自已认证接口并按 blob 隔离，HTML 预览仍单独使用 sandbox。
  if (kind === 'pdf' && objectUrl) return <iframe className="workspace-preview-pdf" src={objectUrl} title={`${file?.name ?? '文件'} 预览`} referrerPolicy="no-referrer" />;
  if (kind === 'html') return <iframe className="workspace-preview-html" title={`${file?.name ?? 'HTML'} 预览`} sandbox="" srcDoc={sanitizedHtml(text)} />;
  if (kind === 'csv') return <CsvPreview text={text} />;
  return <article className="message-body workspace-preview-text">{extension(file?.name ?? '') === 'md' ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown> : <pre>{text}</pre>}</article>;
}

function FileRows({ title, rows, selected, onSelect, onDownload }: {
  title: string; rows: Artifact[]; selected: string | null; onSelect: (file: Artifact) => void; onDownload: (file: Artifact) => void;
}) {
  return <section className="workspace-file-section">
    <h3>{title}<span>{rows.length}</span></h3>
    {rows.length === 0 && <p>暂无文件</p>}
    {rows.map(file => <div className={`workspace-file-row ${selected === file.id ? 'is-selected' : ''}`} key={file.id}>
      <button className="workspace-file-main" title={canPreview(file.name) ? `预览 ${file.name}` : `${file.name} 暂不支持预览`} onClick={() => onSelect(file)}>
        <Icon name={fileIcon(file.name)} size={17} /><span><strong>{file.name}</strong><small>版本 {file.revision}{file.knowledgeStatus && ` · ${knowledgeLabel[file.knowledgeStatus]}`}</small></span>
      </button>
      <button className="workspace-file-download" title={`下载 ${file.name}`} aria-label={`下载 ${file.name}`} onClick={() => onDownload(file)}><Icon name="down" size={14} /></button>
    </div>)}
  </section>;
}

export function WorkspaceRightPanel({ taskId, owner, width, onHide }: { taskId: string | null; owner: string; width: number; onHide: () => void }) {
  const savedTab = remembered(owner, taskId, 'tab') as Tab | '';
  const [tab, setTab] = useState<Tab>(isTab(savedTab) ? savedTab : 'files');
  const [uploads, setUploads] = useState<Artifact[]>([]), [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [selectedId, setSelectedId] = useState(() => remembered(owner, taskId, 'version') || null);
  const [versions, setVersions] = useState<Artifact[]>([]), [error, setError] = useState('');
  const [loading, setLoading] = useState(false), defaultApplied = useRef(false);
  const projectKey = `${owner}:${taskId ?? ''}`;

  useEffect(() => {
    const oldTab = remembered(owner, taskId, 'tab') as Tab | '';
    setTab(isTab(oldTab) ? oldTab : 'files');
    setSelectedId(remembered(owner, taskId, 'version') || null);
    setUploads([]); setArtifacts([]); setVersions([]); setError(''); defaultApplied.current = false;
  }, [owner, taskId]);
  useVisiblePolling(async signal => {
    if (!taskId) return;
    try {
      const [files, products] = await Promise.all([
        jsonFetch<{ files: Artifact[] }>(`/api/tasks/${taskId}/files`, { signal }),
        jsonFetch<{ artifacts: Artifact[] }>(`/api/tasks/${taskId}/artifacts`, { signal }),
      ]);
      if (signal.aborted) return;
      setUploads(files.files); setArtifacts(products.artifacts); setError('');
    } catch (reason) {
      if (!signal.aborted) setError(reason instanceof Error ? reason.message : '文件列表加载失败');
    }
  }, 5000, projectKey);
  const all = [...uploads, ...artifacts];
  const selected = [...all, ...versions].find(file => file.id === selectedId) ?? null;

  useEffect(() => {
    if (defaultApplied.current || !taskId || (!uploads.length && !artifacts.length)) return;
    defaultApplied.current = true;
    const rememberedVersion = remembered(owner, taskId, 'version');
    if (rememberedVersion) { setSelectedId(rememberedVersion); setTab('preview'); return; }
    const recent = [...artifacts].reverse().find(file => canPreview(file.name));
    if (recent) {
      setSelectedId(recent.id); setTab('preview');
      remember(owner, taskId, 'version', recent.id); remember(owner, taskId, 'tab', 'preview');
    }
  }, [uploads, artifacts, owner, taskId]);
  useEffect(() => {
    if (!taskId || !selected) { setVersions([]); return; }
    const controller = new AbortController();
    setLoading(true);
    void jsonFetch<{ versions: Artifact[] }>(`/api/tasks/${taskId}/files/${selected.documentId}/versions`, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setVersions(result.versions); })
      .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '版本加载失败'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [taskId, selected?.documentId]);

  const chooseTab = (next: Tab) => { setTab(next); remember(owner, taskId, 'tab', next); };
  const selectFile = (file: Artifact) => {
    setSelectedId(file.id); remember(owner, taskId, 'version', file.id);
    setTab('preview'); remember(owner, taskId, 'tab', 'preview');
  };
  const download = async (file: Artifact) => {
    try {
      const response = await fetch(`/api/tasks/${taskId}/file-versions/${file.id}`, { headers: { Authorization: `Bearer ${getToken() ?? ''}` } });
      if (!response.ok) throw Error('文件下载失败');
      const url = URL.createObjectURL(await response.blob()), link = document.createElement('a');
      link.href = url; link.download = file.name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '下载失败'); }
  };
  const chooseVersion = (id: string) => {
    const version = versions.find(file => file.id === id);
    if (!version) return;
    setSelectedId(version.id); remember(owner, taskId, 'version', version.id);
  };

  return <aside className="workspace-right-workspace" aria-label="工作区右侧面板" style={{ width: `${width}px` }}>
    <header className="workspace-right-tabs">
      <div role="tablist" aria-label="右侧工作区页签">
        {tabs.map(item => <button key={item.id} role="tab" aria-selected={tab === item.id} className={tab === item.id ? 'is-active' : ''} onClick={() => chooseTab(item.id)}>{item.label}</button>)}
      </div>
      <button className="workspace-right-hide" aria-label="隐藏右侧面板" title="隐藏右侧面板" onClick={onHide}><Icon name="panelClose" size={17} /></button>
    </header>
    {error && <p role="alert" className="workspace-right-error">{error}</p>}
    <div className="workspace-right-body">
      <section role="tabpanel" aria-label="预览" hidden={tab !== 'preview'} className="workspace-right-pane workspace-preview-pane">
        {selected && <header className="workspace-preview-header">
          <div><strong>{selected.name}</strong><small>{loading ? '正在读取版本…' : `共 ${versions.length} 个版本`}</small>{selected.hasTextLayer === false && <small className="text-amber-600">无原生文本层，内容可能来自 OCR</small>}{selected.previewGeneratedAt && <small title={`字体包 ${selected.previewFontSha256 ?? ''}`}>派生预览 · 转换器 {selected.previewConverterVersion?.slice(0, 8)} · {new Date(selected.previewGeneratedAt).toLocaleString()}</small>}</div>
          <div><select aria-label="预览版本" value={selected.id} onChange={event => chooseVersion(event.target.value)}>{versions.map(file => <option value={file.id} key={file.id}>版本 {file.revision}{file.current ? '（当前）' : ''}</option>)}</select><button className={control} onClick={() => void download(selected)}>下载</button></div>
        </header>}
        <PreviewSurface taskId={taskId} file={selected} onDownload={() => { if (selected) void download(selected); }} />
      </section>
      <section role="tabpanel" aria-label="文件" hidden={tab !== 'files'} className="workspace-right-pane workspace-files-pane">
        {!taskId && <div className="workspace-preview-empty"><Icon name="folder" size={28} /><p>选择任务后查看资料和成果</p></div>}
        {taskId && <>
          <FileRows title="上传资料" rows={uploads} selected={selectedId} onSelect={selectFile} onDownload={file => void download(file)} />
          <FileRows title="任务成果" rows={artifacts} selected={selectedId} onSelect={selectFile} onDownload={file => void download(file)} />
        </>}
      </section>
      <section role="tabpanel" aria-label="浏览器" hidden={tab !== 'browser'} className="workspace-right-pane workspace-browser-pane">
        <DatabaseBrowser taskId={taskId} width={width} visible={tab === 'browser'} onHide={onHide} onOpened={() => chooseTab('browser')} />
      </section>
    </div>
  </aside>;
}
