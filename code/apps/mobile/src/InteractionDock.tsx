import { useState } from 'react';
import type {
  ClarificationAnswer,
  ClarificationPayload,
  InteractionEnvelope,
  InteractionResponse,
  PlanApprovalPayload,
} from '@workpivot/shared';

const labels = { low: '低风险', medium: '需留意', high: '高风险' } as const;

function Clarification({ payload, busy, submit }: { payload: ClarificationPayload; busy: boolean; submit: (response: InteractionResponse) => Promise<void> }) {
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [free, setFree] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const choose = (id: string, label: string, multiple: boolean) => setSelected(current => {
    const values = current[id] ?? [];
    return { ...current, [id]: multiple ? values.includes(label) ? values.filter(value => value !== label) : [...values, label] : [label] };
  });
  const send = async () => {
    const answers: ClarificationAnswer[] = [];
    for (const question of payload.questions) {
      const value = selected[question.id] ?? [];
      const other = free[question.id]?.trim();
      if (!value.length && !other) { setError(`请回答“${question.question}”`); return; }
      answers.push({ questionId: question.id, value: value.length ? value : [other!] });
    }
    setError('');
    await submit({ answers });
  };
  return <>
    {payload.questions.map((question, index) => <section className="approval-question" key={question.id}>
      <strong>{index + 1}. {question.question}</strong>
      <small>{question.multiSelect ? '可多选' : '单选'}{question.allowFreeText ? '，也可填写其他答案' : ''}</small>
      {question.options.map(option => {
        const active = (selected[question.id] ?? []).includes(option.label);
        return <button type="button" className={active ? 'selected' : ''} aria-pressed={active} disabled={busy} key={option.label} onClick={() => choose(question.id, option.label, question.multiSelect)}>
          <span>{active ? '✓ ' : ''}{option.label}{option.recommended ? ' · 推荐' : ''}</span>
          {option.description && <small>{option.description}</small>}
          {option.preview && <details><summary>查看预览</summary><pre>{option.preview}</pre></details>}
        </button>;
      })}
      {question.allowFreeText && <input aria-label={`${question.question}的其他回答`} maxLength={500} value={free[question.id] ?? ''} disabled={busy} placeholder="其他补充" onChange={event => setFree(current => ({ ...current, [question.id]: event.target.value }))} />}
    </section>)}
    {error && <p className="error" role="alert">{error}</p>}
    <button className="primary" disabled={busy} onClick={() => void send()}>{busy ? '正在提交…' : '提交回答'}</button>
  </>;
}

function Plan({ plan }: { plan: PlanApprovalPayload['plan'] }) {
  return <div className="approval-detail">
    <p><strong>目标</strong><br />{plan.goal}</p>
    {!!plan.dataScope.length && <p><strong>读取范围</strong><br />{plan.dataScope.join('、')}</p>}
    {!!plan.businessRules.length && <p><strong>业务规则</strong><br />{plan.businessRules.join('；')}</p>}
    <p><strong>执行步骤</strong></p><ol>{plan.steps.map(step => <li key={step.step}>{step.step}</li>)}</ol>
    {!!plan.externalActions.length && <p><strong>外部动作</strong><br />{plan.externalActions.join('；')}</p>}
    <p><strong>预期成果</strong><br />{plan.outputs.join('、')}</p>
    {!!plan.risks.length && <p><strong>风险</strong><br />{plan.risks.join('；')}</p>}
    <p><strong>验收方式</strong><br />{plan.verification.join('；')}</p>
  </div>;
}

function Decision({ interaction, busy, submit }: { interaction: InteractionEnvelope; busy: boolean; submit: (response: InteractionResponse) => Promise<void> }) {
  const [feedback, setFeedback] = useState('');
  const [showFeedback, setShowFeedback] = useState(false);
  const [error, setError] = useState('');
  const planPayload = interaction.kind === 'plan_approval' && 'plan' in interaction.payload ? interaction.payload.plan : null;
  const [editingPlan, setEditingPlan] = useState(false);
  const [goal, setGoal] = useState(planPayload?.goal ?? '');
  const [scope, setScope] = useState(planPayload?.dataScope.join('\n') ?? '');
  const [outputs, setOutputs] = useState(planPayload?.outputs.join('\n') ?? '');
  const [verification, setVerification] = useState(planPayload?.verification.join('\n') ?? '');
  const decide = async (decision: 'approve' | 'deny') => {
    if (decision === 'deny' && interaction.kind === 'artifact_review' && !feedback.trim()) {
      setShowFeedback(true); setError('退回成果时请填写原因。'); return;
    }
    setError(''); await submit({ decision, ...(feedback.trim() ? { feedback: feedback.trim() } : {}) });
  };
  const modifyPlan = async () => {
    if (!planPayload) return;
    const lines = (value: string) => value.split('\n').map(item => item.trim()).filter(Boolean);
    await submit({
      decision: 'deny',
      feedback: '用户在手机端修改了计划，请读取修改版后重新发起计划与动作确认。',
      plan: {
        ...planPayload,
        goal: goal.trim(),
        dataScope: lines(scope),
        outputs: lines(outputs),
        verification: lines(verification),
      },
    });
  };
  const payload = interaction.payload;
  return <>
    {interaction.kind === 'plan_approval' && planPayload && (editingPlan ? <div className="approval-detail">
      <label>目标<textarea aria-label="修改计划目标" value={goal} disabled={busy} onChange={event => setGoal(event.target.value)} /></label>
      <label>读取范围（每行一项）<textarea aria-label="修改计划读取范围" value={scope} disabled={busy} onChange={event => setScope(event.target.value)} /></label>
      <label>预期成果（每行一项）<textarea aria-label="修改计划预期成果" value={outputs} disabled={busy} onChange={event => setOutputs(event.target.value)} /></label>
      <label>验收方式（每行一项）<textarea aria-label="修改计划验收方式" value={verification} disabled={busy} onChange={event => setVerification(event.target.value)} /></label>
    </div> : <Plan plan={planPayload} />)}
    {interaction.kind === 'action_permission' && 'tool' in payload && <div className="approval-detail">
      <p><strong>{payload.tool}</strong> · {labels[payload.risk]}</p>
      <p>{payload.summary}</p>
      {payload.command && <pre>{payload.command}</pre>}
      {payload.arguments && <details><summary>查看参数与影响</summary><pre>{JSON.stringify(payload.arguments, null, 2)}</pre></details>}
    </div>}
    {interaction.kind === 'artifact_review' && 'artifacts' in payload && <div className="approval-detail">
      <p><strong>{payload.machineVerified ? '机器核验通过' : '成果待核验'}</strong></p>
      <ul>{payload.artifacts.map(artifact => <li key={artifact.id}>{artifact.name}</li>)}</ul>
      {payload.verificationNotes.map(note => <p className="muted" key={note}>{note}</p>)}
    </div>}
    {showFeedback && <textarea aria-label="反馈原因" autoFocus maxLength={2000} value={feedback} disabled={busy} onChange={event => setFeedback(event.target.value)} placeholder="请说明需要修改的内容或拒绝原因。" />}
    {error && <p className="error" role="alert">{error}</p>}
    <div className="approval-actions">
      {planPayload && <button type="button" disabled={busy} onClick={() => setEditingPlan(value => !value)}>{editingPlan ? '取消修改' : '修改计划'}</button>}
      <button type="button" disabled={busy} onClick={() => setShowFeedback(value => !value)}>{showFeedback ? '收起反馈' : '填写反馈'}</button>
      <button type="button" disabled={busy} onClick={() => void decide('deny')}>{interaction.kind === 'artifact_review' ? '退回修改' : '拒绝'}</button>
      <button type="button" className="primary" disabled={busy || (editingPlan && (!goal.trim() || !scope.trim() || !outputs.trim() || !verification.trim()))} onClick={() => void (editingPlan ? modifyPlan() : decide('approve'))}>{busy ? '处理中…' : editingPlan ? '保存计划修改' : interaction.kind === 'plan_approval' ? '批准计划' : interaction.kind === 'artifact_review' ? '验收通过' : '允许本次'}</button>
    </div>
  </>;
}

export function InteractionDock({ interaction, busy, queued, onRespond }: {
  interaction: InteractionEnvelope;
  busy: boolean;
  queued: number;
  onRespond: (response: InteractionResponse) => Promise<void>;
}) {
  const label = { clarification: '需求澄清', plan_approval: '计划审批', action_permission: '动作授权', artifact_review: '成果验收' }[interaction.kind];
  return <section className="approval interaction-dock" aria-label={label} data-interaction={interaction.id}>
    <header><strong>{label}</strong><span className={`risk ${interaction.risk}`}>{labels[interaction.risk]}</span>{queued > 0 && <small>后面还有 {queued} 项</small>}</header>
    <p>{interaction.reason}</p>
    {interaction.kind === 'clarification'
      ? <Clarification payload={interaction.payload as ClarificationPayload} busy={busy} submit={onRespond} />
      : <Decision interaction={interaction} busy={busy} submit={onRespond} />}
    <small className="muted">等待状态可在其他设备继续处理。</small>
  </section>;
}
