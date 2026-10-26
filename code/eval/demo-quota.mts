/**
 * 演示额度判定：每个注册用户默认 10 次用户消息；管理员与 quota=0 不限。
 * 只测纯函数边界，真实计数由 runs.start 的事务完成。
 */
import assert from 'node:assert/strict';
import { quotaDecision } from '../packages/server/src/database/accounts.js';

let checks = 0;
function check(label: string, run: () => void): void {
  run();
  checks += 1;
  console.log('✅', label);
}

check('普通成员：剩余 = 额度 - 已用', () => {
  assert.deepEqual(quotaDecision({ platform_admin: false, message_quota: 10, messages_used: 0 }), { unlimited: false, remaining: 10 });
  assert.deepEqual(quotaDecision({ platform_admin: false, message_quota: 10, messages_used: 7 }), { unlimited: false, remaining: 3 });
});

check('用完时剩余为 0，不会出现负数', () => {
  assert.deepEqual(quotaDecision({ platform_admin: false, message_quota: 10, messages_used: 10 }), { unlimited: false, remaining: 0 });
  assert.deepEqual(quotaDecision({ platform_admin: false, message_quota: 10, messages_used: 12 }), { unlimited: false, remaining: 0 });
});

check('平台管理员不限次', () => {
  assert.deepEqual(quotaDecision({ platform_admin: true, message_quota: 10, messages_used: 99 }), { unlimited: true, remaining: null });
});

check('quota=0 视为关闭限制（不限次）', () => {
  assert.deepEqual(quotaDecision({ platform_admin: false, message_quota: 0, messages_used: 5 }), { unlimited: true, remaining: null });
});

check('数据库返回字符串数字也能正确判定', () => {
  assert.deepEqual(quotaDecision({ platform_admin: false, message_quota: '10', messages_used: '9' }), { unlimited: false, remaining: 1 });
});

console.log(`\n演示额度判定：${checks} 项通过`);
