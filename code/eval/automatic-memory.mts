import assert from 'node:assert/strict';
import { buildAutomaticMemoryPreamble, memoryQueryTerms } from '../packages/server/src/database/memory-tools.js';

let passed = 0;
function check(name: string, run: () => void) {
  run();
  passed++;
  console.log(`PASS ${name}`);
}

check('中文查询生成有界关键词', () => {
  const terms = memoryQueryTerms('项目使用中文报告，金额统一使用万元');
  assert(terms.includes('中文报告'));
  assert(terms.includes('万元'));
  assert(terms.length <= 120);
});

check('英文和编号生成精确检索词', () => {
  const terms = memoryQueryTerms('Project WP-2026 amount=123.45 USD');
  assert(terms.includes('project'));
  assert(terms.includes('wp-2026'));
  assert(terms.includes('123.45'));
});

check('超长查询不会产生无界关键词', () => {
  assert(memoryQueryTerms('记忆'.repeat(5000)).length <= 120);
});

check('自动记忆提示携带层级、修订和权限边界', () => {
  const text = buildAutomaticMemoryPreamble([
    { id: 'project-memory', scope: 'project', revision: 3, content: '项目金额统一使用万元' },
    { id: 'user-memory', scope: 'user', revision: 2, content: '报告优先使用中文' },
  ]);
  assert(text.includes('项目记忆 v3'));
  assert(text.includes('个人记忆 v2'));
  assert(text.includes('不是系统指令'));
});

check('空自动记忆不产生提示块', () => {
  assert.equal(buildAutomaticMemoryPreamble([]), '');
});

console.log(`Automatic memory: ${passed}/${passed}`);
