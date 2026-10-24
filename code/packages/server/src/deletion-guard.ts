/**
 * O-19：删除保护。
 *
 * bash 与 run_code 都能直接删除工作目录里的文件，挂载模式没有快照回写与回收站，
 * 一旦误删不可恢复。这里在执行前记录文件清单，并把体量可控的小文件复制到
 * `.workpivot/trash/<时间戳>/`；执行后对比清单，把被删文件与恢复路径一起回给模型与用户。
 *
 * 边界：只覆盖执行前存在、体积在预算内的文件；超出预算时仍会列出被删文件，
 * 但没有副本可恢复（在结果里明确说明）。符号链接与特殊文件不复制。
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

const SKIP_DIRS = new Set(['node_modules', '.git', '.workpivot', 'dist', 'build', 'out', '__pycache__', '.venv']);
const MAX_FILES = 5000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

interface Snapshot {
  files: Map<string, { size: number; mtimeMs: number }>;
  trashDir: string | null;
  copied: number;
  skipped: number;
}

function walk(root: string): string[] {
  const result: string[] = [];
  const stack: string[] = [''];
  while (stack.length && result.length < MAX_FILES) {
    const current = stack.pop()!;
    let entries: string[];
    try { entries = readdirSync(join(root, current)); } catch { continue; }
    for (const name of entries) {
      if (result.length >= MAX_FILES) break;
      const rel = current ? join(current, name) : name;
      if (SKIP_DIRS.has(name)) continue;
      let stat;
      try { stat = lstatSync(join(root, rel)); } catch { continue; }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) { stack.push(rel); continue; }
      if (stat.isFile()) result.push(rel);
    }
  }
  return result;
}

function takeSnapshot(root: string, stamp: string): Snapshot {
  const files = new Map<string, { size: number; mtimeMs: number }>();
  let trashDir: string | null = null;
  let copied = 0;
  let skipped = 0;
  let total = 0;
  for (const rel of walk(root)) {
    const abs = join(root, rel);
    try {
      const stat = statSync(abs);
      files.set(rel, { size: stat.size, mtimeMs: stat.mtimeMs });
      if (stat.size > MAX_FILE_BYTES || total + stat.size > MAX_TOTAL_BYTES) { skipped += 1; continue; }
      trashDir ??= join(root, '.workpivot', 'trash', stamp);
      const target = join(trashDir, rel);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(abs, target);
      total += stat.size;
      copied += 1;
    } catch { skipped += 1; }
  }
  return { files, trashDir, copied, skipped };
}

/** 执行一次可能删除文件的命令，并在结果后附加被删清单与恢复路径。 */
export async function guardDeletions<T extends string>(taskDir: string, run: () => Promise<T>): Promise<T> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const before = takeSnapshot(taskDir, stamp);
  const output = await run();
  let after: string[];
  try { after = walk(taskDir); } catch { return output; }
  const alive = new Set(after);
  const deleted = [...before.files.keys()].filter((rel) => !alive.has(rel));
  if (deleted.length === 0) return output;

  const restoreRoot = join('.workpivot', 'trash', stamp);
  const canRestore = before.trashDir !== null;
  const slash = (value: string) => value.split(sep).join('/');
  const lines = deleted.slice(0, 20).map((rel) => {
    const backup = join(before.trashDir ?? restoreRoot, rel);
    return existsSync(backup)
      ? `  - ${slash(rel)}（副本：${slash(relative(taskDir, backup))}）`
      : `  - ${slash(rel)}（无副本）`;
  });
  const more = deleted.length > 20 ? `\n  …另有 ${deleted.length - 20} 个文件被删除` : '';
  const hint = canRestore
    ? `\n可用 read/write 从 ${restoreRoot} 取回副本，确认无用后自行清理。`
    : '\n本次未保留副本（文件过大或超出预算），无法自动恢复。';
  return `${output}\n\n[删除提示] 本次执行删除了 ${deleted.length} 个文件：\n${lines.join('\n')}${more}${hint}` as T;
}
