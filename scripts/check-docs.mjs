#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entryFiles = ['README.md', 'code/README.md', 'docs', 'releases'];
const failures = [];
const structureFailures = [];
let checkedFiles = 0;
let checkedLinks = 0;

function markdownFiles(path) {
  if (!existsSync(path)) return [];
  if (statSync(path).isFile()) return extname(path).toLowerCase() === '.md' ? [path] : [];
  const files = [];
  for (const name of readdirSync(path)) {
    if (name.startsWith('.') || name === 'node_modules') continue;
    files.push(...markdownFiles(join(path, name)));
  }
  return files;
}

function bodyWithoutFences(text) {
  const lines = [];
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      lines.push('');
      continue;
    }
    lines.push(fenced ? '' : line);
  }
  return lines.join('\n');
}

function localTarget(raw) {
  let target = raw.trim();
  if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
  else target = target.split(/\s+/)[0] ?? '';
  if (!target || target.startsWith('#') || target.startsWith('/')) return null;
  if (/^(https?:|mailto:|tel:|data:|codex:)/i.test(target)) return null;
  target = target.split(/[?#]/, 1)[0];
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

const files = [...new Set(entryFiles.flatMap(file => markdownFiles(resolve(root, file))))];
for (const file of files) {
  checkedFiles += 1;
  const text = bodyWithoutFences(readFileSync(file, 'utf8'));
  const links = text.matchAll(/!?\[[^\]]*\]\(([^)\n]+)\)/g);
  for (const match of links) {
    const target = localTarget(match[1]);
    if (target === null) continue;
    checkedLinks += 1;
    const absolute = resolve(dirname(file), target);
    if (!existsSync(absolute)) failures.push(`${file.slice(root.length + 1)} -> ${target}`);
  }
}

if (failures.length) {
  console.error(`文档链接检查失败：${failures.length} 个目标不存在`);
  for (const failure of failures) console.error(`- ${failure}`);
}

const docsRoot = resolve(root, 'docs');
const architectureRoot = join(docsRoot, '02-设计/架构');
const allowedArchitectureRootFiles = new Set([
  '索引.md',
  '系统总览.md',
  '_架构设计模板.md',
]);

for (const name of readdirSync(architectureRoot)) {
  const path = join(architectureRoot, name);
  if (statSync(path).isFile() && name.endsWith('.md') && !allowedArchitectureRootFiles.has(name)) {
    structureFailures.push(
      `架构专题必须归入 运行时/数据/安全/能力/交付/归档/历史：${name}`,
    );
  }
}

const architectureTopics = ['运行时', '数据', '安全', '能力', '交付'];
for (const topic of architectureTopics) {
  const topicRoot = join(architectureRoot, topic);
  if (!existsSync(topicRoot)) {
    structureFailures.push(`缺少架构分类目录：架构/${topic}`);
    continue;
  }
  for (const name of readdirSync(topicRoot)) {
    const path = join(topicRoot, name);
    if (!statSync(path).isFile() || !name.endsWith('.md')) continue;
    const text = readFileSync(path, 'utf8');
    if (!/^#\s+\S/m.test(text)) structureFailures.push(`${topic}/${name} 缺少一级标题`);
    if (!/状态(?:\s*[:：|]|\s*\|\s*)/.test(text.slice(0, 3000))) {
      structureFailures.push(`${topic}/${name} 未在前部标注文档状态`);
    }
  }
}

const prdRoot = join(docsRoot, '02-设计/产品/产品需求');
for (const name of readdirSync(prdRoot)) {
  if (!/^产品需求-\d+.*\.md$/.test(name)) continue;
  const text = readFileSync(join(prdRoot, name), 'utf8');
  for (const [label, pattern] of [
    ['文档编号', /\|\s*文档编号\s*\|/],
    ['状态', /\|\s*状态\s*\|/],
    ['范围', /\|\s*范围\s*\|/],
    ['验收章节', /^##\s+.*验收/m],
    ['变更记录章节', /^##\s+.*变更/m],
  ]) {
    if (!pattern.test(text)) structureFailures.push(`${name} 缺少${label}`);
  }
}

const competitorRoot = join(docsRoot, '01-研究/竞品');
for (const name of readdirSync(competitorRoot)) {
  if (/^workbuddy-.*\.(?:md|json)$/.test(name) || /^claude-code-(?:internals|loop)\.md$/.test(name)) {
    structureFailures.push(`竞品结论不得继续平铺，应合并到主卡或移入 evidence/：${name}`);
  }
}

function walk(path) {
  const entries = [];
  for (const name of readdirSync(path)) {
    const current = join(path, name);
    entries.push(current);
    if (statSync(current).isDirectory()) entries.push(...walk(current));
  }
  return entries;
}

for (const path of walk(docsRoot)) {
  const relative = path.slice(docsRoot.length + 1);
  if (statSync(path).isDirectory()) {
    if (/[A-Za-z]/.test(path.split('/').at(-1))) {
      structureFailures.push(`文档目录名应使用中文：${relative}`);
    }
    continue;
  }
  const stem = path.split('/').at(-1).replace(/\.[^.]+$/, '');
  if (!(relative === 'README.md') && /[A-Za-z]/.test(stem)) {
    structureFailures.push(`文档文件名应使用中文：${relative}`);
  }
}

if (failures.length || structureFailures.length) {
  if (structureFailures.length) {
    console.error(`文档结构检查失败：${structureFailures.length} 项`);
    for (const failure of structureFailures) console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(
  `文档检查通过：${checkedFiles} 个文件，${checkedLinks} 个本地链接，结构规则通过`,
);
