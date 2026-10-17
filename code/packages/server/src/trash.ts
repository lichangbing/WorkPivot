/**
 * M1-10/B03：回收站。删除的目录不再直接 rm，而是移入 ~/.workpivot/trash/<label>-<ts>/，
 * 附 manifest.json 记录原路径与删除时间（保留可恢复线索；清理策略后续版本提供）。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ensureWorkpivotDir } from './store.js';

/** 跨 Docker 卷或物理磁盘删除前，先保存完整备份。 */
export function moveToTrash(absPath: string, label: string): { ok: boolean; trashPath?: string; error?: string } {
  if (!existsSync(absPath)) return { ok: true };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeLabel = label.replace(/[^\w.-]/g, '_');
  const trashPath = join(ensureWorkpivotDir('trash'), `${safeLabel}-${stamp}-${randomUUID()}`);
  let copied = false;
  try {
    mkdirSync(trashPath, { recursive: true });
    // 先落 manifest 再移入（同目录下放被删内容本体）
    writeFileSync(
      join(trashPath, 'manifest.json'),
      JSON.stringify({ originalPath: absPath, deletedAt: new Date().toISOString(), label }, null, 2),
      'utf8',
    );
    try { renameSync(absPath, join(trashPath, 'payload')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
      cpSync(absPath, join(trashPath, 'payload'), { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false });
      copied = true;
      rmSync(absPath, { recursive: true });
    }
    return { ok: true, trashPath };
  } catch (err) {
    // 源数据清理失败时，保留完整备份用于恢复。
    if (!copied) rmSync(trashPath, { recursive: true, force: true });
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 回收站清单（管理/恢复用）。 */
export function listTrash(): Array<{ name: string; originalPath?: string; deletedAt?: string }> {
  const root = ensureWorkpivotDir('trash');
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      try {
        const manifest = JSON.parse(readFileSync(join(root, e.name, 'manifest.json'), 'utf8')) as {
          originalPath?: string;
          deletedAt?: string;
        };
        return { name: e.name, originalPath: manifest.originalPath, deletedAt: manifest.deletedAt };
      } catch {
        return { name: e.name };
      }
    })
    .sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? ''));
}
