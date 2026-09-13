/**
 * T4-01/D01：SKILL.md 技能发现/校验/注入（agentskills.io 规范的 M0 子集）。
 * 三层发现（后者覆盖同名前者）：内置（随应用发行）→ 全局 ~/.workpivot/skills → 项目 <taskDir>/.workpivot/skills。
 * 渐进披露：系统提示词只注入 目录（name+description，总预算 8000 字符）；
 * 内置技能额外注入全文；用户/项目技能以 /技能名 斜杠触发时注入全文。
 * 热加载：每次任务执行前重读磁盘，无缓存。
 */
import { existsSync, readdirSync, readFileSync, lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { ensureWorkpivotDir, readJsonSafe, writeAtomic, writeAtomicWithBackup } from './store.js';
import { pathWithin } from '@workpivot/shared/node';
import { managedPackageNames, packageError, publishedPackages } from './skill-package-store.js';

export interface Skill {
  packageVersion?: string;
  name: string;
  description: string;
  /** SKILL.md 全文（渐进披露第三层，按需注入） */
  content: string;
  /** 技能根目录（供"打开所在目录"等后续功能） */
  dir: string;
  source: 'builtin' | 'global' | 'project';
}

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** 极简 frontmatter 解析：'---' 围栏内逐行 key: value。 */
function parseFrontmatter(text: string): { fields: Record<string, string>; body: string } {
  const normalized = text.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return { fields: {}, body: normalized };
  const end = normalized.indexOf('\n---\n', 4);
  if (end < 0) return { fields: {}, body: normalized };
  const header = normalized.slice(4, end);
  const body = normalized.slice(end + 5);
  const fields: Record<string, string> = {};
  for (const line of header.split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) fields[key] = value;
  }
  return { fields, body };
}

/** 规范校验（agentskills.io M0 子集）：name 必填且等于目录名；description 必填；长度上限。 */
function validate(dirName: string, fields: Record<string, string>): { ok: boolean; error?: string } {
  const name = fields['name'] ?? '';
  const description = fields['description'] ?? '';
  if (!name) return { ok: false, error: '缺少 name' };
  if (name.length > 64) return { ok: false, error: 'name 超过 64 字符' };
  if (!NAME_RE.test(name)) return { ok: false, error: `name 非法（需小写字母/数字/连字符）：${name}` };
  if (name !== dirName) return { ok: false, error: `name(${name}) 与目录名(${dirName})不一致` };
  if (!description || description.length > 1024) return { ok: false, error: 'description 缺失或超 1024 字符' };
  return { ok: true };
}

function loadSkillDir(skillsRoot: string, source: Skill['source'], allowed?: (path: string) => boolean): Skill[] {
  if (allowed && !allowed(skillsRoot)) return [];
  if (!existsSync(skillsRoot)) return [];
  const skills: Skill[] = [];
  for (const dirName of readdirSync(skillsRoot)) {
    const skillFile = join(skillsRoot, dirName, 'SKILL.md');
    if (allowed && !allowed(skillFile)) continue;
    if (!existsSync(skillFile) || !pathWithin(skillFile, skillsRoot)) continue;
    try {
      const stat = lstatSync(skillFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) continue;
      const text = readFileSync(skillFile, 'utf8');
      const { fields } = parseFrontmatter(text);
      const check = validate(dirName, fields);
      if (!check.ok) {
        console.warn(`[skills] 跳过无效技能 ${dirName}(${source})：${check.error}`);
        continue;
      }
      skills.push({
        name: fields['name']!,
        description: fields['description']!,
        content: text,
        dir: join(skillsRoot, dirName),
        source,
      });
    } catch (err) {
      console.warn(`[skills] 读取失败 ${dirName}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return skills;
}

function builtinSkillsRoot(): string {
  // 桌面打包态（esbuild CJS）下 import.meta 不可用，优先用宿主注入的环境变量
  const fromEnv = process.env['WORKPIVOT_BUILTIN_SKILLS'];
  if (fromEnv && existsSync(join(fromEnv, 'docx-report', 'SKILL.md'))) return fromEnv;
  let moduleDir: string | null = null;
  try {
    moduleDir = dirname(fileURLToPath(import.meta.url));
  } catch {
    moduleDir = null;
  }
  const candidates = [
    ...(moduleDir ? [join(moduleDir, '..', 'skills'), join(moduleDir, '..', '..', 'skills')] : []),
    join(process.cwd(), 'packages', 'server', 'skills'),
    join(process.cwd(), 'skills'),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'docx-report', 'SKILL.md'))) return candidate;
  }
  return candidates[0] ?? 'skills';
}

/** 每次任务执行前调用：重读磁盘（D01 热加载）。 */
export function listSkills(taskDir: string, opts: { includeDisabled?: boolean; projectFileAllowed?: (path: string) => boolean } = {}): Skill[] {
  const byName = new Map<string, Skill>();
  const layers: Array<{ root: string; source: Skill['source'] }> = [
    { root: builtinSkillsRoot(), source: 'builtin' },
    { root: join(ensureWorkpivotDir('skills'), ''), source: 'global' },
    { root: join(taskDir, '.workpivot', 'skills'), source: 'project' },
  ];
  for (const { root, source } of layers) {
    for (const skill of loadSkillDir(root, source, source === 'project' ? opts.projectFileAllowed : undefined)) {
      byName.set(skill.name, { ...skill, source }); // 项目覆盖全局覆盖内置
    }
  }
  const overrides = readJsonSafe<Record<string, string>>(join(ensureWorkpivotDir('config'), 'skill-edits.json'), {}).value;
  for (const [name, skill] of byName) {
    const key = `${skill.source}:${name}`;
    const content = Object.hasOwn(overrides, key) ? overrides[key] : undefined;
    if (typeof content === 'string' && validate(name, parseFrontmatter(content).fields).ok) {
      byName.set(name, { ...skill, content, description: parseFrontmatter(content).fields['description']! });
    }
  }
  for (const skill of publishedPackages()) {
    if (byName.get(skill.name)?.source !== 'project') byName.set(skill.name, skill);
  }
  const disabled = disabledSkills();
  return [...byName.values()].filter((s) => opts.includeDisabled === true || !disabled.includes(s.name));
}

export function skillRevision(skill: Skill): string {
  return createHash('sha256').update(skill.source + '\n' + skill.content).digest('hex');
}

/** Published files are immutable; still re-discover to honour disable/revoke immediately. */
export function pinPublishedSkills(discover: () => Skill[]): () => Skill[] {
  const pinned = new Map<string, Skill>();
  return () => discover().map(skill => {
    const previous = pinned.get(skill.name);
    if (skill.packageVersion && previous) return previous;
    pinned.set(skill.name, skill); return skill;
  });
}

/** Personal instruction overrides preserve the original resource/script directory. */
export function editSkill(taskDir: string, name: string, content: string, revision: string): void {
  if (managedPackageNames().includes(name)) throw packageError('此技能已使用文件包管理，请编辑草稿并发布', 409);
  const skill = listSkills(taskDir, { includeDisabled: true }).find((item) => item.name === name);
  if (!skill) throw Object.assign(new Error('技能不存在'), { status: 404 });
  if (skillRevision(skill) !== revision) throw Object.assign(new Error('技能已被修改，请重新打开后编辑'), { status: 409 });
  if (Buffer.byteLength(content, 'utf8') > 256 * 1024) throw Object.assign(new Error('技能内容不能超过 256KB'), { status: 400 });
  const parsed = parseFrontmatter(content);
  const check = validate(name, parsed.fields);
  if (!check.ok || !parsed.body.trim()) throw Object.assign(new Error(check.error ?? '技能正文不能为空'), { status: 400 });
  const path = join(ensureWorkpivotDir('config'), 'skill-edits.json');
  const edits = readJsonSafe<Record<string, string>>(path, {}).value;
  edits[`${skill.source}:${name}`] = content;
  writeAtomicWithBackup(path, JSON.stringify(edits, null, 2));
}

// ---- 启停（F3 管理后台）：停用名单存 settings.json，停用技能不注入目录 ----
export function disabledSkills(): string[] {
  const settings = readJsonSafe<{ disabledSkills?: string[] }>(
    join(ensureWorkpivotDir('config'), 'settings.json'),
    {},
  ).value;
  return settings.disabledSkills ?? [];
}

export function setSkillDisabled(name: string, disabled: boolean): void {
  const settingsPath = join(ensureWorkpivotDir('config'), 'settings.json');
  const settings = readJsonSafe<{ disabledSkills?: string[] }>(settingsPath, {}).value;
  const current = new Set(settings.disabledSkills ?? []);
  if (disabled) current.add(name);
  else current.delete(name);
  writeAtomic(settingsPath, JSON.stringify({ ...settings, disabledSkills: [...current] }, null, 2));
}

/** 全局技能目录（数据目录规范）。 */
export function globalSkillsDir(): string {
  return join(ensureWorkpivotDir('skills'), '');
}

/** 系统提示词注入：目录列表（1% 上下文预算的 M0 近似：总 8000 字符，单条 250 字符）。 */
export function renderSkillDirectory(skills: Skill[]): string {
  if (skills.length === 0) return '';
  const BUDGET = 8000;
  const lines: string[] = [];
  let used = 0;
  for (const skill of skills) {
    const line = `- ${skill.name}：${skill.description.slice(0, 250)}`;
    if (used + line.length > BUDGET) break;
    lines.push(line);
    used += line.length;
  }
  return ['\n# 可用技能', '根据用户任务匹配以下技能；匹配时必须先调用 load_skill({name:"技能名"}) 加载完整说明，再开展工作，不需要用户输入斜杠命令。', '说明引用的参考资料或脚本用 load_skill({name:"技能名",file:"技能内相对路径"}) 按需读取。脚本读取不等于执行；Skill 不会新增工具或提升权限。不要将所有技能全文一次加载。', ...lines].join('\n');
}

/** 斜杠触发：消息以 /技能名 开头时返回该技能全文（拼入消息上下文）。 */
export function findSkillBySlash(skills: Skill[], message: string): Skill | null {
  if (!message.startsWith('/')) return null;
  const name = message.slice(1).split(/\s+/)[0] ?? '';
  return skills.find((s) => s.name === name) ?? null;
}
