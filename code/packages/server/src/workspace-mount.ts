/**
 * 把任务目录换算成“工作区卷内的相对子路径”，供 worker 以 volume-subpath 方式直接挂载。
 *
 * 只允许挂载工作区内部的子目录：工作区根、绝对路径、含 .. 的路径都返回 null，
 * 调用方据此回退到快照模式。这样沙箱最多只能看到这一个任务目录，看不到其他账号。
 */
import { isAbsolute, relative, sep } from 'node:path';

export function workspaceSubpath(taskDir: string, workspaceRoot: string): string | null {
  const rel = relative(workspaceRoot, taskDir);
  if (!rel || isAbsolute(rel)) return null;
  const parts = rel.split(sep);
  if (parts.some((part) => !part || part === '.' || part === '..')) return null;
  const subpath = parts.join('/');
  return subpath.length > 0 && subpath.length <= 512 ? subpath : null;
}
