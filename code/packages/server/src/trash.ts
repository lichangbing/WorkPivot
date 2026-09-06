/**
 * M1-10/B03：回收站。删除的目录不再直接 rm，而是移入 ~/.workpivot/trash/<label>-<ts>/，
 * 附 manifest.json 记录原路径与删除时间（保留可恢复线索；清理策略后续版本提供）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureWorkpivotDir } from './store.js';

/** 移入回收站（跨盘 rename 会失败，回退到复制删除由调用方决定是否直接删）。 */
export function moveToTrash(absPath: string, label: string): { ok: boolean; trashPath?: string; error?: string } {
  if (!existsSync(absPath)) return { ok: true };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeLabel = label.replace(/[^\w.-]/g, '_');
  const trashPath = join(ensureWorkpivotDir('trash'), `${safeLabel}-${stamp}`);
  try {
    mkdirSync(trashPath, { recursive: true });
    // 先落 manifest 再移入（同目录下放被删内容本体）
    writeFileSync(
      join(trashPath, 'manifest.json'),
      JSON.stringify({ originalPath: absPath, deletedAt: new Date().toISOString(), label }, null, 2),
      'utf8',
    );
    renameSync(absPath, join(trashPath, 'payload'));
    return { ok: true, trashPath };
  } catch (err) {
    // 回收失败不阻塞删除语义：清掉半成品后返回错误，由调用方决定
    rmSync(trashPath, { recursive: true, force: true });
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
