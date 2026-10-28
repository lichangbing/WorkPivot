import { useState } from 'react';
import type { MobileClient, Task } from './client';
import { useResource } from './useResource';

interface Fact {
  id: string;
  objectName: string;
  objectType: string;
  predicate: string;
  status: string;
  revision: number | null;
  valueType: string | null;
  valueText: string | null;
  valueNumber: string | null;
  valueDate: string | null;
  valueBoolean: boolean | null;
  valueObjectId: string | null;
  unit: string | null;
  currency: string | null;
  validFrom: string;
  needsReview?: boolean;
}

interface Conflict {
  id: string;
  revision: number;
  objectName: string;
  predicate: string;
  currentRevision: number;
  candidateRevision: number;
  currentType: string;
  currentText: string | null;
  currentNumber: string | null;
  candidateType: string;
  candidateText: string | null;
  candidateNumber: string | null;
  evidence: string | null;
}

interface Data {
  epoch: string;
  facts: Fact[];
  conflicts: Conflict[];
  relations: Array<{
    id: string; subjectId: string; subjectName: string; subjectType: string;
    relationType: string; objectId: string; objectName: string; objectType: string;
    revision: number; needsReview?: boolean;
  }>;
  autoExtraction: boolean;
  settingsRevision: number;
}

function value(row: { valueType?: string | null; valueText: string | null; valueNumber: string | null; valueDate: string | null; valueBoolean: boolean | null; valueObjectId?: string | null; unit?: string | null; currency?: string | null }): string {
  const base = row.valueType === 'text' ? row.valueText
    : row.valueType === 'number' ? row.valueNumber
      : row.valueType === 'date' ? row.valueDate
        : row.valueType === 'boolean' ? (row.valueBoolean ? '是' : '否') : row.valueObjectId;
  return `${base ?? '待确认'}${row.unit ? ` ${row.unit}` : ''}${row.currency ? ` ${row.currency}` : ''}`;
}

export function BusinessFacts({ client, task, onError }: { client: MobileClient; task: Task; onError: (error: unknown) => void }) {
  if (!task.projectId) return <p>业务事实只属于正式项目，临时任务不会生成。</p>;
  const path = `/api/projects/${encodeURIComponent(task.projectId)}/business-facts`;
  const resource = useResource<Data>(client, path, onError, 5000);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await action(); await resource.refresh(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '业务事实操作失败'); onError(reason); }
    finally { setBusy(false); }
  };
  const decide = (row: Conflict, accept: boolean) => run(async () => {
    await client.json(`/api/projects/${encodeURIComponent(task.projectId!)}/business-fact-conflicts/${row.id}/decision`, {
      method: 'POST',
      body: JSON.stringify({ accept, revision: row.revision }),
      signal: resource.signal(),
    });
  });
  const toggle = (enabled: boolean) => run(async () => {
    if (!resource.value) return;
    await client.json('/api/business-facts/settings', {
      method: 'PUT',
      body: JSON.stringify({ enabled, revision: resource.value.settingsRevision }),
      signal: resource.signal(),
    });
  });
  const reviewRelation = (row: Data['relations'][number]) => run(async () => {
    await client.json(`/api/projects/${encodeURIComponent(task.projectId!)}/business-relations`, {
      method: 'POST',
      body: JSON.stringify({
        subject: { id: row.subjectId, name: row.subjectName, type: row.subjectType },
        relationType: row.relationType,
        object: { id: row.objectId, name: row.objectName, type: row.objectType },
      }),
      signal: resource.signal(),
    });
  });
  const data = resource.value;
  return <section className="memory-editor capabilities" aria-label="项目业务事实">
    <p className="muted">业务事实按项目隔离。未确认的更新不会作为当前答案使用。</p>
    {data && <label><input type="checkbox" checked={data.autoExtraction} disabled={busy} onChange={event => void toggle(event.target.checked)} />自动从新对话提取</label>}
    {data?.conflicts[0] && (() => {
      const row = data.conflicts[0]!;
      return <article className="approval memory-card">
        <strong>{row.objectName} · {row.predicate}</strong>
        <p>当前 v{row.currentRevision}：{value({ ...row, valueType: row.currentType, valueText: row.currentText, valueNumber: row.currentNumber, valueDate: null, valueBoolean: null })}</p>
        <p>新候选 v{row.candidateRevision}：{value({ ...row, valueType: row.candidateType, valueText: row.candidateText, valueNumber: row.candidateNumber, valueDate: null, valueBoolean: null })}</p>
        {row.evidence && <details><summary>查看原文证据</summary><p>{row.evidence}</p></details>}
        <button disabled={busy} onClick={() => void decide(row, true)}>采用新值</button>
        <button disabled={busy} onClick={() => void decide(row, false)}>保留当前值</button>
      </article>;
    })()}
    {!data && !resource.error && <p>正在读取业务事实…</p>}
    {data?.facts.map(fact => <article key={fact.id}>
      <strong>{fact.objectName}</strong><small>{fact.objectType} · {fact.status === 'conflicted' ? '待确认更新' : `v${fact.revision}`}</small>
      <p>{fact.predicate}：{fact.status === 'conflicted' ? '等待确认' : value(fact)}</p>
      {fact.needsReview&&<p role="status">来源文件版本已删除，此事实已停止自动召回；请核对后更新。</p>}
    </article>)}
    {data?.relations.length ? <><h3>对象关系</h3>{data.relations.map(row => <div key={row.id}>{row.needsReview && <p role="status">来源文件版本已删除，此关系已停止自动召回。</p>}<p>{row.subjectName} {row.relationType} {row.objectName} · v{row.revision}</p>{row.needsReview && <button disabled={busy} onClick={() => void reviewRelation(row)}>确认仍有效</button>}</div>)}</> : null}
    {data && data.facts.length === 0 && data.conflicts.length === 0 && <p>暂无业务事实。</p>}
    {(error || resource.error) && <p className="error" role="alert">{error || resource.error}</p>}
  </section>;
}
