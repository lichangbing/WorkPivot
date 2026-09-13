/**
 * Node 专用入口：数据目录路径（数据目录规范 v0.1）与文件日志。
 * 渲染层禁止 import 本入口（browser 不安全）。
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createTagLogger, type TagLogger } from './index.js';
import { currentTenant } from './tenant-scope.js';
export { currentTenant, runInTenant, type TenantScope } from './tenant-scope.js';
export { canonicalPath, pathWithin, requireWithin } from './path-guard.js';

/** 数据根：~/.workpivot（env WORKPIVOT_HOME 可覆盖）。工作区根在 ~/WorkPivot/workspace，勿混淆。 */
export function workpivotHome(): string {
  return currentTenant()?.home ?? process.env['WORKPIVOT_HOME'] ?? join(homedir(), '.workpivot');
}

function localDateStamp(now = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** K03：按天写 logs/YYYY-MM-DD/<tag>.log，同时输出 console。
 *  说明：日志允许非原子追加；业务持久化必须走 store 层（T1-08），不走本函数。 */
export function createFileTagLogger(tag: string): TagLogger {
  const consoleLogger = createTagLogger(tag);
  const mirror = (level: 'debug' | 'info' | 'warn' | 'error', message: string, extra: unknown[]): void => {
    try {
      const dir = join(workpivotHome(), 'logs', localDateStamp());
      mkdirSync(dir, { recursive: true });
      const parts = [message];
      for (const item of extra) parts.push(typeof item === 'string' ? item : JSON.stringify(item));
      appendFileSync(join(dir, `${tag.toLowerCase()}.log`), `${new Date().toISOString()} ${level.toUpperCase()} ${parts.join(' ')}\n`);
    } catch {
      // 日志镜像失败不阻塞主流程（console 已有输出）
    }
  };

  return {
    debug: (m, ...e) => {
      consoleLogger.debug(m, ...e);
      mirror('debug', m, e);
    },
    info: (m, ...e) => {
      consoleLogger.info(m, ...e);
      mirror('info', m, e);
    },
    warn: (m, ...e) => {
      consoleLogger.warn(m, ...e);
      mirror('warn', m, e);
    },
    error: (m, ...e) => {
      consoleLogger.error(m, ...e);
      mirror('error', m, e);
    },
  };
}
