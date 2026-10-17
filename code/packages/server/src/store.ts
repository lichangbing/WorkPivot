/**
 * K02 store 层：所有业务持久化的唯一写入通道。
 * 三原则：原子写（tmp→rename）+ .bak 兜底 + 坏文件隔离（*.corrupt）。
 * 注意：工作区交付物（用户可见产物）直接写盘（B01），不走本层；
 *       日志允许直接追加；本层管的是 ~/.workpivot 下的应用数据。
 */
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
    // 替代文件就绪前保留主文件；备份失败必须停止更新。
    writeAtomic(`${path}.bak`, readFileSync(path, 'utf8'));
  }
  writeAtomic(path, data);
}

export interface ReadResult {
  ok: boolean;
  data: string | null;
  /** 'missing'=不存在；'bak'=正常读取；'corrupt-bak'=原文件损坏已隔离、从 .bak 恢复；'corrupt-missing'=损坏且无备份 */
  source?: 'missing' | 'primary' | 'bak' | 'corrupt-bak' | 'corrupt-missing';
}

/** 安全读：解析失败/读取失败时隔离为 *.corrupt，并尝试回退 .bak。 */
export function readTextSafe(path: string): ReadResult {
  if (!existsSync(path)) return { ok: false, data: null, source: 'missing' };
  try {
    return { ok: true, data: readFileSync(path, 'utf8'), source: 'primary' };
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

export class DataIntegrityError extends Error {
  constructor() { super('应用数据损坏，无法安全读取；请管理员检查备份并恢复后重试'); this.name = 'DataIntegrityError'; }
}

/** 默认值只用于从未创建的数据；存储损坏不得重新开放初始化。 */
export function readJsonSafe<T>(path: string, fallback: T, validate?: (value: unknown) => boolean): { value: T; source: ReadResult['source'] } {
  const primary = existsSync(path);
  const backup = existsSync(`${path}.bak`);
  if (!primary && !backup && !existsSync(`${path}.corrupt`)) return { value: structuredClone(fallback), source: 'missing' };
  const parse = (file: string): T => {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (validate && !validate(value)) throw new DataIntegrityError();
    return value as T;
  };
  if (primary) {
    try { return { value: parse(path), source: 'primary' }; } catch { /* 尝试读取经过校验的备份。 */ }
  }
  let value: T;
  try { value = parse(`${path}.bak`); } catch { throw new DataIntegrityError(); }
  if (primary) copyFileSync(path, `${path}.corrupt`);
  writeAtomic(path, JSON.stringify(value, null, 2));
  return { value, source: 'corrupt-bak' };
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
