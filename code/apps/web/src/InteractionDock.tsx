import { useState } from 'react';
import type {
  ClarificationAnswer,
  ClarificationPayload,
  InteractionEnvelope,
  InteractionResponse,
  PlanApprovalPayload,
  ArtifactReviewPayload,
} from '@workpivot/shared';
import { Icon } from './Icon';

const riskLabel = { low: '低风险', medium: '需留意', high: '高风险' } as const;
const riskClass = {
  low: 'border-emerald-800 bg-emerald-950/30 text-emerald-300',
  medium: 'border-amber-800 bg-amber-950/30 text-amber-300',
  high: 'border-red-800 bg-red-950/30 text-red-300',
} as const;

function Section({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return <div><dt className="text-xs text-neutral-500">{title}</dt><dd className="mt-1 space-y-1 text-sm leading-6 text-neutral-300">{items.map((item, index) => <p key={`${item}-${index}`}>· {item}</p>)}</dd></div>;
}

function Clarification({ interaction, busy, submit }: { interaction: InteractionEnvelope; busy: boolean; submit: (value: InteractionResponse) => Promise<void> }) {
  const payload = interaction.payload as ClarificationPayload;
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [freeText, setFreeText] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const toggle = (questionId: string, label: string, multiple: boolean) => {
    setSelected((current) => {
      const rows = current[questionId] ?? [];
      const next = multiple ? rows.includes(label) ? rows.filter(value => value !== label) : [...rows, label] : [label];
      return { ...current, [questionId]: next };
    });
  };
  const send = async () => {
    setError('');
    const answers: ClarificationAnswer[] = [];
    for (const question of payload.questions) {
      const value = selected[question.id] ?? [];
      const other = freeText[question.id]?.trim();
      if (!value.length && !other) { setError(`请回答“${question.question}”`); return; }
      answers.push({ questionId: question.id, value: value.length ? value : [other!] });
    }
    await submit({ answers });
  };
  return <>
    <div className="divide-y divide-neutral-800 border-y border-neutral-800">
      {payload.questions.map((question, questionIndex) => <section className="px-4 py-4" key={question.id}>
        <p className="text-sm font-medium leading-6 text-neutral-100">{questionIndex + 1}. {question.question}</p>
        <p className="mt-1 text-xs text-neutral-500">{question.multiSelect ? '可多选' : '单选'}{question.allowFreeText ? '，也可填写其他答案' : ''}</p>
        {!!question.options.length && <div className="mt-3 grid gap-2">
          {question.options.map((option) => {
            const active = (selected[question.id] ?? []).includes(option.label);
            return <button key={option.label} type="button" aria-pressed={active} disabled={busy} onClick={() => toggle(question.id, option.label, question.multiSelect)} className={`rounded-xl border px-3 py-2.5 text-left transition ${active ? 'border-blue-600 bg-blue-950/40' : 'border-neutral-700 bg-neutral-950/30 hover:border-neutral-600 hover:bg-neutral-900'} disabled:opacity-40`}>
              <span className="flex items-start gap-2"><span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border border-neutral-600 text-xs">{active ? <Icon name="check" size={12} /> : option.recommended ? '荐' : ''}</span><span className="min-w-0 flex-1"><span className="block text-sm text-neutral-100">{option.label}{option.recommended ? ' · 推荐' : ''}</span>{option.description && <span className="mt-0.5 block text-xs leading-5 text-neutral-500">{option.description}</span>}{option.preview && <details className="mt-1.5 text-xs text-neutral-500"><summary className="cursor-pointer">查看预览</summary><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-neutral-950 p-2 text-neutral-400">{option.preview}</pre></details>}</span></span>
            </button>;
          })}
        </div>}
        {question.allowFreeText && <label className="mt-3 block text-xs text-neutral-500">其他补充<input className="mt-1.5 w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-blue-600" disabled={busy} maxLength={500} value={freeText[question.id] ?? ''} onChange={event => setFreeText(current => ({ ...current, [question.id]: event.target.value }))} /></label>}
      </section>)}
    </div>
    {error && <p role="alert" className="px-4 pt-3 text-sm text-red-400">{error}</p>}
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <span className="text-xs text-neutral-500">回答会同步到已连接设备。</span>
      <button type="button" disabled={busy} onClick={() => void send()} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-40">{busy ? '正在提交…' : '提交回答'}</button>
    </div>
  </>;
}

function PlanReview({ plan }: { plan: PlanApprovalPayload['plan'] }) {
  return <dl className="grid gap-3 px-4 py-4 sm:grid-cols-2">
    <div className="sm:col-span-2"><dt className="text-xs text-neutral-500">目标</dt><dd className="mt-1 text-sm leading-6 text-neutral-100">{plan.goal}</dd></div>
    <Section title="读取范围" items={plan.dataScope} />
    <Section title="业务规则" items={plan.businessRules} />
    <Section title="执行步骤" items={plan.steps.map(step => `${step.status === 'completed' ? '已完成' : step.status === 'in_progress' ? '进行中' : '待执行'} · ${step.step}`)} />
    <Section title="外部动作" items={plan.externalActions} />
    <Section title="预期成果" items={plan.outputs} />
    <Section title="风险" items={plan.risks} />
    <Section title="验收方式" items={plan.verification} />
  </dl>;
}

interface EditablePlan {
  goal: string;
  assumptions: string;
  dataScope: string;
  businessRules: string;
  steps: string;
  externalActions: string;
  outputs: string;
  risks: string;
  verification: string;
}

function PlanEditor({ value, onChange }: { value: EditablePlan; onChange: (value: EditablePlan) => void }) {
  const field = (key: keyof EditablePlan, label: string, rows = 2) => <label className="text-xs text-neutral-500">{label}<textarea rows={rows} value={value[key]} onChange={event => onChange({ ...value, [key]: event.target.value })} className="mt-1.5 w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm leading-6 text-neutral-100 outline-none focus:border-blue-600" /></label>;
  return <div className="grid gap-3 border-y border-neutral-800 px-4 py-4 sm:grid-cols-2">
    <div className="sm:col-span-2">{field('goal', '目标')}</div>
    {field('dataScope', '读取范围（每行一项）')}
    {field('businessRules', '业务规则（每行一项）')}
    {field('steps', '执行步骤（每行一步）')}
    {field('externalActions', '外部动作（每行一项）')}
    {field('outputs', '预期成果（每行一项）')}
    {field('risks', '风险（每行一项）')}
    {field('verification', '验收方式（每行一项）')}
    {field('assumptions', '假设（每行一项）')}
  </div>;
}

function Decision({ interaction, busy, submit }: { interaction: InteractionEnvelope; busy: boolean; submit: (value: InteractionResponse) => Promise<void> }) {
  const [feedback, setFeedback] = useState('');
  const [showFeedback, setShowFeedback] = useState(false);
  const [error, setError] = useState('');
  const planPayload = interaction.kind === 'plan_approval' && 'plan' in interaction.payload ? interaction.payload.plan : null;
  const [editable, setEditable] = useState<EditablePlan | null>(() => planPayload ? {
    goal: planPayload.goal,
    assumptions: planPayload.assumptions.join('\n'),
    dataScope: planPayload.dataScope.join('\n'),
    businessRules: planPayload.businessRules.join('\n'),
    steps: planPayload.steps.map(step => step.step).join('\n'),
    externalActions: planPayload.externalActions.join('\n'),
    outputs: planPayload.outputs.join('\n'),
    risks: planPayload.risks.join('\n'),
    verification: planPayload.verification.join('\n'),
  } : null);
  const [editingPlan, setEditingPlan] = useState(false);
  const decide = async (decision: 'approve' | 'deny') => {
    if (decision === 'deny' && interaction.kind === 'artifact_review' && !feedback.trim()) {
      setShowFeedback(true);
      setError('退回成果时请填写具体原因。');
      return;
    }
    setError('');
    await submit({ decision, ...(feedback.trim() ? { feedback: feedback.trim() } : {}) });
  };
  const modifyPlan = async () => {
    if (!planPayload || !editable) return;
    const lines = (value: string) => value.split('\n').map(item => item.trim()).filter(Boolean);
    await submit({
      decision: 'deny',
      feedback: '用户在界面中修改了计划，请读取修改版后重新发起计划与动作确认。',
      plan: {
        ...planPayload,
        goal: editable.goal.trim(),
        assumptions: lines(editable.assumptions),
        dataScope: lines(editable.dataScope),
        businessRules: lines(editable.businessRules),
        steps: lines(editable.steps).map((step, index) => ({ step, status: planPayload.steps[index]?.status ?? 'pending' })),
        externalActions: lines(editable.externalActions),
        outputs: lines(editable.outputs),
        risks: lines(editable.risks),
        verification: lines(editable.verification),
      },
    });
  };
  const payload = interaction.payload;
  return <>
    {interaction.kind === 'plan_approval' && planPayload && (editingPlan && editable ? <PlanEditor value={editable} onChange={setEditable} /> : <PlanReview plan={planPayload} />)}
    {interaction.kind === 'action_permission' && 'tool' in payload && <div className="space-y-3 border-y border-neutral-800 px-4 py-4 text-sm">
      <div className="flex flex-wrap items-center gap-2"><span className="font-medium text-neutral-100">{payload.tool}</span><span className={`rounded-full border px-2 py-0.5 text-[10px] ${riskClass[payload.risk]}`}>{riskLabel[payload.risk]}</span></div>
      <p className="leading-6 text-neutral-300">{payload.summary}</p>
      {payload.command && <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-neutral-800 bg-neutral-950 p-3 text-xs text-neutral-400">{payload.command}</pre>}
      {payload.arguments && <details className="text-xs text-neutral-500"><summary className="cursor-pointer">查看参数与影响</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-neutral-950 p-3 text-[11px] text-neutral-400">{JSON.stringify(payload.arguments, null, 2)}</pre></details>}
    </div>}
    {interaction.kind === 'artifact_review' && 'artifacts' in payload && <div className="border-y border-neutral-800 px-4 py-4">
      <p className="text-xs text-neutral-500">机器核验</p>
      <p className="mt-1 text-sm text-neutral-200">{payload.machineVerified ? '成果已登记并通过基础完整性检查' : '成果仍需机器核验'}</p>
      <ul className="mt-3 space-y-2">{(payload as ArtifactReviewPayload).artifacts.map(artifact => <li key={artifact.id} className="rounded-lg border border-neutral-800 px-3 py-2 text-sm text-neutral-200"><Icon name="file" size={14} /> {artifact.name}</li>)}</ul>
      {!!payload.verificationNotes.length && <ul className="mt-3 text-xs leading-5 text-neutral-500">{payload.verificationNotes.map(note => <li key={note}>· {note}</li>)}</ul>}
    </div>}
    {showFeedback && <label className="mx-4 mt-3 block text-xs text-neutral-400">反馈原因<textarea autoFocus maxLength={2000} value={feedback} disabled={busy} onChange={event => setFeedback(event.target.value)} className="mt-1.5 min-h-24 w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-blue-600" placeholder="请说明需要修改的内容或拒绝原因，Agent 会据此调整方案。" /></label>}
    {error && <p role="alert" className="px-4 pt-3 text-sm text-red-400">{error}</p>}
    <div className="flex flex-wrap justify-end gap-2 px-4 py-3">
      {planPayload && <button type="button" disabled={busy} onClick={() => setEditingPlan(value => !value)} className="rounded-lg border border-neutral-700 px-3 py-2 text-sm text-neutral-300 hover:bg-neutral-800 disabled:opacity-40">{editingPlan ? '取消修改' : '修改计划'}</button>}
      <button type="button" disabled={busy} onClick={() => setShowFeedback(value => !value)} className="rounded-lg border border-neutral-700 px-3 py-2 text-sm text-neutral-300 hover:bg-neutral-800 disabled:opacity-40">{showFeedback ? '收起反馈' : '填写反馈'}</button>
      <button type="button" disabled={busy} onClick={() => void decide('deny')} className="rounded-lg border border-red-800 bg-red-950/30 px-3 py-2 text-sm text-red-300 hover:bg-red-950/50 disabled:opacity-40">{interaction.kind === 'artifact_review' ? '退回修改' : '拒绝'}</button>
      <button type="button" disabled={busy || (editingPlan && (!editable?.goal.trim() || !editable.dataScope.trim() || !editable.steps.trim() || !editable.outputs.trim() || !editable.verification.trim()))} onClick={() => void (editingPlan ? modifyPlan() : decide('approve'))} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-40">{busy ? '处理中…' : editingPlan ? '保存计划修改' : interaction.kind === 'plan_approval' ? '批准计划' : interaction.kind === 'artifact_review' ? '验收通过' : '允许本次'}</button>
    </div>
  </>;
}

export function InteractionDock({ interaction, busy = false, queued = 0, onRespond }: {
  interaction: InteractionEnvelope;
  busy?: boolean;
  queued?: number;
  onRespond: (response: InteractionResponse) => Promise<void>;
}) {
  const kindLabel = { clarification: '需求澄清', plan_approval: '计划审批', action_permission: '动作授权', artifact_review: '成果验收' }[interaction.kind];
  return <section aria-label={kindLabel} data-interaction={interaction.id} data-kind={interaction.kind} className="mx-4 mb-2 overflow-hidden rounded-xl border border-neutral-700 bg-neutral-900 shadow-[0_12px_32px_rgba(0,0,0,0.18)]">
    <div className="flex items-start gap-3 px-4 pb-3 pt-4">
      <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ${riskClass[interaction.risk]}`}><Icon name={interaction.kind === 'action_permission' ? 'shield' : 'bot'} size={17} /></span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-neutral-500">{kindLabel}</span>
          <span className={`rounded-full border px-2 py-0.5 text-[10px] ${riskClass[interaction.risk]}`}>{riskLabel[interaction.risk]}</span>
          {queued > 0 && <span className="rounded-full border border-neutral-700 px-2 py-0.5 text-[10px] text-neutral-500">后面还有 {queued} 项</span>}
        </div>
        <p className="mt-1 text-sm leading-6 text-neutral-100">{interaction.reason}</p>
      </div>
    </div>
    {interaction.kind === 'clarification' ? <Clarification interaction={interaction} busy={busy} submit={onRespond} /> : <Decision interaction={interaction} busy={busy} submit={onRespond} />}
    <p className="border-t border-neutral-800 bg-neutral-950/40 px-4 py-2 text-[11px] text-neutral-500">等待状态可跨设备恢复；请在 {new Date(interaction.expiresAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })} 前处理。</p>
  </section>;
}
