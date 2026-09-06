/**
 * T2-07/I03：审计日志。按天 JSONL：时间/用户/任务/事件/工具/参数摘要/风险决策。
 * 不记录参数原文敏感值，只记摘要与哈希。
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendLine, ensureWorkpivotDir } from './store.js';

export interface AuditEntry {
  ts?: string;
  user?: string;
  taskId?: string;
  event: string;
  tool?: string;
  detail?: string;
  argsHash?: string;
  decision?: string;
}

function localDate(): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  const d = new Date();
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function audit(entry: AuditEntry): void {
  const dir = ensureWorkpivotDir('audit');
  const row = {
    ts: entry.ts ?? new Date().toISOString(),
    user: entry.user ?? 'local',
    taskId: entry.taskId,
    event: entry.event,
    tool: entry.tool,
    decision: entry.decision,
    argsHash: entry.argsHash,
    detail: entry.detail,
  };
  appendLine(join(dir, `audit-${localDate()}.jsonl`), JSON.stringify(row));
}

export function argsHash(args: unknown): string {
  return createHash('sha256').update(JSON.stringify(args ?? {})).digest('hex').slice(0, 16);
}

/** M1-10/I03：导出全部审计日志（按天文件合并，时间升序）。 */
export function readAllAudit(): string[] {
  const dir = ensureWorkpivotDir('audit');
  if (!existsSync(dir)) return [];
  const rows: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.startsWith('audit-') && f.endsWith('.jsonl')).sort()) {
    for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
      if (line.trim() !== '') rows.push(line);
    }
  }
  return rows;
}
