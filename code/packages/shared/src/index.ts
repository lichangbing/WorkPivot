/**
 * 浏览器安全入口：不依赖 node 内置模块，React 渲染层可直接 import。
 * Node 侧（文件日志、数据目录路径）请使用 `@workpivot/shared/node`。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export { API_PROTOCOL, SERVICE_VERSION, CompatibilityError, checkServiceHealth } from './service-health.js';

export interface TagLogger {
  debug(message: string, ...extra: unknown[]): void;
  info(message: string, ...extra: unknown[]): void;
  warn(message: string, ...extra: unknown[]): void;
  error(message: string, ...extra: unknown[]): void;
}

/** K03：三源日志统一带源标签（[MAIN]/[NODE]/[REACT]），一行一事件。 */
export function createTagLogger(tag: string): TagLogger {
  const emit = (level: LogLevel, message: string, extra: unknown[]): void => {
    const line = `[${tag}] ${message}`;
    if (level === 'error') console.error(line, ...extra);
    else if (level === 'warn') console.warn(line, ...extra);
    else if (level === 'debug') console.debug(line, ...extra);
    else console.log(line, ...extra);
  };

  return {
    debug: (m, ...e) => emit('debug', m, e),
    info: (m, ...e) => emit('info', m, e),
    warn: (m, ...e) => emit('warn', m, e),
    error: (m, ...e) => emit('error', m, e),
  };
}

export * from './automation.js';
