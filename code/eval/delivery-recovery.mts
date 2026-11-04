import assert from 'node:assert/strict';
import { deriveRequestDeliveries, type RequestDeliveryRun } from '../packages/shared/src/index.js';
import { eligibleForAutoResume } from '../packages/server/src/database/auto-resume.js';

let checks = 0;
const check = (value: unknown, label: string) => {
  assert.ok(value, label);
  checks += 1;
  console.log(`✅ ${label}`);
};

const root: RequestDeliveryRun = {
  id: 'root-run',
  turnId: 'root-turn',
  requestId: 'root-request',
  status: 'interrupted',
  stopReason: 'lease_expired',
  createdAt: '2026-11-04T01:00:00.000Z',
  finishedAt: '2026-11-04T01:00:30.000Z',
  sequence: '10',
  hasUserEvent: true,
};

const beforeFirstToken = deriveRequestDeliveries({ taskId: 'task', runs: [root] })[0]!;
check(beforeFirstToken.kind === 'interrupted' && beforeFirstToken.deliveryState === 'blocked', '首字前崩溃保留中断终态');
check(beforeFirstToken.lastVisibleEventId === undefined, '中断不会伪造可见回复');

const partial = deriveRequestDeliveries({
  taskId: 'task',
  runs: [{ ...root, lastVisibleEventId: 'partial-assistant', lastVisibleAt: '2026-11-04T01:00:20.000Z' }],
})[0]!;
check(partial.kind === 'interrupted' && partial.lastVisibleEventId === 'partial-assistant', '部分正文后崩溃保留已交付片段');
check(partial.deliveryState === 'blocked', '部分正文不能把中断任务标为完成');

const resumedChild: RequestDeliveryRun = {
  ...root,
  id: 'continued-run',
  turnId: 'continued-turn',
  requestId: 'continued-request',
  status: 'running',
  sequence: '11',
  createdAt: '2026-11-04T01:01:00.000Z',
  finishedAt: null,
  hasUserEvent: false,
};
const continued = deriveRequestDeliveries({
  taskId: 'task',
  runs: [root, resumedChild],
  resumeLinks: [{ fromRunId: root.id, toRunId: resumedChild.id }],
})[0]!;
check(continued.latestRunId === resumedChild.id && continued.runState === 'accepted', '继续运行重新进入已接收状态');

const unknownResult = deriveRequestDeliveries({
  taskId: 'task',
  runs: [
    root,
    {
      ...resumedChild,
      status: 'completed',
      finishedAt: '2026-11-04T01:02:00.000Z',
    },
  ],
  resumeLinks: [{ fromRunId: root.id, toRunId: resumedChild.id }],
})[0]!;
check(unknownResult.kind === 'missing_reply' && unknownResult.deliveryState === 'blocked', '续跑结束但无可见正文仍要求用户处理');

check(!eligibleForAutoResume({ openDispatches: 1, attempts: 0 }), '存在已派发工具时无反馈恢复不会自动重放');
check(eligibleForAutoResume({ openDispatches: 0, attempts: 0 }), '没有未决副作用时仍受既有自动续跑策略约束');
check(!eligibleForAutoResume({ openDispatches: 0, attempts: 1 }), '自动续跑次数上限保持不变');

const cycle = deriveRequestDeliveries({
  taskId: 'task',
  runs: [root, resumedChild],
  resumeLinks: [
    { fromRunId: root.id, toRunId: resumedChild.id },
    { fromRunId: resumedChild.id, toRunId: root.id },
  ],
});
check(cycle.length === 0, '异常循环续跑链不会重复输出或导致死循环');

console.log(`交付恢复：${checks} 项通过`);
