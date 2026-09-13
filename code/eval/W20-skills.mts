import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSkillTools } from '../packages/server/src/skill-tools.js';
import { pathWithin } from '../packages/shared/src/path-guard.js';
const root = mkdtempSync(join(tmpdir(), 'wp20-'));
process.env['WORKPIVOT_HOME'] = join(root, 'home');
const { listSkills, renderSkillDirectory, setSkillDisabled } = await import('../packages/server/src/skills.js');
const taskDir = join(root, 'task'), skillDir = join(taskDir, '.workpivot/skills/test-skill');
mkdirSync(join(skillDir, 'references'), { recursive: true });
writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: test-skill\ndescription: 测试技能\n---\n按 references/guide.md 执行。');
writeFileSync(join(skillDir, 'references/guide.md'), 'REFERENCE_VALUE_42');
let permitted = true;
const allowed = (path: string): boolean => permitted && pathWithin(path, taskDir);
const discover = () => listSkills(taskDir, { projectFileAllowed: allowed });
const tool = buildSkillTools(discover, allowed)[0]!;
const ctx = { taskDir };
const results: boolean[] = [];
function assert(name: string, pass: boolean): void { results.push(pass); console.log(`${pass ? '✅' : '❌'} ${name}`); }
async function rejected(args: Record<string, unknown>): Promise<boolean> { try { await tool.run(args, ctx); return false; } catch { return true; } }
try {
  assert('Skill目录指引模型自主加载', renderSkillDirectory(discover()).includes('load_skill'));
  const loaded = JSON.parse(await tool.run({ name: 'test-skill' }, ctx));
  assert('Skill按名称读取完整说明', loaded.content.includes('按 references/guide.md'));
  assert('Skill列出可按需加载的资源', loaded.resources.includes('references/guide.md'));
  assert('Skill读取相对参考资料', JSON.parse(await tool.run({ name: 'test-skill', file: 'references/guide.md' }, ctx)).content === 'REFERENCE_VALUE_42');
  assert('Skill支持内置办公说明', JSON.parse(await tool.run({ name: 'xlsx-report' }, ctx)).content.includes('exceljs'));
  assert('Skill不存在明确拒绝', await rejected({ name: 'missing' }));
  assert('Skill拒绝目录穿越', await rejected({ name: 'test-skill', file: '../outside.txt' }));
  assert('Skill拒绝绝对路径', await rejected({ name: 'test-skill', file: join(root, 'private.txt') }));
  assert('Skill拒绝Windows路径绕过', await rejected({ name: 'test-skill', file: '..\\private.txt' }));
  writeFileSync(join(skillDir, 'large.txt'), 'x'.repeat(256 * 1024 + 1));
  assert('Skill拒绝超大资料', await rejected({ name: 'test-skill', file: 'large.txt' }));
  writeFileSync(join(skillDir, 'binary.bin'), Buffer.from([1, 0, 2]));
  assert('Skill拒绝二进制资料', await rejected({ name: 'test-skill', file: 'binary.bin' }));
  const privateDir = join(root, 'private'); mkdirSync(privateDir); writeFileSync(join(privateDir, 'secret.txt'), 'DO_NOT_READ');
  const link = join(skillDir, 'linked'); symlinkSync(privateDir, link, process.platform === 'win32' ? 'junction' : 'dir');
  try { assert('Skill拒绝资源链接逃逸', await rejected({ name: 'test-skill', file: 'linked/secret.txt' })); } finally { rmSync(link); }
  setSkillDisabled('test-skill', true);
  assert('Skill运行中停用立即生效', await rejected({ name: 'test-skill' }));
  setSkillDisabled('test-skill', false);
  writeFileSync(join(skillDir, 'references/guide.md'), 'UPDATED');
  assert('Skill资源热更新', JSON.parse(await tool.run({ name: 'test-skill', file: 'references/guide.md' }, ctx)).content === 'UPDATED');
  permitted = false;
  assert('Skill撤销项目读取权立即生效', await rejected({ name: 'test-skill' }));
  const abort = new AbortController(); abort.abort();
  let aborted = false; try { await tool.run({ name: 'xlsx-report' }, { ...ctx, signal: abort.signal }); } catch { aborted = true; }
  assert('Skill停止后不再加载', aborted);
} finally { rmSync(root, { recursive: true, force: true }); }
console.log(`W20 skills: ${results.filter(Boolean).length}/${results.length}`);
if (results.some((pass) => !pass)) process.exitCode = 1;
