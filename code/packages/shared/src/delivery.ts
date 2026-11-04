/** 用户请求的运行状态与可见交付状态；两者不能互相替代。 */
export type RequestRunPhase =
  | 'accepted'
  | 'running'
  | 'waiting_user'
  | 'stopping'
  | 'completed'
  | 'interrupted'
  | 'failed'
  | 'stopped';

export type RequestDeliveryState = 'not_visible' | 'acknowledged' | 'delivered' | 'blocked';

export type RequestDeliveryKind =
  | 'preparing'
  | 'progress'
  | 'result'
  | 'waiting_user'
  | 'interrupted'
  | 'failed'
  | 'stopped'
  | 'stopping'
  | 'missing_reply';

/** 交付投影只带标识和原因，不复制会话正文。 */
export interface RequestDeliveryView {
  requestId: string;
  taskId: string;
  turnId: string;
  rootRunId: string;
  latestRunId: string;
  runState: RequestRunPhase;
  deliveryState: RequestDeliveryState;
  kind: RequestDeliveryKind;
  lastVisibleEventId?: string;
  updatedAt: string;
}

export interface RequestDeliveryRun {
  id: string;
  turnId: string;
  requestId: string;
  status: 'running' | 'stopping' | 'completed' | 'stopped' | 'failed' | 'interrupted';
  stopReason?: string | null;
  createdAt: string;
  finishedAt?: string | null;
  sequence: string;
  hasUserEvent: boolean;
  lastVisibleEventId?: string;
  lastVisibleAt?: string | null;
  blocked?: boolean;
}

export interface RequestDeliveryResumeLink {
  fromRunId: string;
  toRunId: string;
}

function latestByRunOrder(left: RequestDeliveryRun, right: RequestDeliveryRun): RequestDeliveryRun {
  const leftSequence = BigInt(left.sequence);
  const rightSequence = BigInt(right.sequence);
  if (leftSequence !== rightSequence) return leftSequence > rightSequence ? left : right;
  return left.createdAt >= right.createdAt ? left : right;
}

function latestVisible(runs: readonly RequestDeliveryRun[]): RequestDeliveryRun | undefined {
  return runs
    .filter((run) => run.lastVisibleEventId && run.lastVisibleAt)
    .sort((left, right) => {
      const leftAt = left.lastVisibleAt ?? '';
      const rightAt = right.lastVisibleAt ?? '';
      return leftAt === rightAt ? Number(BigInt(right.sequence) - BigInt(left.sequence)) : leftAt > rightAt ? -1 : 1;
    })[0];
}

/** 以用户消息所在 run 为请求根，沿“继续”链汇总后续 run 的最终可见结果。 */
export function deriveRequestDeliveries(input: {
  taskId: string;
  runs: readonly RequestDeliveryRun[];
  resumeLinks?: readonly RequestDeliveryResumeLink[];
  rootTurnIds?: readonly string[];
}): RequestDeliveryView[] {
  const byId = new Map(input.runs.map((run) => [run.id, run]));
  const children = new Map<string, RequestDeliveryRun[]>();
  const resumedChildren = new Set<string>();
  for (const link of input.resumeLinks ?? []) {
    if (!byId.has(link.fromRunId) || !byId.has(link.toRunId)) continue;
    const rows = children.get(link.fromRunId) ?? [];
    rows.push(byId.get(link.toRunId)!);
    children.set(link.fromRunId, rows);
    resumedChildren.add(link.toRunId);
  }
  const selectedTurns = input.rootTurnIds ? new Set(input.rootTurnIds) : null;
  const roots = input.runs
    .filter((run) => run.hasUserEvent && !resumedChildren.has(run.id) && (!selectedTurns || selectedTurns.has(run.turnId)))
    .sort((left, right) => Number(BigInt(right.sequence) - BigInt(left.sequence)));
  const views: RequestDeliveryView[] = [];
  for (const root of roots) {
    const chain: RequestDeliveryRun[] = [];
    const seen = new Set<string>();
    const visit = (run: RequestDeliveryRun): void => {
      if (seen.has(run.id)) return;
      seen.add(run.id);
      chain.push(run);
      for (const child of children.get(run.id) ?? []) visit(child);
    };
    visit(root);
    const latest = chain.reduce(latestByRunOrder);
    const visible = latestVisible(chain);
    const blocked = chain.some((run) => run.blocked === true);
    const hasVisible = visible !== undefined;
    let runState: RequestRunPhase;
    if (blocked) runState = 'waiting_user';
    else if (latest.status === 'running') runState = hasVisible ? 'running' : 'accepted';
    else if (latest.status === 'stopping') runState = 'stopping';
    else runState = latest.status;

    let kind: RequestDeliveryKind;
    if (blocked) kind = 'waiting_user';
    else if (latest.status === 'stopping') kind = 'stopping';
    else if (latest.status === 'running') kind = hasVisible ? 'progress' : 'preparing';
    else if (latest.status === 'completed') kind = hasVisible ? 'result' : 'missing_reply';
    else if (latest.status === 'interrupted') kind = 'interrupted';
    else if (latest.status === 'failed') kind = 'failed';
    else kind = 'stopped';

    const deliveryState: RequestDeliveryState =
      blocked ? 'blocked'
        : latest.status === 'running' || latest.status === 'stopping'
          ? hasVisible ? 'acknowledged' : 'not_visible'
          : latest.status === 'completed' && hasVisible ? 'delivered' : 'blocked';
    const updatedAt = [latest.finishedAt, latest.createdAt, visible?.lastVisibleAt]
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .sort()
      .at(-1) ?? root.createdAt;
    views.push({
      requestId: root.requestId,
      taskId: input.taskId,
      turnId: root.turnId,
      rootRunId: root.id,
      latestRunId: latest.id,
      runState,
      deliveryState,
      kind,
      ...(visible?.lastVisibleEventId ? { lastVisibleEventId: visible.lastVisibleEventId } : {}),
      updatedAt,
    });
  }
  return views;
}

export function deliveryStatusLabel(view: Pick<RequestDeliveryView, 'deliveryState' | 'kind'>): string {
  if (view.kind === 'stopping') return '停止中';
  if (view.deliveryState === 'not_visible') return '已接收';
  if (view.deliveryState === 'acknowledged') return '处理中';
  if (view.deliveryState === 'delivered') return '已交付';
  if (view.kind === 'waiting_user') return '等待你处理';
  if (view.kind === 'interrupted') return '已中断';
  if (view.kind === 'failed') return '执行失败';
  if (view.kind === 'stopped') return '已停止';
  return '缺少可见答复';
}

export function deliveryStatusDescription(view: Pick<RequestDeliveryView, 'deliveryState' | 'kind'>): string {
  if (view.kind === 'stopping') return '正在停止本次任务，既有回复会保留。';
  if (view.kind === 'preparing') return '已接收，正在准备。';
  if (view.kind === 'progress') return '已有可见更新，任务仍在处理。';
  if (view.kind === 'result') return '本次请求已产生最终可见答复。';
  if (view.kind === 'waiting_user') return '任务正在等待你确认或补充信息。';
  if (view.kind === 'interrupted') return '任务在完成前中断，可以继续，系统不会重复已执行操作。';
  if (view.kind === 'failed') return '本次执行失败，请查看原因后重试。';
  if (view.kind === 'stopped') return '本次执行已停止。';
  return '任务已经结束，但没有生成可读答复。可以继续或重新发送要求。';
}
