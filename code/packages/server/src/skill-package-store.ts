import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import AdmZip from 'adm-zip';
import { pathWithin } from '@workpivot/shared/node';
import { ensureWorkpivotDir, readJsonSafe, writeAtomicWithBackup } from './store.js';

export const PACKAGE_LIMIT = 16 * 1024 * 1024;
const FILE_LIMIT = 8 * 1024 * 1024;
export type Files = Record<string, string>;
export interface PackageVersion { id: string; label: string; createdAt: string; directories?: string[] }
interface PackageState { name: string; revision: string; draft: Files; directories?: string[]; published?: string; versions: PackageVersion[] }
export const packageError = (message: string, status = 400): Error => Object.assign(new Error(message), { status });
export function validSkillName(name: string): void {
  if (typeof name !== 'string' || name.length > 64 || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) throw packageError('技能名称须为小写英文、数字和连字符，最多64字符');
}
export function validPackagePath(path: string): void {
  if (typeof path !== 'string' || path.length > 240 || path.split('/').length > 8 || path.split('/').some(p => !p || p.startsWith('.') || /[\\:\x00-\x1f\x7f<>"|?*]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p))) throw packageError('文件路径无效：请使用技能内的相对路径，不能包含隐藏目录、设备名或上级目录');
}
function root(name: string): string { validSkillName(name); return join(ensureWorkpivotDir('skill-packages'), name); }
function statePath(name: string): string { return join(root(name), 'state.json'); }
function read(name: string): PackageState {
  const state = readJsonSafe<PackageState | null>(statePath(name), null).value;
  if (!state) throw packageError('技能包不存在', 404);
  state.draft = Object.assign(Object.create(null) as Files, state.draft);
  return state;
}
function commit(state: PackageState): void { state.directories = packageDirectories(state.draft, state.directories); state.revision = randomUUID(); writeAtomicWithBackup(statePath(state.name), JSON.stringify(state)); }
export function packageDirectories(files: Files, explicit: string[] = []): string[] {
  const result = new Set<string>(); const targets = new Map<string, string>();
  for (const path of [...Object.keys(files), ...explicit.map(p => p + '/placeholder')]) {
    const parts = path.split('/'); parts.pop();
    while (parts.length) {
      const dir = parts.join('/'); validPackagePath(dir);
      const key = dir.toLowerCase();
      if (Object.keys(files).some(f => f.toLowerCase() === key) || (targets.has(key) && targets.get(key) !== dir)) throw packageError('文件夹与文件冲突，或名称仅大小写不同');
      targets.set(key, dir); result.add(dir); parts.pop();
    }
  }
  if (result.size > 256) throw packageError('最多256个文件夹');
  return [...result].sort();
}
function checkRevision(state: PackageState, revision: unknown): void {
  if (typeof revision !== 'string' || state.revision !== revision) throw packageError('草稿或发布版本已改变，请重新打开技能包后再操作；当前编辑内容未被覆盖', 409);
}
export function checkFiles(files: Files): void {
  const names = Object.keys(files); if (names.length > 256) throw packageError('技能包最多256个文件');
  const seen = new Set<string>(); let total = 0;
  for (const name of names) {
    validPackagePath(name);
    const folded = name.toLowerCase(); if (seen.has(folded)) throw packageError('文件名不能仅大小写不同'); seen.add(folded);
    const data = Buffer.from(files[name]!, 'base64');
    if (data.toString('base64') !== files[name]) throw packageError('文件编码无效');
    if (data.length > FILE_LIMIT) throw packageError('单个文件不能超过8MiB');
    total += data.length; if (total > PACKAGE_LIMIT) throw packageError('技能包总大小不能超过16MiB');
  }
  for (const name of seen) { const parts = name.split('/'); parts.pop(); while (parts.length) { if (seen.has(parts.join('/'))) throw packageError('文件与目录同名'); parts.pop(); } }
}
export function packageText(data: Buffer): string | null {
  if (data.length > 256 * 1024 || data.includes(0)) return null;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { return null; }
}
export function instructionFields(name: string, content: string): { description: string } {
  validSkillName(name);
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]+)$/.exec(content.replace(/\r\n/g, '\n'));
  if (!match || !match[2]!.trim()) throw packageError('SKILL.md 须包含顶部元数据和非空正文');
  const fields = new Map(match[1]!.split('\n').map(line => { const i = line.indexOf(':'); return [line.slice(0, i).trim(), line.slice(i + 1).trim()]; }));
  if (fields.get('name') !== name) throw packageError('SKILL.md 的 name 必须与技能包名称一致');
  const description = fields.get('description'); if (!description || description.length > 1024) throw packageError('description 必填，最多1024字符');
  return { description };
}
function snapshot(state: PackageState, files: Files, label: string): string {
  const id = randomUUID(); const directory = join(root(state.name), 'versions', id);
  const directories = packageDirectories(files, state.directories);
  for (const path of directories) mkdirSync(join(directory, path), { recursive: true });
  for (const [name, value] of Object.entries(files)) {
    const path = join(directory, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, Buffer.from(value, 'base64'), { flag: 'wx', mode: 0o600 });
  }
  state.versions.push({ id, label, createdAt: new Date().toISOString(), directories });
  return id;
}
export function managedPackageNames(): string[] {
  return readdirSync(ensureWorkpivotDir('skill-packages')).filter(name => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) && existsSync(join(root(name), 'state.json')));
}
export function publishedPackages(): Array<{ name: string; description: string; content: string; dir: string; source: 'global'; packageVersion: string }> {
  return managedPackageNames().flatMap(name => {
    const state = read(name); if (!state.published) return [];
    const dir = versionDirectory(state, state.published);
    const content = readFileSync(join(dir, 'SKILL.md'), 'utf8');
    return [{ name, ...instructionFields(name, content), content, dir, source: 'global' as const, packageVersion: state.published }];
  });
}
function versionDirectory(state: PackageState, version: string): string {
  if (!state.versions.some(v => v.id === version) || !/^[0-9a-f-]{36}$/.test(version)) throw packageError('版本不存在', 404);
  return join(root(state.name), 'versions', version);
}
export function copyPackageFiles(directory: string, directories?: string[]): Files {
  const files: Files = Object.create(null) as Files; let entries = 0, total = 0;
  const walk = (relative: string): void => {
    for (const item of readdirSync(join(directory, relative), { withFileTypes: true })) {
      if (++entries > 512) throw packageError('技能目录条目过多');
      const name = relative ? relative + '/' + item.name : item.name; validPackagePath(name);
      const path = join(directory, name); const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !pathWithin(path, directory)) throw packageError('技能包不支持链接文件');
      if (stat.isDirectory()) { directories?.push(name); walk(name); }
      else if (stat.isFile() && stat.nlink === 1) {
        total += stat.size; if (stat.size > FILE_LIMIT || total > PACKAGE_LIMIT) throw packageError('技能资源超过大小限制');
        files[name] = readFileSync(path).toString('base64');
      } else throw packageError('技能包只支持普通文件');
    }
  }; walk(''); checkFiles(files); return files;
}
export function openPackage(name: string, seed?: { dir: string; content: string }): ReturnType<typeof packageDetail> {
  if (!existsSync(statePath(name))) {
    if (!seed) throw packageError('技能不存在', 404);
    const directories: string[] = [];
    const draft = copyPackageFiles(seed.dir, directories); draft['SKILL.md'] = Buffer.from(seed.content).toString('base64'); checkFiles(draft);
    instructionFields(name, seed.content);
    const state: PackageState = { name, revision: '', draft, directories, versions: [] };
    state.published = snapshot(state, draft, '初始版本'); commit(state);
  }
  return packageDetail(name);
}
export function createPackage(name: string): ReturnType<typeof packageDetail> {
  if (existsSync(statePath(name))) throw packageError('技能包已存在', 409);
  const content = `---\nname: ${name}\ndescription: 请填写技能用途\n---\n\n# 工作流程\n请填写操作步骤、资源引用和检查要求。\n`;
  const state: PackageState = { name, revision: '', draft: { 'SKILL.md': Buffer.from(content).toString('base64') }, versions: [] }; commit(state); return packageDetail(name);
}
export function packageDetail(name: string) {
  const state = read(name);
  const files = Object.entries(state.draft).map(([path, value]) => { const data = Buffer.from(value, 'base64'); return { path, size: data.length, editable: packageText(data) !== null }; }).sort((a, b) => a.path.localeCompare(b.path));
  const published = state.published ? copyPackageFiles(versionDirectory(state, state.published)) : null;
  const directories = packageDirectories(state.draft, state.directories);
  const publishedDirectories = published ? packageDirectories(published, state.versions.find(v => v.id === state.published)?.directories) : [];
  const dirty = !published || Object.keys(published).length !== files.length || files.some(f => published[f.path] !== state.draft[f.path]) || JSON.stringify(directories) !== JSON.stringify(publishedDirectories);
  let dependencies: unknown = null;
  try { if (state.draft['skill.json']) dependencies = JSON.parse(Buffer.from(state.draft['skill.json'], 'base64').toString('utf8')); } catch { /* validation reports malformed manifest */ }
  return { name, revision: state.revision, published: state.published ?? null, versions: state.versions, files, directories, dirty, dependencies };
}
export function createPackageDirectory(name: string, path: string, revision: unknown) {
  validPackagePath(path); const state = read(name); checkRevision(state, revision);
  if (packageDirectories(state.draft, state.directories).some(d => d.toLowerCase() === path.toLowerCase())) throw packageError('文件夹已存在', 409);
  state.directories = [...(state.directories ?? []), path]; commit(state); return packageDetail(name);
}
export function deletePackageDirectory(name: string, path: string, revision: unknown) {
  validPackagePath(path); const state = read(name); checkRevision(state, revision);
  if (!packageDirectories(state.draft, state.directories).includes(path)) throw packageError('文件夹不存在', 404);
  for (const file of Object.keys(state.draft)) if (file.startsWith(path + '/')) delete state.draft[file];
  state.directories = (state.directories ?? []).filter(dir => dir !== path && !dir.startsWith(path + '/'));
  commit(state); return packageDetail(name);
}
export function packageFile(name: string, path: string, version?: string): Buffer {
  validPackagePath(path); const state = read(name);
  if (version) {
    const directory = versionDirectory(state, version), target = join(directory, path);
    if (!existsSync(target) || !pathWithin(target, directory) || !lstatSync(target).isFile()) throw packageError('文件不存在', 404);
    return readFileSync(target);
  }
  if (!Object.hasOwn(state.draft, path)) throw packageError('文件不存在', 404);
  return Buffer.from(state.draft[path]!, 'base64');
}
export function savePackageFile(name: string, path: string, data: Buffer | null, revision: unknown) {
  validPackagePath(path); const state = read(name); checkRevision(state, revision);
  if (data === null) { if (path === 'SKILL.md') throw packageError('不能删除 SKILL.md'); if (!Object.hasOwn(state.draft, path)) throw packageError('文件不存在', 404); delete state.draft[path]; }
  else state.draft[path] = data.toString('base64');
  checkFiles(state.draft); commit(state); return packageDetail(name);
}
export function validatePackage(name: string, available: string[]) {
  return validatePackageState(name, read(name), available);
}
export function validatePackageState(name: string, state: { draft: Files; revision: string }, available: string[]) {
  const errors: string[] = []; const warnings: string[] = [];
  try { checkFiles(state.draft); const text = packageText(Buffer.from(state.draft['SKILL.md'] ?? '', 'base64')); if (text === null) throw packageError('SKILL.md 必须为256KiB以内 UTF-8 文本'); instructionFields(name, text); } catch (error) { errors.push((error as Error).message); }
  for (const [path, value] of Object.entries(state.draft)) {
    const text = packageText(Buffer.from(value, 'base64'));
    if (/\.(md|txt|json|ya?ml|py|js|mjs|ts|sh|ps1|csv)$/i.test(path) && text === null) errors.push(`${path}：文本须为256KiB以内 UTF-8 文件`);
    if (extname(path) === '.json' && text !== null) try { JSON.parse(text); } catch { errors.push(`${path}：JSON 格式错误`); }
    if (extname(path) === '.md' && text !== null) {
      for (const match of text.matchAll(/!?\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
        const target = match[1]!; if (/^(?:[a-z]+:|#)/i.test(target)) continue;
        const raw = target.split('#')[0]!; if (!raw) continue;
        try {
          const relative = decodeURIComponent(raw);
          const parts = path.split('/').slice(0, -1);
          for (const part of relative.split('/')) { if (part === '..') { if (!parts.length) throw packageError('引用越出技能包'); parts.pop(); } else if (part !== '.') parts.push(part); }
          const resource = parts.join('/'); validPackagePath(resource);
          if (!Object.hasOwn(state.draft, resource)) errors.push(`${path}：引用文件不存在 ${target}`);
        } catch { errors.push(`${path}：引用路径无效 ${target}`); }
      }
    }
  }
  if (state.draft['skill.json']) try {
    const manifest = JSON.parse(Buffer.from(state.draft['skill.json'], 'base64').toString('utf8')) as { requiredSkills?: unknown; runtimeDependencies?: unknown };
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw packageError('依赖声明必须为对象');
    for (const key of ['requiredSkills', 'runtimeDependencies'] as const) if (manifest[key] !== undefined && (!Array.isArray(manifest[key]) || !(manifest[key] as unknown[]).every(v => typeof v === 'string' && v.length <= 200))) errors.push(`skill.json：${key} 须为字符串数组`);
    if (Array.isArray(manifest.requiredSkills)) for (const dependency of manifest.requiredSkills) if (typeof dependency === 'string' && (dependency === name || !available.includes(dependency))) errors.push(`依赖技能不可用：${String(dependency)}`);
    if (Array.isArray(manifest.runtimeDependencies) && manifest.runtimeDependencies.length) warnings.push('运行依赖仅记录，不会自动安装；请确认执行环境具备这些依赖。');
  } catch { errors.push('skill.json：依赖声明无效'); }
  if (Object.keys(state.draft).some(path => /\.(py|js|mjs|ts|sh|ps1)$/i.test(path))) warnings.push('脚本不会在上传或发布时执行；运行仍受任务授权和执行服务限制。');
  return { valid: errors.length === 0, errors, warnings, revision: state.revision };
}
export function publishPackage(name: string, revision: unknown, available: string[]) {
  const state = read(name); checkRevision(state, revision);
  const validation = validatePackage(name, available); if (!validation.valid) throw packageError(validation.errors.join('\n'));
  if (!packageDetail(name).dirty) throw packageError('草稿与已发布版本一致');
  state.published = snapshot(state, state.draft, `版本 ${state.versions.length + 1}`); commit(state); return packageDetail(name);
}
export function rollbackPackage(name: string, version: string, revision: unknown) {
  const state = read(name); checkRevision(state, revision); versionDirectory(state, version);
  // Keep the current draft so rollback never discards unfinished editing.
  state.published = version; commit(state); return packageDetail(name);
}
export function discardPackageDraft(name: string, revision: unknown) {
  const state = read(name); checkRevision(state, revision); if (!state.published) throw packageError('尚无发布版本，不能恢复草稿');
  state.directories = [];
  state.draft = copyPackageFiles(versionDirectory(state, state.published), state.directories); commit(state); return packageDetail(name);
}
function crc32(data: Buffer): number { let crc = 0xffffffff; for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }
export function importPackageZip(name: string, archive: Buffer, revision: unknown) {
  const state = read(name); checkRevision(state, revision);
  const { files, directories } = decodePackageZip(name, archive);
  state.draft = files; state.directories = directories; commit(state); return packageDetail(name);
}
export function decodePackageZip(name: string, archive: Buffer): { files: Files; directories: string[] } {
  if (archive.length > PACKAGE_LIMIT) throw packageError('ZIP 不能超过16MiB');
  const files: Files = Object.create(null) as Files;
  const directories: string[] = [];
  try {
    const entries = new AdmZip(archive).getEntries(); if (entries.length > 512) throw packageError('ZIP 条目过多');
    const hasRoot = entries.some(e => e.entryName === 'SKILL.md');
    const prefix = hasRoot ? '' : entries.find(e => /^[^/]+\/SKILL\.md$/.test(e.entryName))?.entryName.split('/')[0] + '/';
    if (prefix === 'undefined/') throw packageError('ZIP 根目录或单层目录下必须有 SKILL.md');
    const seen = new Set<string>(); let total = 0;
    for (const entry of entries) {
      const original = entry.entryName; validPackagePath(original.replace(/\/$/, ''));
      const mode = (entry.attr >>> 16) & 0xf000;
      if (mode && mode !== 0x8000 && mode !== 0x4000) throw packageError('ZIP 不允许链接或特殊文件');
      if (!original.startsWith(prefix)) throw packageError('ZIP 必须只包含一个技能包');
      const path = original.slice(prefix.length); if (!path) continue;
      if (entry.isDirectory) { directories.push(path.replace(/\/$/, '')); continue; }
      validPackagePath(path); if (seen.has(path.toLowerCase())) throw packageError('ZIP 存在重复文件'); seen.add(path.toLowerCase());
      const header = entry.header; total += header.size;
      if (header.size > FILE_LIMIT || total > PACKAGE_LIMIT || header.flags & 1) throw packageError('ZIP 超过解压限制或包含加密文件');
      const offset = header.offset;
      if (offset + 30 > archive.length || archive.readUInt32LE(offset) !== 0x04034b50) throw packageError('ZIP 文件头无效');
      const start = offset + 30 + archive.readUInt16LE(offset + 26) + archive.readUInt16LE(offset + 28);
      if (start + header.compressedSize > archive.length) throw packageError('ZIP 数据截断');
      const compressed = archive.subarray(start, start + header.compressedSize);
      const bytes = header.method === 0 ? compressed : header.method === 8 ? inflateRawSync(compressed, { maxOutputLength: Math.max(1, Math.min(FILE_LIMIT, header.size)) }) : (() => { throw packageError('不支持此 ZIP 压缩算法'); })();
      if (bytes.length !== header.size || crc32(bytes) !== header.crc) throw packageError('ZIP 文件校验失败');
      files[path] = bytes.toString('base64');
    }
    checkFiles(files); packageDirectories(files, directories); instructionFields(name, packageText(Buffer.from(files['SKILL.md'] ?? '', 'base64')) ?? '');
  } catch (error) { throw packageError(`导入失败：${(error as Error).message}`); }
  return { files, directories };
}
export function exportPackageZip(name: string, version?: string): Buffer {
  const state = read(name); const files = version ? copyPackageFiles(versionDirectory(state, version)) : state.draft;
  const directories = packageDirectories(files, version ? state.versions.find(v => v.id === version)?.directories : state.directories);
  const zip = new AdmZip(); for (const path of directories) zip.addFile(path + '/', Buffer.alloc(0));
  for (const [path, value] of Object.entries(files)) zip.addFile(path, Buffer.from(value, 'base64')); return zip.toBuffer();
}
