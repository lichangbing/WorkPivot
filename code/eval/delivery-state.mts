import assert from 'node:assert/strict';
import {
  deliveryStatusDescription,
  deliveryStatusLabel,
  deriveRequestDeliveries,
  interactionCapabilities,
  type RequestDeliveryRun,
} from '../packages/shared/src/index.js';

let checks = 0;
const check = (value: unknown, label: string) => {
  assert.ok(value, label);
  checks += 1;
  console.log(`✅ ${label}`);
};

const baseRun: RequestDeliveryRun = {
  id: 'run-root',
  turnId: 'turn-root',
  requestId: 'request-root',
  status: 'running',
  createdAt: '2026-11-04T01:00:00.000Z',
  sequence: '1',
  hasUserEvent: true,
};
const project = (run: RequestDeliveryRun) => deriveRequestDeliveries({ taskId: 'task', runs: [run] })[0]!;

const accepted = project(baseRun);
check(accepted.runState === 'accepted' && accepted.deliveryState === 'not_visible' && accepted.kind === 'preparing', '运行但没有可见正文时显示已接收');
check(deliveryStatusLabel(accepted) === '已接收' && deliveryStatusDescription(accepted).includes('正在准备'), '已接收状态有明确用户文案');

const progress = project({
  ...baseRun,
  lastVisibleEventId: 'assistant-1',
  lastVisibleAt: '2026-11-04T01:00:05.000Z',
});
check(progress.runState === 'running' && progress.deliveryState === 'acknowledged' && progress.kind === 'progress', '可见助手正文推进为处理中');
check(deliveryStatusLabel(progress) === '处理中', '处理中与已交付使用不同标签');

const delivered = project({
  ...baseRun,
  status: 'completed',
  finishedAt: '2026-11-04T01:01:00.000Z',
  lastVisibleEventId: 'assistant-2',
  lastVisibleAt: '2026-11-04T01:00:59.000Z',
});
check(delivered.deliveryState === 'delivered' && delivered.kind === 'result', '完成且有可见正文才记为已交付');

const missing = project({
  ...baseRun,
  status: 'completed',
  finishedAt: '2026-11-04T01:01:00.000Z',
});
check(missing.deliveryState === 'blocked' && missing.kind === 'missing_reply', '完成但没有可见正文时不得误报已交付');
check(deliveryStatusDescription(missing).includes('没有生成可读答复'), '缺少回复显示明确恢复说明');

const interrupted = project({
  ...baseRun,
  status: 'interrupted',
  stopReason: 'lease_expired',
  finishedAt: '2026-11-04T01:01:00.000Z',
});
check(interrupted.deliveryState === 'blocked' && interrupted.kind === 'interrupted', '首字前中断进入可继续状态');

const waiting = project({ ...baseRun, blocked: true, status: 'running' });
check(waiting.runState === 'waiting_user' && waiting.deliveryState === 'blocked' && waiting.kind === 'waiting_user', '等待交互显示为用户处理阻塞而非失败');

const failed = project({ ...baseRun, status: 'failed', finishedAt: '2026-11-04T01:01:00.000Z' });
check(failed.kind === 'failed' && failed.deliveryState === 'blocked', '失败运行有明确终态');

const stopping = project({ ...baseRun, status: 'stopping' });
check(stopping.kind === 'stopping' && deliveryStatusLabel(stopping) === '停止中', '停止过程中显示真实过渡状态');

const resumed = deriveRequestDeliveries({
  taskId: 'task',
  runs: [
    { ...baseRun, status: 'interrupted', finishedAt: '2026-11-04T01:01:00.000Z' },
    {
      ...baseRun,
      id: 'run-resumed',
      turnId: 'turn-resumed',
      requestId: 'request-resumed',
      status: 'completed',
      sequence: '2',
      createdAt: '2026-11-04T01:02:00.000Z',
      finishedAt: '2026-11-04T01:03:00.000Z',
      hasUserEvent: true,
      lastVisibleEventId: 'assistant-resumed',
      lastVisibleAt: '2026-11-04T01:02:59.000Z',
    },
  ],
  resumeLinks: [{ fromRunId: 'run-root', toRunId: 'run-resumed' }],
})[0]!;
check(resumed.turnId === 'turn-root' && resumed.latestRunId === 'run-resumed', '带继续消息的续跑仍归属于原始用户请求');
check(resumed.deliveryState === 'delivered' && resumed.lastVisibleEventId === 'assistant-resumed', '续跑产生可见结果后原始请求进入已交付');

const filtered = deriveRequestDeliveries({
  taskId: 'task',
  runs: [
    { ...baseRun, status: 'completed', finishedAt: '2026-11-04T01:01:00.000Z' },
    { ...baseRun, id: 'run-old', turnId: 'turn-old', requestId: 'request-old', sequence: '0' },
  ],
  rootTurnIds: ['turn-old'],
});
check(filtered.length === 1 && filtered[0]?.turnId === 'turn-old', '会话分页按根 turn 过滤交付状态');

check(interactionCapabilities({ WORKPIVOT_INTERACTION_DELIVERY_STATE_V1: 'off' } as NodeJS.ProcessEnv).deliveryState === false, '交付状态支持环境开关回退');
check(interactionCapabilities({ WORKPIVOT_INTERACTION_NO_FEEDBACK_RECOVERY: 'off' } as NodeJS.ProcessEnv).noFeedbackRecovery === false, '无反馈恢复支持独立开关');

console.log(`交付状态投影：${checks} 项通过`);
