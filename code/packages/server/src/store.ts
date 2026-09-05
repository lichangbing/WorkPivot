/**
 * K02 store 层：所有业务持久化的唯一写入通道。
 * 三原则：原子写（tmp→rename）+ .bak 兜底 + 坏文件隔离（*.corrupt）。
 * 注意：工作区交付物（用户可见产物）直接写盘（B01），不走本层；
 *       日志允许直接追加；本层管的是 ~/.workpivot 下的应用数据。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { workpivotHome } from '@workpivot/shared/node';

function ensureDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

/** 原子写：写同目录 tmp 临时文件 → rename 到目标。文本按 UTF-8。 */
export function writeAtomic(path: string, data: string): void {
  ensureDir(path);
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, data, 'utf8');
  renameSync(tmp, path);
}

/** 覆盖前把旧文件保留一代 .bak。 */
export function writeAtomicWithBackup(path: string, data: string): void {
  ensureDir(path);
  if (existsSync(path)) {
    try {
      const bak = `${path}.bak`;
      if (existsSync(bak)) rmSync(bak);
      renameSync(path, bak);
    } catch {
      // .bak 失败不阻塞主写入
    }
  }
  writeAtomic(path, data);
}

export interface ReadResult {
  ok: boolean;
  data: string | null;
  /** 'missing'=不存在；'bak'=正常读取；'corrupt-bak'=原文件损坏已隔离、从 .bak 恢复；'corrupt-missing'=损坏且无备份 */
  source?: 'missing' | 'bak' | 'corrupt-bak' | 'corrupt-missing';
}

/** 安全读：解析失败/读取失败时隔离为 *.corrupt，并尝试回退 .bak。 */
export function readTextSafe(path: string): ReadResult {
  if (!existsSync(path)) return { ok: false, data: null, source: 'missing' };
  try {
    return { ok: true, data: readFileSync(path, 'utf8'), source: 'bak' };
  } catch {
    return quarantineAndFallback(path);
  }
}

function quarantineAndFallback(path: string): ReadResult {
  try {
    renameSync(path, `${path}.corrupt`);
  } catch {
    /* 忽略 */
  }
  const bak = `${path}.bak`;
  if (existsSync(bak)) {
    try {
      return { ok: true, data: readFileSync(bak, 'utf8'), source: 'corrupt-bak' };
    } catch {
      return { ok: false, data: null, source: 'corrupt-missing' };
    }
  }
  return { ok: false, data: null, source: 'corrupt-missing' };
}

/** 读 JSON：损坏自动隔离+回退 .bak，最终失败返回 fallback。 */
export function readJsonSafe<T>(path: string, fallback: T): { value: T; source: ReadResult['source'] } {
  const result = readTextSafe(path);
  if (!result.ok || result.data === null) return { value: fallback, source: result.source };
  try {
    return { value: JSON.parse(result.data) as T, source: result.source };
  } catch {
    return { value: fallback, source: quarantineAndFallback(path).source ?? 'corrupt-missing' };
  }
}

/** 追加一行（转写/审计/索引用；append 语义）。 */
export function appendLine(path: string, line: string): void {
  ensureDir(path);
  appendFileSync(path, `${line}\n`, 'utf8');
}

/** 确保数据根子目录存在（幂等），返回绝对路径。 */
export function ensureWorkpivotDir(...segments: string[]): string {
  const dir = join(workpivotHome(), ...segments);
  mkdirSync(dir, { recursive: true });
  return dir;
}
