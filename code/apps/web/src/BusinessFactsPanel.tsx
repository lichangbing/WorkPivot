import { useEffect, useRef, useState } from 'react';
import { jsonFetch } from './api';
import { Icon } from './Icon';

type ValueType = 'text' | 'number' | 'date' | 'boolean' | 'object';

interface Fact {
  id: string;
  objectId: string;
  objectType: string;
  objectName: string;
  predicate: string;
  status: 'active' | 'conflicted';
  revisionId: string | null;
  revision: number | null;
  valueType: ValueType | 'json' | null;
  valueText: string | null;
  valueNumber: string | null;
  valueDate: string | null;
  valueBoolean: boolean | null;
  valueObjectId: string | null;
  valueJson?: unknown;
  unit: string | null;
  currency: string | null;
  validFrom: string;
  validTo: string | null;
  authority: string;
  needsReview?: boolean;
}

interface Conflict {
  id: string;
  revision: number;
  reason: string | null;
  createdAt: string;
  factId: string;
  objectName: string;
  predicate: string;
  currentRevision: number;
  candidateRevision: number;
  currentType: ValueType;
  currentText: string | null;
  currentNumber: string | null;
  candidateType: ValueType;
  candidateText: string | null;
  candidateNumber: string | null;
  evidence: string | null;
}

interface BusinessObject {
  id: string;
  objectType: string;
  name: string;
  status: string;
  revision: number;
  identifiers: Array<{ type: string; value: string; namespace: string }>;
  aliases: string[];
}

interface MergeCandidate {
  sourceId: string;
  targetId: string;
  sourceRevision: number;
  targetRevision: number;
  sourceName: string;
  targetName: string;
  objectType: string;
  score: number;
  reasons: string[];
}

interface EntityMerge {
  id: string;
  status: 'active' | 'reverted';
  revision: number;
  sourceId: string;
  sourceName: string;
  sourceRevision: number;
  targetId: string;
  targetName: string;
  targetRevision: number;
  factCount: number;
  relationCount: number;
  mergedAt: string;
  revertedAt: string | null;
}

interface ImportRecord {
  id: string;
  status: 'draft' | 'confirmed' | 'rejected';
  revision: number;
  versionId: string;
  name: string;
  candidateCount: number;
  createdAt: string;
  decidedAt: string | null;
}

interface TableCandidate {
  ordinal: number;
  objectName: string;
  objectType: string;
  predicate: string;
  valueType: ValueType;
  value: string | number | boolean;
  unit?: string;
  currency?: string;
  dimensions?: Record<string, string>;
  evidence: string;
  location: string;
  row: number;
}

interface FileVersion {
  id: string;
  name: string;
  current?: boolean;
  knowledgeStatus?: string;
}

interface ProjectMember { userId: string; username: string; email: string | null; role: 'owner' | 'editor' | 'reader'; revokedAt: string | null }

interface Relation {
  id: string;
  subjectId: string;
  subjectName: string;
  subjectType: string;
  relationType: string;
  objectId: string;
  objectName: string;
  objectType: string;
  revision: number;
  validFrom: string;
  needsReview?: boolean;
}

interface BusinessData {
  modelKey: 'project.delivery' | 'company.operations';
  model: { label: string; objectTypes: readonly string[]; predicates: readonly string[]; relations: readonly string[] };
  epoch: string;
  facts: Fact[];
  objects: BusinessObject[];
  conflicts: Conflict[];
  relations: Relation[];
  mergeCandidates: MergeCandidate[];
  merges: EntityMerge[];
  imports: ImportRecord[];
  autoExtraction: boolean;
  settingsRevision: number;
}

interface HistoryData {
  id: string;
  predicate: string;
  status: string;
  objectName: string;
  objectType: string;
  revisions: Array<{
    id: string;
    revision: number;
    status: string;
    valueType: ValueType | 'json';
    valueText: string | null;
    valueNumber: string | null;
    valueDate: string | null;
    valueBoolean: boolean | null;
    valueObjectId: string | null;
    valueJson?: unknown;
    unit: string | null;
    currency: string | null;
    validFrom: string;
    validTo: string | null;
    recordedAt: string;
    evidence: Array<{ sourceKind: string; quote: string | null; createdAt: string }>;
  }>;
}

interface ValueForm {
  valueType: ValueType;
  value: string;
  booleanValue: boolean;
  unit: string;
  currency: string;
}

interface CreateForm extends ValueForm {
  objectId: string;
  objectName: string;
  objectType: string;
  identifierType: string;
  identifierValue: string;
  predicate: string;
}

const button = 'rounded border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40';
const input = 'w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-blue-600';

function valueText(value: {
  valueType?: string | null;
  valueText?: string | null;
  valueNumber?: string | null;
  valueDate?: string | null;
  valueBoolean?: boolean | null;
  valueObjectId?: string | null;
  valueJson?: unknown;
  unit?: string | null;
  currency?: string | null;
}): string {
  const base = value.valueType === 'text' ? value.valueText
    : value.valueType === 'number' ? value.valueNumber
      : value.valueType === 'date' ? value.valueDate
        : value.valueType === 'boolean' ? (value.valueBoolean ? '是' : '否')
          : value.valueType === 'object' ? value.valueObjectId
            : JSON.stringify(value.valueJson ?? null);
  return `${base ?? '待确认'}${value.unit ? ` ${value.unit}` : ''}${value.currency ? ` ${value.currency}` : ''}`;
}

export function BusinessFactsPanel({ projectId, taskId, onClose }: { projectId: string; taskId: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [data, setData] = useState<BusinessData | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [relationOpen, setRelationOpen] = useState(false);
  const [entityOpen, setEntityOpen] = useState(false);
  const [entitySource, setEntitySource] = useState('');
  const [entityTarget, setEntityTarget] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [files, setFiles] = useState<FileVersion[]>([]);
  const [importForm, setImportForm] = useState({
    versionId: '',
    subjectColumn: '',
    valueColumn: '',
    identifierColumn: '',
    objectType: 'contract',
    predicate: 'contract.amount.total',
    headerRow: '',
    sheet: '',
    unit: '',
    currency: 'CNY',
  });
  const [preview, setPreview] = useState<{ id: string; revision: number; candidates: TableCandidate[]; name: string } | null>(null);
  const [selectedCandidates, setSelectedCandidates] = useState<number[]>([]);
  const [membersOpen, setMembersOpen] = useState(false);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [memberCandidates, setMemberCandidates] = useState<Array<{ id: string; username: string; email: string | null }>>([]);
  const [canManageMembers, setCanManageMembers] = useState(false);
  const [memberUserId, setMemberUserId] = useState('');
  const [memberRole, setMemberRole] = useState<'editor' | 'reader'>('reader');
  const [editing, setEditing] = useState<Fact | null>(null);
  const [removing, setRemoving] = useState<Fact | null>(null);
  const [removingRelation, setRemovingRelation] = useState<Relation | null>(null);
  const [history, setHistory] = useState<HistoryData | null>(null);
  const [form, setForm] = useState<CreateForm>({
    objectId: '', objectName: '', objectType: 'contract', identifierType: '', identifierValue: '', predicate: 'contract.amount.total',
    valueType: 'number', value: '', booleanValue: true, unit: '', currency: 'CNY',
  });
  const [editForm, setEditForm] = useState<ValueForm>({ valueType: 'text', value: '', booleanValue: true, unit: '', currency: '' });
  const [relationForm, setRelationForm] = useState({ subjectId: '', relationType: 'covers', objectId: '' });
  const endpoint = `/api/projects/${encodeURIComponent(projectId)}/business-facts`;

  const load = async (signal?: AbortSignal) => {
    const value = await jsonFetch<BusinessData>(endpoint + (query.trim() ? `?q=${encodeURIComponent(query.trim())}` : ''), { signal });
    if (!signal?.aborted) setData(value);
  };

  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '业务事实读取失败'); });
    const timer = setInterval(() => {
      if (!document.hidden) void load(controller.signal).catch(() => undefined);
    }, 5000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [endpoint, query]);
  useEffect(() => {
    if (!importOpen) return;
    const controller = new AbortController();
    void jsonFetch<{ files: FileVersion[] }>(`/api/tasks/${encodeURIComponent(taskId)}/files`, { signal: controller.signal })
      .then(result => setFiles(result.files.filter(file => /\.(?:xlsx|docx|csv)$/i.test(file.name))))
      .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '文件列表读取失败'); });
    return () => controller.abort();
  }, [importOpen, taskId]);
  useEffect(() => {
    if (!membersOpen) return;
    const controller = new AbortController();
    void (async () => {
      const result = await jsonFetch<{ canManage: boolean; members: ProjectMember[] }>(`/api/projects/${encodeURIComponent(projectId)}/members`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setCanManageMembers(result.canManage);
      setMembers(result.members);
      if (result.canManage) {
        const candidates = await jsonFetch<{ users: Array<{ id: string; username: string; email: string | null }> }>(`/api/projects/${encodeURIComponent(projectId)}/member-candidates`, { signal: controller.signal });
        if (!controller.signal.aborted) setMemberCandidates(candidates.users);
      }
    })().catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '项目成员读取失败'); });
    return () => controller.abort();
  }, [membersOpen, projectId]);

  const work = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await action();
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '业务事实操作失败');
    } finally { setBusy(false); }
  };

  const saveModel = (modelKey: string) => void work(async () => {
    await jsonFetch(`/api/projects/${encodeURIComponent(projectId)}/business-profile`, { method: 'PUT', body: JSON.stringify({ modelKey }) });
    setNotice('领域模型已更新');
  });

  const saveAutoExtraction = (enabled: boolean) => void work(async () => {
    if (!data) return;
    const settings = await jsonFetch<{ autoExtraction: boolean; revision: number }>('/api/business-facts/settings', {
      method: 'PUT',
      body: JSON.stringify({ enabled, revision: data.settingsRevision }),
    });
    setData({ ...data, autoExtraction: settings.autoExtraction, settingsRevision: settings.revision });
    setNotice(enabled ? '自动提取已开启，下一轮完成对话后生效' : '自动提取已关闭，已有事实不受影响');
  });

  const createFact = () => void work(async () => {
    const value = form.valueType === 'boolean' ? form.booleanValue : form.value;
    const result = await jsonFetch<{ status: string }>(endpoint, {
      method: 'POST',
      body: JSON.stringify({
        object: {
          ...(form.objectId ? { id: form.objectId } : {
            name: form.objectName.trim(),
            type: form.objectType,
            ...(form.identifierType.trim() && form.identifierValue.trim() ? { identifiers: [{ type: form.identifierType.trim(), value: form.identifierValue.trim() }] } : {}),
          }),
        },
        predicate: form.predicate.trim(),
        valueType: form.valueType,
        value,
        ...(form.unit.trim() ? { unit: form.unit.trim() } : {}),
        ...(form.currency.trim() ? { currency: form.currency.trim().toUpperCase() } : {}),
      }),
    });
    setCreateOpen(false);
    setNotice(result.status === 'conflicted' ? '检测到同一事实的新值，已加入待确认更新' : '业务事实已保存');
  });

  const beginEdit = (fact: Fact) => {
    if (!fact.revision || fact.status !== 'active') return;
    const valueType = fact.valueType === 'json' || fact.valueType === null || fact.valueType === 'object' ? 'text' : fact.valueType;
    setEditing(fact); setHistory(null);
    setEditForm({
      valueType,
      value: fact.valueType === 'number' ? fact.valueNumber ?? '' : fact.valueType === 'date' ? fact.valueDate?.slice(0, 10) ?? '' : fact.valueText ?? '',
      booleanValue: fact.valueBoolean ?? true,
      unit: fact.unit ?? '',
      currency: fact.currency ?? '',
    });
  };

  const saveEdit = () => void work(async () => {
    if (!editing?.revision) return;
    await jsonFetch(`${endpoint}/${editing.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        revision: editing.revision,
        valueType: editForm.valueType,
        value: editForm.valueType === 'boolean' ? editForm.booleanValue : editForm.value,
        ...(editForm.unit.trim() ? { unit: editForm.unit.trim() } : {}),
        ...(editForm.currency.trim() ? { currency: editForm.currency.trim().toUpperCase() } : {}),
      }),
    });
    setEditing(null); setNotice('已生成新的业务事实版本');
  });

  const openHistory = (fact: Fact) => void work(async () => {
    setHistory(await jsonFetch<HistoryData>(`${endpoint}/${fact.id}/history`));
  });

  const createRelation = () => void work(async () => {
    const subject = data?.objects.find(item => item.id === relationForm.subjectId);
    const object = data?.objects.find(item => item.id === relationForm.objectId);
    if (!subject || !object) throw Error('请选择关系两端的业务对象');
    await jsonFetch(`/api/projects/${encodeURIComponent(projectId)}/business-relations`, {
      method: 'POST',
      body: JSON.stringify({
        subject: { id: subject.id, name: subject.name, type: subject.objectType },
        relationType: relationForm.relationType.trim(),
        object: { id: object.id, name: object.name, type: object.objectType },
      }),
    });
    setRelationOpen(false); setNotice('业务关系已保存');
  });

  const reviewRelation = (relation: Relation) => void work(async () => {
    await jsonFetch(`/api/projects/${encodeURIComponent(projectId)}/business-relations`, {
      method: 'POST',
      body: JSON.stringify({
        subject: { id: relation.subjectId, name: relation.subjectName, type: relation.subjectType },
        relationType: relation.relationType,
        object: { id: relation.objectId, name: relation.objectName, type: relation.objectType },
      }),
    });
    setNotice('业务关系已由用户重新确认');
  });

  const mergeEntities = (sourceId: string, targetId: string) => {
    const source = data?.objects.find(item => item.id === sourceId);
    const target = data?.objects.find(item => item.id === targetId);
    if (!source || !target) throw Error('请选择要合并的两个业务对象');
    if (source.id === target.id) throw Error('不能把对象合并到自身');
    if (source.objectType !== target.objectType) throw Error('只能合并同一类型的业务对象');
    if (!window.confirm(`将「${source.name}」合并到「${target.name}」？事实、关系和标识会转到目标对象，合并记录可在之后拆回。`)) return;
    return work(async () => {
      await jsonFetch(`/api/projects/${encodeURIComponent(projectId)}/business-entities/${source.id}/merge`, {
        method: 'POST',
        body: JSON.stringify({ targetId: target.id, sourceRevision: source.revision, targetRevision: target.revision }),
      });
      setEntityOpen(false);
      setEntitySource('');
      setEntityTarget('');
      setNotice('实体已合并；可在合并记录中拆回');
    });
  };

  const revertMerge = (merge: EntityMerge) => {
    if (!window.confirm(`把「${merge.sourceName}」从「${merge.targetName}」拆回？移动后新增的事实不会自动猜测归属。`)) return;
    void work(async () => {
      await jsonFetch(`/api/projects/${encodeURIComponent(projectId)}/business-object-merges/${merge.id}/revert`, {
        method: 'POST',
        body: JSON.stringify({
          revision: merge.revision,
          sourceRevision: merge.sourceRevision,
          targetRevision: merge.targetRevision,
        }),
      });
      setNotice('实体已拆回，事实和关系恢复原对象归属');
    });
  };

  const previewImport = () => void work(async () => {
    const result = await jsonFetch<{ id: string; revision: number; candidates: TableCandidate[]; name: string }>(
      `/api/projects/${encodeURIComponent(projectId)}/business-fact-imports/preview`,
      {
        method: 'POST',
        body: JSON.stringify({
          taskId,
          versionId: importForm.versionId,
          subjectColumn: importForm.subjectColumn.trim(),
          valueColumn: importForm.valueColumn.trim(),
          ...(importForm.identifierColumn.trim() ? { identifierColumn: importForm.identifierColumn.trim() } : {}),
          objectType: importForm.objectType.trim(),
          predicate: importForm.predicate.trim(),
          ...(importForm.sheet.trim() ? { sheet: importForm.sheet.trim() } : {}),
          ...(importForm.headerRow.trim() ? { headerRow: Number(importForm.headerRow) } : {}),
          ...(importForm.unit.trim() ? { unit: importForm.unit.trim() } : {}),
          ...(importForm.currency.trim() ? { currency: importForm.currency.trim().toUpperCase() } : {}),
        }),
      },
    );
    setPreview(result);
    setSelectedCandidates(result.candidates.map(candidate => candidate.ordinal));
    setNotice(`已生成 ${result.candidates.length} 条候选事实，请逐条核对后确认`);
  });

  const confirmImport = () => {
    if (!preview || !selectedCandidates.length) return;
    if (!window.confirm(`确认把选中的 ${selectedCandidates.length} 条表格候选写入项目业务事实？`)) return;
    void work(async () => {
      const result = await jsonFetch<{ imported: number }>(`/api/projects/${encodeURIComponent(projectId)}/business-fact-imports/${preview.id}/confirm`, {
        method: 'POST',
        body: JSON.stringify({ revision: preview.revision, selectedOrdinals: selectedCandidates }),
      });
      setPreview(null);
      setSelectedCandidates([]);
      setImportOpen(false);
      setNotice(`已确认导入 ${result.imported} 条业务事实`);
    });
  };

  const rejectImport = () => {
    if (!preview) return;
    void work(async () => {
      await jsonFetch(`/api/projects/${encodeURIComponent(projectId)}/business-fact-imports/${preview.id}/reject`, {
        method: 'POST', body: JSON.stringify({ revision: preview.revision }),
      });
      setPreview(null);
      setSelectedCandidates([]);
      setNotice('本次表格导入候选已拒绝');
    });
  };

  const addMember = () => void work(async () => {
    if (!memberUserId) throw Error('请选择要加入项目的账号');
    await jsonFetch(`/api/projects/${encodeURIComponent(projectId)}/members`, {
      method: 'POST', body: JSON.stringify({ userId: memberUserId, role: memberRole }),
    });
    setMemberUserId('');
    setMembersOpen(false);
    setNotice(memberRole === 'editor' ? '项目编辑成员已添加' : '项目只读成员已添加');
  });

  const removeMember = (member: ProjectMember) => {
    if (!window.confirm(`移除项目成员「${member.username}」？对方将立即失去共享项目事实的访问权限，私人任务不变。`)) return;
    void work(async () => {
      await jsonFetch(`/api/projects/${encodeURIComponent(projectId)}/members/${member.userId}`, { method: 'DELETE' });
      setMembersOpen(false);
      setNotice('项目成员已移除');
    });
  };

  const modelTypes = data?.model.objectTypes ?? ['contract'];
  const modelPredicates = data?.model.predicates ?? [];
  const modelRelations = data?.model.relations ?? [];

  return <dialog ref={dialog} onCancel={event => { if (busy) event.preventDefault(); else onClose(); }} aria-label="项目业务事实" className="m-auto max-h-[90vh] w-[960px] max-w-[96vw] overflow-hidden rounded-xl border border-neutral-700 bg-neutral-950 p-0 text-neutral-100 backdrop:bg-black/60">
    <div className="flex max-h-[90vh] flex-col">
      <header className="flex items-center gap-3 border-b border-neutral-800 px-5 py-4">
        <div className="flex-1"><h2 className="font-semibold">业务事实</h2><p className="mt-1 text-xs text-neutral-500">项目对象、当前事实和不可变版本；跨项目不共享。</p></div>
        {data && <label className="flex items-center gap-1.5 text-xs text-neutral-400"><input type="checkbox" checked={data.autoExtraction} disabled={busy} onChange={event => saveAutoExtraction(event.target.checked)} />自动提取</label>}
        {data && <label className="text-xs text-neutral-400">领域模型<select aria-label="业务事实领域模型" disabled={busy} className="ml-2 rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5" value={data.modelKey} onChange={event => saveModel(event.target.value)}><option value="project.delivery">项目交付</option><option value="company.operations">公司经营</option></select></label>}
        <button className={button} disabled={busy} onClick={() => setMembersOpen(value => !value)}>项目成员</button>
        <button aria-label="关闭业务事实" className="text-neutral-400 hover:text-white" onClick={onClose}><Icon name="close" /></button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {error && <div role="alert" className="mb-3 rounded border border-red-800 bg-red-950/40 px-3 py-2 text-sm text-red-300">{error}</div>}
        {notice && <p role="status" className="mb-3 rounded border border-emerald-800 bg-emerald-950/30 px-3 py-2 text-sm text-emerald-300">{notice}</p>}
        {!data ? <p className="text-neutral-500">正在读取项目业务事实…</p> : <>
          {membersOpen && <section aria-label="项目成员管理" className="mb-5 rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
            <div className="mb-3"><h3 className="font-medium">项目成员</h3><p className="mt-1 text-xs text-neutral-500">成员可读取共享项目与业务事实；私人任务和聊天仍只属于各自账号。</p></div>
            <ul className="space-y-2">{members.filter(member => !member.revokedAt).map(member => <li key={member.userId} className="flex items-center gap-2 rounded bg-neutral-950/60 px-3 py-2 text-sm"><span className="min-w-0 flex-1">{member.username}<span className="ml-2 text-xs text-neutral-500">{member.role === 'owner' ? '所有者' : member.role === 'editor' ? '编辑者' : '只读'}</span>{member.email && <span className="ml-2 text-xs text-neutral-500">{member.email}</span>}</span>{canManageMembers && member.role !== 'owner' && <button className={button} disabled={busy} onClick={() => removeMember(member)}>移除</button>}</li>)}</ul>
            {canManageMembers && <div className="mt-3 flex flex-wrap items-end gap-2"><label className="min-w-48 flex-1 text-xs text-neutral-400">添加账号<select aria-label="添加项目成员" className={input} value={memberUserId} onChange={event => setMemberUserId(event.target.value)}><option value="">选择账号</option>{memberCandidates.map(user => <option key={user.id} value={user.id}>{user.username}{user.email ? ` · ${user.email}` : ''}</option>)}</select></label><label className="text-xs text-neutral-400">权限<select aria-label="项目成员权限" className={input} value={memberRole} onChange={event => setMemberRole(event.target.value as 'editor' | 'reader')}><option value="reader">只读共享事实</option><option value="editor">可维护共享事实</option></select></label><button className={button} disabled={busy || !memberUserId} onClick={addMember}>添加成员</button></div>}
          </section>}
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <div className="relative min-w-52 flex-1"><span className="pointer-events-none absolute left-3 top-2 text-neutral-500"><Icon name="search" /></span><input aria-label="检索业务事实" className={input + ' pl-9'} value={query} onChange={event => setQuery(event.target.value)} placeholder="对象、编号、属性或值" /></div>
            <button className={button} disabled={busy} onClick={() => setCreateOpen(value => !value)}><Icon name="plus" /> 新增事实</button>
            <button className={button} disabled={busy || data.objects.length < 2} onClick={() => setRelationOpen(value => !value)}>新增关系</button>
            <button className={button} disabled={busy || data.objects.length < 2} onClick={() => setEntityOpen(value => !value)}>实体治理</button>
            <button className={button} disabled={busy} onClick={() => { setImportOpen(value => !value); setPreview(null); }}>表格导入</button>
            <span className="text-xs text-neutral-500">Epoch {data.epoch}</span>
          </div>

          {createOpen && <form className="mb-5 grid gap-3 rounded-lg border border-neutral-800 bg-neutral-900/40 p-4 sm:grid-cols-2" onSubmit={event => { event.preventDefault(); createFact(); }}>
            <label className="text-xs text-neutral-400 sm:col-span-2">关联已有对象<select className={input} value={form.objectId} onChange={event => { const selected = data.objects.find(item => item.id === event.target.value); setForm({ ...form, objectId: event.target.value, ...(selected ? { objectName: selected.name, objectType: selected.objectType, identifierType: '', identifierValue: '' } : {}) }); }}><option value="">新建业务对象</option>{data.objects.map(object => <option key={object.id} value={object.id}>{object.name} · {object.objectType}</option>)}</select></label>
            <label className="text-xs text-neutral-400">对象名称<input className={input} required disabled={Boolean(form.objectId)} maxLength={500} value={form.objectName} onChange={event => setForm({ ...form, objectName: event.target.value })} placeholder="例如：合同 HT-001" /></label>
            <label className="text-xs text-neutral-400">对象类型<select className={input} disabled={Boolean(form.objectId)} value={form.objectType} onChange={event => setForm({ ...form, objectType: event.target.value })}>{modelTypes.map(type => <option key={type}>{type}</option>)}</select></label>
            <label className="text-xs text-neutral-400">外部标识类型<input className={input} disabled={Boolean(form.objectId)} value={form.identifierType} onChange={event => setForm({ ...form, identifierType: event.target.value })} placeholder="contract_no（可选）" /></label>
            <label className="text-xs text-neutral-400">外部标识值<input className={input} disabled={Boolean(form.objectId)} value={form.identifierValue} onChange={event => setForm({ ...form, identifierValue: event.target.value })} placeholder="HT-001（可选）" /></label>
            <label className="text-xs text-neutral-400">事实属性<input className={input} required list="business-predicates" value={form.predicate} onChange={event => setForm({ ...form, predicate: event.target.value })} /><datalist id="business-predicates">{modelPredicates.map(value => <option key={value} value={value} />)}</datalist></label>
            <label className="text-xs text-neutral-400">值类型<select className={input} value={form.valueType} onChange={event => setForm({ ...form, valueType: event.target.value as ValueType })}><option value="text">文本</option><option value="number">数值</option><option value="date">日期</option><option value="boolean">布尔</option></select></label>
            <label className="text-xs text-neutral-400">值{form.valueType === 'boolean' ? <select className={input} value={form.booleanValue ? 'true' : 'false'} onChange={event => setForm({ ...form, booleanValue: event.target.value === 'true' })}><option value="true">是</option><option value="false">否</option></select> : <input className={input} required type={form.valueType === 'number' ? 'text' : form.valueType} inputMode={form.valueType === 'number' ? 'decimal' : undefined} value={form.value} onChange={event => setForm({ ...form, value: event.target.value })} />}</label>
            <div className="grid grid-cols-2 gap-2"><label className="text-xs text-neutral-400">单位<input className={input} value={form.unit} onChange={event => setForm({ ...form, unit: event.target.value })} placeholder="可选" /></label><label className="text-xs text-neutral-400">币种<input className={input} maxLength={3} value={form.currency} onChange={event => setForm({ ...form, currency: event.target.value })} placeholder="CNY" /></label></div>
            <div className="flex justify-end gap-2 sm:col-span-2"><button type="button" className={button} onClick={() => setCreateOpen(false)}>取消</button><button className={button} disabled={busy}>保存</button></div>
          </form>}

          {relationOpen && <form className="mb-5 grid gap-3 rounded-lg border border-neutral-800 bg-neutral-900/40 p-4 sm:grid-cols-3" onSubmit={event => { event.preventDefault(); createRelation(); }}>
            <label className="text-xs text-neutral-400">主体<select className={input} value={relationForm.subjectId} required onChange={event => setRelationForm({ ...relationForm, subjectId: event.target.value })}><option value="">请选择</option>{data.objects.map(object => <option key={object.id} value={object.id}>{object.name} · {object.objectType}</option>)}</select></label>
            <label className="text-xs text-neutral-400">关系<input className={input} required list="business-relations" value={relationForm.relationType} onChange={event => setRelationForm({ ...relationForm, relationType: event.target.value })} /><datalist id="business-relations">{modelRelations.map(value => <option key={value} value={value} />)}</datalist></label>
            <label className="text-xs text-neutral-400">对象<select className={input} value={relationForm.objectId} required onChange={event => setRelationForm({ ...relationForm, objectId: event.target.value })}><option value="">请选择</option>{data.objects.map(object => <option key={object.id} value={object.id}>{object.name} · {object.objectType}</option>)}</select></label>
            <div className="flex justify-end gap-2 sm:col-span-3"><button type="button" className={button} onClick={() => setRelationOpen(false)}>取消</button><button className={button} disabled={busy}>保存关系</button></div>
          </form>}

          {importOpen && <section aria-label="表格导入业务事实" className="mb-5 rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
            <div className="mb-3"><h3 className="font-medium">表格导入</h3><p className="mt-1 text-xs text-neutral-500">先选固定文件版本和列名，系统只生成候选；逐条核对来源行后才写入业务事实。</p></div>
            {!preview ? <>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="text-xs text-neutral-400 sm:col-span-2">来源文件<select aria-label="表格导入文件" className={input} value={importForm.versionId} onChange={event => setImportForm({ ...importForm, versionId: event.target.value })}><option value="">请选择当前任务已上传的 XLSX、DOCX 或 CSV</option>{files.map(file => <option key={file.id} value={file.id}>{file.name}{file.current ? '' : '（历史版本）'}</option>)}</select></label>
                <label className="text-xs text-neutral-400">主体列名<input aria-label="主体列名" className={input} value={importForm.subjectColumn} onChange={event => setImportForm({ ...importForm, subjectColumn: event.target.value })} placeholder="例如：客户名称" /></label>
                <label className="text-xs text-neutral-400">值列名<input aria-label="值列名" className={input} value={importForm.valueColumn} onChange={event => setImportForm({ ...importForm, valueColumn: event.target.value })} placeholder="例如：合同金额" /></label>
                <label className="text-xs text-neutral-400">对象类型<input aria-label="导入对象类型" className={input} value={importForm.objectType} onChange={event => setImportForm({ ...importForm, objectType: event.target.value })} /></label>
                <label className="text-xs text-neutral-400">事实属性<input aria-label="导入事实属性" className={input} list="business-predicates" value={importForm.predicate} onChange={event => setImportForm({ ...importForm, predicate: event.target.value })} /></label>
                <label className="text-xs text-neutral-400">唯一标识列<input className={input} value={importForm.identifierColumn} onChange={event => setImportForm({ ...importForm, identifierColumn: event.target.value })} placeholder="可选，例如：合同编号" /></label>
                <label className="text-xs text-neutral-400">表头行号<input className={input} inputMode="numeric" value={importForm.headerRow} onChange={event => setImportForm({ ...importForm, headerRow: event.target.value })} placeholder="自动识别" /></label>
                <label className="text-xs text-neutral-400">工作表<input className={input} value={importForm.sheet} onChange={event => setImportForm({ ...importForm, sheet: event.target.value })} placeholder="Excel 可选；CSV 为 CSV" /></label>
                <label className="text-xs text-neutral-400">单位<input className={input} value={importForm.unit} onChange={event => setImportForm({ ...importForm, unit: event.target.value })} placeholder="例如：万元" /></label>
                <label className="text-xs text-neutral-400">币种<input className={input} maxLength={3} value={importForm.currency} onChange={event => setImportForm({ ...importForm, currency: event.target.value })} /></label>
              </div>
              <div className="mt-3 flex justify-end gap-2"><button className={button} onClick={() => { setImportOpen(false); setPreview(null); }}>取消</button><button className={button} disabled={busy || !importForm.versionId || !importForm.subjectColumn.trim() || !importForm.valueColumn.trim()} onClick={previewImport}>生成候选</button></div>
            </> : <>
              <div className="mb-3 flex flex-wrap items-center gap-2"><p className="flex-1 text-sm">{preview.name} · {preview.candidates.length} 条候选</p><button className={button} onClick={() => setSelectedCandidates(preview.candidates.map(candidate => candidate.ordinal))}>全选</button><button className={button} onClick={() => setSelectedCandidates([])}>全不选</button></div>
              <div className="max-h-80 space-y-2 overflow-y-auto">{preview.candidates.map(candidate => <label key={candidate.ordinal} className="flex gap-2 rounded border border-neutral-800 bg-neutral-950/60 p-2 text-xs"><input aria-label={`候选 ${candidate.ordinal + 1}`} type="checkbox" checked={selectedCandidates.includes(candidate.ordinal)} onChange={event => setSelectedCandidates(values => event.target.checked ? [...new Set([...values, candidate.ordinal])].sort((a, b) => a - b) : values.filter(value => value !== candidate.ordinal))} /><span className="min-w-0 flex-1"><strong>{candidate.objectName}</strong> · {candidate.predicate} = {String(candidate.value)}{candidate.unit ? ` ${candidate.unit}` : ''}{candidate.currency ? ` ${candidate.currency}` : ''}<span className="mt-1 block text-neutral-500">第 {candidate.row} 行 · {candidate.location}</span><span className="mt-1 block text-neutral-500">{candidate.evidence}</span></span></label>)}</div>
              <div className="mt-3 flex justify-end gap-2"><button className={button} disabled={busy} onClick={rejectImport}>拒绝本次候选</button><button className={button} onClick={() => { setPreview(null); setSelectedCandidates([]); }}>返回修改列映射</button><button className={button} disabled={busy || !selectedCandidates.length} onClick={confirmImport}>确认导入 {selectedCandidates.length} 条</button></div>
            </>}
            {data.imports.length > 0 && <div className="mt-3 border-t border-neutral-800 pt-3 text-xs text-neutral-500">最近导入：{data.imports.slice(0, 5).map(item => `${item.name}（${item.status === 'confirmed' ? '已确认' : item.status === 'rejected' ? '已拒绝' : '待确认'}）`).join('；')}</div>}
          </section>}

          {entityOpen && <section aria-label="实体消歧与合并" className="mb-5 rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
            <div className="mb-3 flex items-start gap-3"><div className="flex-1"><h3 className="font-medium">实体消歧</h3><p className="mt-1 text-xs text-neutral-500">名称或别名相似只形成候选，必须人工确认。合并会移动事实、关系和标识，并保留可拆回记录。</p></div></div>
            {data.mergeCandidates.length > 0 && <div className="mb-4 space-y-2">
              {data.mergeCandidates.slice(0, 8).map(candidate => <div key={candidate.sourceId + candidate.targetId} className="flex flex-wrap items-center gap-2 rounded border border-neutral-800 bg-neutral-950/60 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1"><strong>{candidate.sourceName}</strong><span className="mx-2 text-neutral-500">↔</span><strong>{candidate.targetName}</strong><span className="ml-2 text-xs text-neutral-500">{candidate.objectType} · {candidate.score}%</span><span className="mt-1 block text-xs text-neutral-500">{candidate.reasons.join('；')}</span></span>
                <button className={button} disabled={busy} onClick={() => { setEntitySource(candidate.sourceId); setEntityTarget(candidate.targetId); }}>选择候选</button>
              </div>)}
            </div>}
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-xs text-neutral-400">来源对象<select aria-label="合并来源对象" className={input} value={entitySource} onChange={event => setEntitySource(event.target.value)}><option value="">请选择要合并掉的对象</option>{data.objects.map(object => <option key={object.id} value={object.id}>{object.name} · {object.objectType} · r{object.revision}</option>)}</select></label>
              <label className="text-xs text-neutral-400">保留对象<select aria-label="合并目标对象" className={input} value={entityTarget} onChange={event => setEntityTarget(event.target.value)}><option value="">请选择合并后的主对象</option>{data.objects.map(object => <option key={object.id} value={object.id}>{object.name} · {object.objectType} · r{object.revision}</option>)}</select></label>
            </div>
            <div className="mt-3 flex justify-end gap-2"><button className={button} disabled={busy} onClick={() => { setEntitySource(''); setEntityTarget(''); setEntityOpen(false); }}>取消</button><button className={button} disabled={busy || !entitySource || !entityTarget || entitySource === entityTarget} onClick={() => void mergeEntities(entitySource, entityTarget)}>确认合并</button></div>
            {data.merges.some(merge => merge.status === 'active') && <div className="mt-4 border-t border-neutral-800 pt-3"><h4 className="mb-2 text-xs font-medium">已合并，可拆回</h4><div className="space-y-2">{data.merges.filter(merge => merge.status === 'active').map(merge => <div key={merge.id} className="flex flex-wrap items-center gap-2 text-xs"><span className="flex-1">{merge.sourceName} → {merge.targetName}<span className="ml-2 text-neutral-500">{merge.factCount} 条事实 · {merge.relationCount} 条关系</span></span><button className={button} disabled={busy} onClick={() => revertMerge(merge)}>拆回</button></div>)}</div></div>}
          </section>}

          {data.conflicts.length > 0 && (() => {
            const conflict = data.conflicts[0]!;
            return <section aria-label="待确认业务事实更新" className="mb-5 rounded-lg border border-amber-700 bg-amber-950/20 p-4">
              <div className="mb-2 flex items-center gap-2"><span className="text-amber-300"><Icon name="warning" /></span><h3 className="font-medium">待确认更新</h3><span className="ml-auto text-xs text-neutral-500">{data.conflicts.length} 项中的第 1 项</span></div>
              <p className="text-sm"><strong>{conflict.objectName}</strong> · {conflict.predicate}</p>
              <div className="mt-3 grid gap-2 text-sm sm:grid-cols-2"><div className="rounded bg-neutral-900 p-3"><p className="text-xs text-neutral-500">当前 v{conflict.currentRevision}</p><p className="mt-1">{valueText({ valueType: conflict.currentType, valueText: conflict.currentText, valueNumber: conflict.currentNumber })}</p></div><div className="rounded bg-neutral-900 p-3"><p className="text-xs text-neutral-500">新候选 v{conflict.candidateRevision}</p><p className="mt-1">{valueText({ valueType: conflict.candidateType, valueText: conflict.candidateText, valueNumber: conflict.candidateNumber })}</p></div></div>
              {conflict.evidence && <blockquote className="mt-3 border-l-2 border-amber-700 pl-3 text-xs text-neutral-400">{conflict.evidence}</blockquote>}
              <div className="mt-3 flex gap-2"><button className={button} disabled={busy} onClick={() => void work(async () => { await jsonFetch(`/api/projects/${encodeURIComponent(projectId)}/business-fact-conflicts/${conflict.id}/decision`, { method: 'POST', body: JSON.stringify({ accept: true, revision: conflict.revision }) }); setNotice('已采用新值，旧版本保留在历史中'); })}>采用新值</button><button className={button} disabled={busy} onClick={() => void work(async () => { await jsonFetch(`/api/projects/${encodeURIComponent(projectId)}/business-fact-conflicts/${conflict.id}/decision`, { method: 'POST', body: JSON.stringify({ accept: false, revision: conflict.revision }) }); setNotice('已保留当前值，候选值被拒绝'); })}>保留当前值</button></div>
            </section>;
          })()}

          <section aria-label="当前业务事实">
            <div className="mb-2 flex items-center"><h3 className="font-medium">当前事实</h3><span className="ml-2 text-xs text-neutral-500">{data.facts.length} 条</span></div>
            {!data.facts.length && <p className="rounded border border-dashed border-neutral-800 p-5 text-sm text-neutral-500">暂无业务事实。手工新增或在新一轮明确陈述后由后台提取。</p>}
            <div className="space-y-2">{data.facts.map(fact => <article key={fact.id} className="rounded-lg border border-neutral-800 p-3">
              {fact.needsReview && <p role="status" className="mb-2 rounded border border-amber-800 p-2 text-xs text-amber-300">来源文件版本已删除，此事实已停止自动召回；请核对后保存新版本。</p>}
              <div className="flex flex-wrap items-start gap-2"><div className="min-w-0 flex-1"><p className="font-medium">{fact.objectName}<span className="ml-2 text-xs text-neutral-500">{fact.objectType}</span></p><p className="mt-1 text-sm text-neutral-300">{fact.predicate} = {fact.status === 'conflicted' ? '待确认更新' : valueText(fact)}</p><p className="mt-1 text-[11px] text-neutral-500">{fact.revision ? `v${fact.revision}` : '冲突阻塞'} · {fact.authority} · 自 {new Date(fact.validFrom).toLocaleString('zh-CN')}</p></div><div className="flex flex-wrap gap-1.5"><button className={button} disabled={busy || fact.status !== 'active'} onClick={() => openHistory(fact)}>历史</button><button className={button} disabled={busy || fact.status !== 'active'} onClick={() => beginEdit(fact)}>修改</button><button className={button} disabled={busy || fact.status !== 'active'} onClick={() => setRemoving(fact)}>遗忘</button></div></div>
              {editing?.id === fact.id && <form className="mt-3 grid gap-2 rounded bg-neutral-900 p-3 sm:grid-cols-3" onSubmit={event => { event.preventDefault(); saveEdit(); }}><label className="text-xs text-neutral-400">新值<input className={input} required disabled={editForm.valueType === 'boolean'} value={editForm.valueType === 'boolean' ? String(editForm.booleanValue) : editForm.value} onChange={event => setEditForm({ ...editForm, value: event.target.value })} /></label><label className="text-xs text-neutral-400">单位<input className={input} value={editForm.unit} onChange={event => setEditForm({ ...editForm, unit: event.target.value })} /></label><label className="text-xs text-neutral-400">币种<input className={input} maxLength={3} value={editForm.currency} onChange={event => setEditForm({ ...editForm, currency: event.target.value })} /></label><div className="flex justify-end gap-2 sm:col-span-3"><button type="button" className={button} onClick={() => setEditing(null)}>取消</button><button className={button} disabled={busy}>保存新版本</button></div></form>}
              {removing?.id === fact.id && <div role="alertdialog" className="mt-3 rounded border border-red-900 bg-red-950/30 p-3 text-sm"><p>遗忘后该事实不再进入搜索和自动上下文，历史仍保留用于审计。确认遗忘？</p><div className="mt-2 flex gap-2"><button className={button} disabled={busy} onClick={() => void work(async () => { await jsonFetch(`${endpoint}/${fact.id}`, { method: 'DELETE', body: JSON.stringify({ revision: fact.revision }) }); setRemoving(null); setNotice('事实已退出项目检索'); })}>确认遗忘</button><button className={button} onClick={() => setRemoving(null)}>取消</button></div></div>}
              {history?.id === fact.id && <div className="mt-3 rounded border border-neutral-700 bg-neutral-900/60 p-3"><div className="mb-2 flex items-center"><h4 className="text-xs font-medium">版本与证据</h4><button className="ml-auto text-neutral-500" onClick={() => setHistory(null)}><Icon name="close" /></button></div><ol className="space-y-2">{history.revisions.map(revision => <li key={revision.id} className="rounded border border-neutral-800 p-2 text-xs"><p><strong>v{revision.revision} · {revision.status}</strong> · {valueText(revision)}</p><p className="mt-1 text-neutral-500">有效 {new Date(revision.validFrom).toLocaleString('zh-CN')} → {revision.validTo ? new Date(revision.validTo).toLocaleString('zh-CN') : '现在'}</p>{revision.evidence.map((evidence, index) => <blockquote key={index} className="mt-2 border-l-2 border-neutral-700 pl-2 text-neutral-400">{evidence.quote ?? `来源：${evidence.sourceKind}`}</blockquote>)}</li>)}</ol></div>}
            </article>)}</div>
          </section>

          <section aria-label="业务关系" className="mt-5 border-t border-neutral-800 pt-4">
            <h3 className="mb-2 font-medium">对象关系</h3>
            {!data.relations.length ? <p className="text-sm text-neutral-500">暂无已确认关系。</p> : <ul className="space-y-2">{data.relations.map(relation => <li key={relation.id} className="rounded border border-neutral-800 px-3 py-2 text-sm">{relation.needsReview && <p role="status" className="mb-2 rounded border border-amber-800 p-2 text-xs text-amber-300">来源文件版本已删除，此关系已停止自动召回；请核对后重新确认。</p>}{relation.subjectName} <span className="text-blue-300">{relation.relationType}</span> {relation.objectName}<span className="ml-2 text-xs text-neutral-500">v{relation.revision}</span>{relation.needsReview && <button className="ml-3 text-xs text-amber-300" disabled={busy} onClick={() => reviewRelation(relation)}>确认仍有效</button>}<button className="ml-3 text-xs text-red-400" disabled={busy} onClick={() => setRemovingRelation(relation)}>撤销</button>{removingRelation?.id === relation.id && <span className="ml-2 text-xs"><button className="text-red-400" disabled={busy} onClick={() => void work(async () => { await jsonFetch(`/api/projects/${encodeURIComponent(projectId)}/business-relations/${relation.id}`, { method: 'DELETE', body: JSON.stringify({ revision: relation.revision }) }); setRemovingRelation(null); setNotice('业务关系已撤销'); })}>确认撤销</button><button className="ml-2" onClick={() => setRemovingRelation(null)}>取消</button></span>}</li>)}</ul>}
          </section>
        </>}
      </div>
    </div>
  </dialog>;
}
