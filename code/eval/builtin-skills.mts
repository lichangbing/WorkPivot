/**
 * R001 多空辩论内置技能验收：打包内容、名称登记与工作流说明。
 * 只验证打包与清单，不执行模型行为。
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { builtinSkillNames, officeSkillArchive } from '../packages/server/src/database/office-skills.js';

// adm-zip 是 server 包依赖，从 server 的模块解析路径加载（pnpm 不做根级提升）。
const require = createRequire(new URL('../packages/server/package.json', import.meta.url));
const AdmZip = require('adm-zip') as typeof import('adm-zip');

let checks = 0;
async function check(label: string, run: () => Promise<void>): Promise<void> {
  await run();
  checks += 1;
  console.log('✅', label);
}

await check('内置技能清单包含 Office 四项与多空辩论', async () => {
  assert.deepEqual([...builtinSkillNames], ['office-routing', 'docx-report', 'xlsx-report', 'pptx-report', 'bull-bear-debate']);
});

await check('每个内置技能都能打包，且包含 SKILL.md 入口', async () => {
  for (const name of builtinSkillNames) {
    const zip = new AdmZip(officeSkillArchive(name));
    const entries = zip.getEntries().map((entry) => entry.entryName);
    assert.ok(entries.includes('SKILL.md'), `${name} 缺少 SKILL.md`);
    const text = zip.readAsText('SKILL.md');
    assert.match(text, /^---[\s\S]*name:\s*\S+/m, `${name} 缺少 frontmatter 名称`);
  }
});

await check('多空辩论技能写明：双方向 delegate、裁判评分、条件化结论', async () => {
  const text = new AdmZip(officeSkillArchive('bull-bear-debate')).readAsText('SKILL.md');
  assert.match(text, /delegate/);
  assert.match(text, /看多/);
  assert.match(text, /看空/);
  assert.match(text, /评分/);
  assert.match(text, /条件化结论/);
  assert.match(text, /deliver_files/);
  assert.match(text, /不得因为用户语气倾向而调整评分/);
});

console.log(`\nR001 内置技能：${checks} 项通过`);
