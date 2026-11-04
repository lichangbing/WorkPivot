import assert from 'node:assert/strict';
import React from '../apps/web/node_modules/react/index.js';
// Web 包的依赖由 pnpm 隔离在工作区包内；评测从包的公开入口加载，不提升根依赖。
import { renderToStaticMarkup } from '../apps/web/node_modules/react-dom/server.node.js';
import { RequestDeliveryStatus } from '../apps/web/src/RequestDeliveryStatus.js';
import type { RequestDeliveryView } from '../packages/shared/src/index.js';

let checks = 0;
const check = (value: unknown, label: string) => {
  assert.ok(value, label);
  checks += 1;
  console.log(`✅ ${label}`);
};
const view = (patch: Partial<RequestDeliveryView>): RequestDeliveryView => ({
  requestId: 'request',
  taskId: 'task',
  turnId: 'turn',
  rootRunId: 'root',
  latestRunId: 'root',
  runState: 'accepted',
  deliveryState: 'not_visible',
  kind: 'preparing',
  updatedAt: '2026-11-04T01:00:00.000Z',
  ...patch,
});

const accepted = renderToStaticMarkup(<RequestDeliveryStatus view={view({})} />);
check(accepted.includes('已接收') && accepted.includes('正在准备'), 'UI 显示已接收和准备状态');
check(accepted.includes('role="status"') && accepted.includes('aria-live="polite"'), '交付状态可被辅助技术播报');

const progress = renderToStaticMarkup(<RequestDeliveryStatus view={view({
  runState: 'running',
  deliveryState: 'acknowledged',
  kind: 'progress',
})} />);
check(progress.includes('处理中') && !progress.includes('已交付'), '过程更新不会显示为最终交付');

const interrupted = renderToStaticMarkup(<RequestDeliveryStatus view={view({
  runState: 'interrupted',
  deliveryState: 'blocked',
  kind: 'interrupted',
})} onResume={() => undefined} />);
check(interrupted.includes('已中断') && interrupted.includes('继续'), '中断状态提供明确继续操作');

const missing = renderToStaticMarkup(<RequestDeliveryStatus view={view({
  runState: 'completed',
  deliveryState: 'blocked',
  kind: 'missing_reply',
})} />);
check(missing.includes('缺少可见答复') && missing.includes('没有生成可读答复'), '完成但无正文时不显示正常完成');

const delivered = renderToStaticMarkup(<RequestDeliveryStatus view={view({
  runState: 'completed',
  deliveryState: 'delivered',
  kind: 'result',
  lastVisibleEventId: 'assistant',
})} />);
check(delivered.includes('已交付') && !delivered.includes('继续'), '已交付状态不再显示恢复操作');

console.log(`交付状态 UI：${checks} 项通过`);
