#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entryFiles = ['README.md', 'code/README.md', 'docs', 'releases'];
const failures = [];
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
  process.exit(1);
}

console.log(`文档链接检查通过：${checkedFiles} 个文件，${checkedLinks} 个本地链接`);
