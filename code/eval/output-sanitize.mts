/**
 * O-14 执行输出清洗验收：ANSI/控制字符清除、常见密钥脱敏、头尾保留裁剪。
 */
import assert from 'node:assert/strict';
import { clipOutput, sanitizeOutput } from '../packages/server/src/output-sanitize.js';

let checks = 0;
function check(label: string, run: () => void): void {
  run();
  checks += 1;
  console.log('✅', label);
}

check('清除 ANSI 颜色码与控制字符，保留换行与制表符', () => {
  const raw = '\u001b[31mERROR\u001b[0m\tline\nnext\u0007';
  assert.equal(sanitizeOutput(raw), 'ERROR\tline\nnext');
});

check('脱敏 sk- / GitHub / Bearer / 密码键值 / 数据库 DSN', () => {
  const text = [
    'key sk-abcdefghijklmnopqrstuvwxyz012345',
    'token ghp_abcdefghijklmnopqrstuvwxyz0123',
    'Authorization: Bearer abcdefghijklmnop',
    'api_key=supersecretvalue',
    'password: hunter2hunter2',
    'postgresql://user:p4ssw0rd@db:5432/workpivot',
  ].join('\n');
  const cleaned = sanitizeOutput(text);
  assert.ok(!cleaned.includes('sk-abcdefghijklmnop'), 'sk- 未脱敏');
  assert.ok(!cleaned.includes('ghp_abcdefghij'), 'GitHub token 未脱敏');
  assert.ok(!cleaned.includes('abcdefghijklmnop'), 'Bearer 未脱敏');
  assert.ok(!cleaned.includes('supersecretvalue'), 'api_key 未脱敏');
  assert.ok(!cleaned.includes('hunter2hunter2'), 'password 未脱敏');
  assert.ok(!cleaned.includes('p4ssw0rd'), 'DSN 密码未脱敏');
  assert.ok(cleaned.includes('[已脱敏]'));
});

check('头尾保留裁剪：短文本原样，长文本保留开头与结尾', () => {
  assert.equal(clipOutput('short', 100), 'short');
  const text = `HEAD-${'x'.repeat(500)}-TAIL`;
  const clipped = clipOutput(text, 120);
  assert.ok(clipped.startsWith('HEAD-'));
  assert.ok(clipped.endsWith('-TAIL'));
  assert.match(clipped, /中间省略约 \d+ 字符/);
  assert.ok(clipped.length < text.length);
});

console.log(`\n输出清洗：${checks} 项通过`);
