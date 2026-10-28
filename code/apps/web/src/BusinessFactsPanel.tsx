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
  identifiers: Array<{ type: string; value: string; namespace: string }>;
  aliases: string[];
}

interface Relation {
  id: string;
  subjectId: string;
  subjectName: string;
  relationType: string;
  objectId: string;
  objectName: string;
  revision: number;
  validFrom: string;
}

interface BusinessData {
  modelKey: 'project.delivery' | 'company.operations';
  model: { label: string; objectTypes: readonly string[]; predicates: readonly string[]; relations: readonly string[] };
  epoch: string;
  facts: Fact[];
  objects: BusinessObject[];
  conflicts: Conflict[];
  relations: Relation[];
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

export function BusinessFactsPanel({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [data, setData] = useState<BusinessData | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [relationOpen, setRelationOpen] = useState(false);
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

  const modelTypes = data?.model.objectTypes ?? ['contract'];
  const modelPredicates = data?.model.predicates ?? [];
  const modelRelations = data?.model.relations ?? [];

  return <dialog ref={dialog} onCancel={event => { if (busy) event.preventDefault(); else onClose(); }} aria-label="项目业务事实" className="m-auto max-h-[90vh] w-[960px] max-w-[96vw] overflow-hidden rounded-xl border border-neutral-700 bg-neutral-950 p-0 text-neutral-100 backdrop:bg-black/60">
    <div className="flex max-h-[90vh] flex-col">
      <header className="flex items-center gap-3 border-b border-neutral-800 px-5 py-4">
        <div className="flex-1"><h2 className="font-semibold">业务事实</h2><p className="mt-1 text-xs text-neutral-500">项目对象、当前事实和不可变版本；跨项目不共享。</p></div>
        {data && <label className="flex items-center gap-1.5 text-xs text-neutral-400"><input type="checkbox" checked={data.autoExtraction} disabled={busy} onChange={event => saveAutoExtraction(event.target.checked)} />自动提取</label>}
        {data && <label className="text-xs text-neutral-400">领域模型<select aria-label="业务事实领域模型" disabled={busy} className="ml-2 rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5" value={data.modelKey} onChange={event => saveModel(event.target.value)}><option value="project.delivery">项目交付</option><option value="company.operations">公司经营</option></select></label>}
        <button aria-label="关闭业务事实" className="text-neutral-400 hover:text-white" onClick={onClose}><Icon name="close" /></button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {error && <div role="alert" className="mb-3 rounded border border-red-800 bg-red-950/40 px-3 py-2 text-sm text-red-300">{error}</div>}
        {notice && <p role="status" className="mb-3 rounded border border-emerald-800 bg-emerald-950/30 px-3 py-2 text-sm text-emerald-300">{notice}</p>}
        {!data ? <p className="text-neutral-500">正在读取项目业务事实…</p> : <>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <div className="relative min-w-52 flex-1"><span className="pointer-events-none absolute left-3 top-2 text-neutral-500"><Icon name="search" /></span><input aria-label="检索业务事实" className={input + ' pl-9'} value={query} onChange={event => setQuery(event.target.value)} placeholder="对象、编号、属性或值" /></div>
            <button className={button} disabled={busy} onClick={() => setCreateOpen(value => !value)}><Icon name="plus" /> 新增事实</button>
            <button className={button} disabled={busy || data.objects.length < 2} onClick={() => setRelationOpen(value => !value)}>新增关系</button>
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
              <div className="flex flex-wrap items-start gap-2"><div className="min-w-0 flex-1"><p className="font-medium">{fact.objectName}<span className="ml-2 text-xs text-neutral-500">{fact.objectType}</span></p><p className="mt-1 text-sm text-neutral-300">{fact.predicate} = {fact.status === 'conflicted' ? '待确认更新' : valueText(fact)}</p><p className="mt-1 text-[11px] text-neutral-500">{fact.revision ? `v${fact.revision}` : '冲突阻塞'} · {fact.authority} · 自 {new Date(fact.validFrom).toLocaleString('zh-CN')}</p></div><div className="flex flex-wrap gap-1.5"><button className={button} disabled={busy || fact.status !== 'active'} onClick={() => openHistory(fact)}>历史</button><button className={button} disabled={busy || fact.status !== 'active'} onClick={() => beginEdit(fact)}>修改</button><button className={button} disabled={busy || fact.status !== 'active'} onClick={() => setRemoving(fact)}>遗忘</button></div></div>
              {editing?.id === fact.id && <form className="mt-3 grid gap-2 rounded bg-neutral-900 p-3 sm:grid-cols-3" onSubmit={event => { event.preventDefault(); saveEdit(); }}><label className="text-xs text-neutral-400">新值<input className={input} required disabled={editForm.valueType === 'boolean'} value={editForm.valueType === 'boolean' ? String(editForm.booleanValue) : editForm.value} onChange={event => setEditForm({ ...editForm, value: event.target.value })} /></label><label className="text-xs text-neutral-400">单位<input className={input} value={editForm.unit} onChange={event => setEditForm({ ...editForm, unit: event.target.value })} /></label><label className="text-xs text-neutral-400">币种<input className={input} maxLength={3} value={editForm.currency} onChange={event => setEditForm({ ...editForm, currency: event.target.value })} /></label><div className="flex justify-end gap-2 sm:col-span-3"><button type="button" className={button} onClick={() => setEditing(null)}>取消</button><button className={button} disabled={busy}>保存新版本</button></div></form>}
              {removing?.id === fact.id && <div role="alertdialog" className="mt-3 rounded border border-red-900 bg-red-950/30 p-3 text-sm"><p>遗忘后该事实不再进入搜索和自动上下文，历史仍保留用于审计。确认遗忘？</p><div className="mt-2 flex gap-2"><button className={button} disabled={busy} onClick={() => void work(async () => { await jsonFetch(`${endpoint}/${fact.id}`, { method: 'DELETE', body: JSON.stringify({ revision: fact.revision }) }); setRemoving(null); setNotice('事实已退出项目检索'); })}>确认遗忘</button><button className={button} onClick={() => setRemoving(null)}>取消</button></div></div>}
              {history?.id === fact.id && <div className="mt-3 rounded border border-neutral-700 bg-neutral-900/60 p-3"><div className="mb-2 flex items-center"><h4 className="text-xs font-medium">版本与证据</h4><button className="ml-auto text-neutral-500" onClick={() => setHistory(null)}><Icon name="close" /></button></div><ol className="space-y-2">{history.revisions.map(revision => <li key={revision.id} className="rounded border border-neutral-800 p-2 text-xs"><p><strong>v{revision.revision} · {revision.status}</strong> · {valueText(revision)}</p><p className="mt-1 text-neutral-500">有效 {new Date(revision.validFrom).toLocaleString('zh-CN')} → {revision.validTo ? new Date(revision.validTo).toLocaleString('zh-CN') : '现在'}</p>{revision.evidence.map((evidence, index) => <blockquote key={index} className="mt-2 border-l-2 border-neutral-700 pl-2 text-neutral-400">{evidence.quote ?? `来源：${evidence.sourceKind}`}</blockquote>)}</li>)}</ol></div>}
            </article>)}</div>
          </section>

          <section aria-label="业务关系" className="mt-5 border-t border-neutral-800 pt-4">
            <h3 className="mb-2 font-medium">对象关系</h3>
            {!data.relations.length ? <p className="text-sm text-neutral-500">暂无已确认关系。</p> : <ul className="space-y-2">{data.relations.map(relation => <li key={relation.id} className="rounded border border-neutral-800 px-3 py-2 text-sm">{relation.subjectName} <span className="text-blue-300">{relation.relationType}</span> {relation.objectName}<span className="ml-2 text-xs text-neutral-500">v{relation.revision}</span><button className="ml-3 text-xs text-red-400" disabled={busy} onClick={() => setRemovingRelation(relation)}>撤销</button>{removingRelation?.id === relation.id && <span className="ml-2 text-xs"><button className="text-red-400" disabled={busy} onClick={() => void work(async () => { await jsonFetch(`/api/projects/${encodeURIComponent(projectId)}/business-relations/${relation.id}`, { method: 'DELETE', body: JSON.stringify({ revision: relation.revision }) }); setRemovingRelation(null); setNotice('业务关系已撤销'); })}>确认撤销</button><button className="ml-2" onClick={() => setRemovingRelation(null)}>取消</button></span>}</li>)}</ul>}
          </section>
        </>}
      </div>
    </div>
  </dialog>;
}
