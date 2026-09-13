import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Resolve existing ancestors before appending a not-yet-created leaf. Dangling links fail closed. */
export function canonicalPath(path: string, base = process.cwd()): string {
  if (typeof path !== 'string' || path.includes('\0')) throw new Error('无效路径');
  if (process.platform === 'win32' && (/^[\\/]{2}[?.]/.test(path) || /:/.test(path.replace(/^[a-z]:/i, '')) || /^[a-z]:[^\\/]/i.test(path))) {
    throw new Error('不支持设备路径、数据流或盘符相对路径');
  }
  let cursor = resolve(base, path);
  const suffix: string[] = [];
  for (;;) {
    try {
      lstatSync(cursor);
      const real = join(realpathSync.native(cursor), ...suffix.reverse());
      return process.platform === 'win32' ? real.toLowerCase() : real;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      // If lstat succeeds but realpath fails, this is a dangling link: never treat it as a new file.
      try { if (lstatSync(cursor).isSymbolicLink()) throw new Error('路径包含失效符号链接'); }
      catch (check) { if ((check as NodeJS.ErrnoException).code !== 'ENOENT') throw check; }
      const parent = dirname(cursor);
      if (parent === cursor) throw new Error('无法解析路径根目录');
      suffix.push(basename(cursor));
      cursor = parent;
    }
  }
}

export function pathWithin(path: string, root: string): boolean {
  const rel = relative(canonicalPath(root), canonicalPath(path));
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
}

export function requireWithin(path: string, root: string): string {
  const actual = canonicalPath(path, root);
  if (!pathWithin(actual, root)) throw new Error('路径越界：不在允许的工作目录内');
  return actual;
}
