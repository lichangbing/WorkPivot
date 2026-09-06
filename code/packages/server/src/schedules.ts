/**
 * M1-09/F06：定时任务调度器。
 * - 注册表 data/schedules/schedules.json；通知 data/schedules/notifications.jsonl。
 * - cron：5 字段（分 时 日 月 周）自研匹配器，支持 通配/步进/区间/列表——分钟粒度。
 * - 执行：进程内自调用本机 HTTP（复用完整对话管线：技能/记忆/计划/闸门/转写），不动 SSE 路由。
 * - 错过补跑（catchup=true）：启动扫描 lastRunAt→now 的错过窗口（封顶 7 天），有匹配则补跑一次。
 * - tick 间隔 WORKPIVOT_SCHEDULE_TICK_MS（默认 30s，评测可调小）。
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureWorkpivotDir, readJsonSafe, writeAtomic } from './store.js';
import { issueTokenForUser } from './auth.js';
import { audit } from './audit.js';

export interface Schedule {
  id: string;
  name: string;
  cron: string;
  /** 每次触发发给任务的消息内容 */
  content: string;
  /** 承载任务名（首次触发时创建，之后复用——转写连续） */
  taskName: string;
  taskId?: string;
  enabled: boolean;
  /** 错过补跑：停机期间错过的触发在下次启动时补跑一次 */
  catchup: boolean;
  ownerUserId: string;
  lastRunAt?: string;
  lastResult?: string;
  createdAt: string;
}

export interface ScheduleNotification {
  ts: string;
  scheduleId: string;
  name: string;
  event: 'run_ok' | 'run_error' | 'missed_catchup' | 'skipped_running';
  detail: string;
}

interface ScheduleRegistry {
  version: 1;
  schedules: Schedule[];
}

const EMPTY: ScheduleRegistry = { version: 1, schedules: [] };
const CATCHUP_SCAN_MAX_MINUTES = 7 * 24 * 60; // 补跑扫描窗口封顶 7 天

function registryPath(): string {
  return join(ensureWorkpivotDir('data', 'schedules'), 'schedules.json');
}
function notificationsPath(): string {
  return join(ensureWorkpivotDir('data', 'schedules'), 'notifications.jsonl');
}

function load(): ScheduleRegistry {
  return readJsonSafe<ScheduleRegistry>(registryPath(), EMPTY).value;
}
function save(registry: ScheduleRegistry): void {
  writeAtomic(registryPath(), JSON.stringify(registry, null, 2));
}

export function listSchedules(): Schedule[] {
  return load().schedules;
}

export function getSchedule(id: string): Schedule | null {
  return load().schedules.find((s) => s.id === id) ?? null;
}

function persistSchedule(schedule: Schedule): void {
  const registry = load();
  const idx = registry.schedules.findIndex((s) => s.id === schedule.id);
  if (idx >= 0) registry.schedules[idx] = schedule;
  else registry.schedules.push(schedule);
  save(registry);
}

export function addSchedule(input: {
  name: string; cron: string; content: string; taskName: string; catchup: boolean; ownerUserId: string;
}): Schedule {
  if (!cronIsValid(input.cron)) throw new Error(`cron 表达式非法：${input.cron}`);
  const schedule: Schedule = {
    id: randomUUID(),
    name: input.name,
    cron: input.cron,
    content: input.content,
    taskName: input.taskName,
    enabled: true,
    catchup: input.catchup,
    ownerUserId: input.ownerUserId,
    createdAt: new Date().toISOString(),
  };
  persistSchedule(schedule);
  return schedule;
}

export function updateSchedule(id: string, patch: { name?: string; cron?: string; content?: string; enabled?: boolean; catchup?: boolean }): Schedule {
  const registry = load();
  const schedule = registry.schedules.find((s) => s.id === id);
  if (!schedule) throw new Error(`定时任务不存在：${id}`);
  if (patch.cron !== undefined && !cronIsValid(patch.cron)) throw new Error(`cron 表达式非法：${patch.cron}`);
  Object.assign(schedule, patch);
  save(registry);
  return schedule;
}

export function deleteSchedule(id: string): void {
  const registry = load();
  if (!registry.schedules.some((s) => s.id === id)) throw new Error(`定时任务不存在：${id}`);
  registry.schedules = registry.schedules.filter((s) => s.id !== id);
  save(registry);
}

export function listNotifications(limit = 100): ScheduleNotification[] {
  if (!existsSync(notificationsPath())) return [];
  const rows: ScheduleNotification[] = [];
  for (const line of readFileSync(notificationsPath(), 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      rows.push(JSON.parse(line) as ScheduleNotification);
    } catch {
      /* 坏行跳过 */
    }
  }
  return rows.slice(-limit);
}

function notify(event: ScheduleNotification['event'], schedule: Schedule, detail: string): void {
  const row: ScheduleNotification = {
    ts: new Date().toISOString(),
    scheduleId: schedule.id,
    name: schedule.name,
    event,
    detail,
  };
  writeFileSync(notificationsPath(), JSON.stringify(row) + '\n', { flag: 'a' });
  audit({ user: 'scheduler', event: `schedule_${event}`, detail: `${schedule.name}: ${detail}` });
}

// ---- cron 匹配（5 字段，分钟粒度） ----

function fieldMatches(field: string, value: number, min: number): boolean {
  for (const part of field.split(',')) {
    const stepMatch = part.match(/^(\*|\d+(?:-\d+)?)\/(\d+)$/);
    if (stepMatch) {
      const base = stepMatch[1] === '*' ? min : Number(stepMatch[1]);
      const step = Number(stepMatch[2] ?? 1);
      if (step < 1) return false;
      if (value >= base && (value - base) % step === 0) return true;
      if (stepMatch[1] === '*' && value % step === 0) return true; // */n 从 0 起算
      continue;
    }
    const rangeMatch = part.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const lo = Number(rangeMatch[1]);
      const hi = Number(rangeMatch[2] ?? lo);
      if (value >= lo && value <= hi) return true;
      continue;
    }
    if (part === '*') return true;
    if (part !== '' && Number(part) === value) return true;
  }
  return false;
}

export function cronIsValid(cron: string): boolean {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const ranges: Array<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
  return fields.every((f, i) => {
    const [lo, hi] = ranges[i]!;
    return f.split(',').every((part) => {
      if (part === '*') return true;
      if (/^\*\/\d+$/.test(part)) return true;
      if (/^\d+$/.test(part)) {
        const n = Number(part);
        return n >= lo && n <= hi;
      }
      if (/^\d+-\d+$/.test(part)) {
        const [a, b] = part.split('-').map(Number) as [number, number];
        return a >= lo && b <= hi && a <= b;
      }
      return false;
    });
  });
}

export function cronMatch(cron: string, d: Date): boolean {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return (
    fieldMatches(fields[0]!, d.getMinutes(), 0) &&
    fieldMatches(fields[1]!, d.getHours(), 0) &&
    fieldMatches(fields[2]!, d.getDate(), 1) &&
    fieldMatches(fields[3]!, d.getMonth() + 1, 1) &&
    fieldMatches(fields[4]!, d.getDay(), 0)
  );
}

/** 错过窗口（from→now）内是否有任何一分钟匹配（封顶 CATCHUP_SCAN_MAX_MINUTES）。 */
function missedMatches(cron: string, fromIso: string | undefined, now: Date): boolean {
  if (!fromIso) return false; // 从未跑过：按创建时起算无从对比，交给常规 tick
  const from = new Date(fromIso);
  if (Number.isNaN(from.getTime())) return false;
  let cursor = new Date(Math.ceil(from.getTime() / 60_000) * 60_000); // 对齐到分钟
  let scanned = 0;
  while (cursor <= now && scanned < CATCHUP_SCAN_MAX_MINUTES) {
    if (cronMatch(cron, cursor)) return true;
    cursor = new Date(cursor.getTime() + 60_000);
    scanned += 1;
  }
  return false;
}

// ---- 执行器：进程内自调用本机 HTTP，复用完整对话管线 ----

const inFlight = new Set<string>();

async function runSchedule(schedule: Schedule, port: number, trigger: 'tick' | 'manual' | 'catchup'): Promise<void> {
  if (inFlight.has(schedule.id)) {
    notify('skipped_running', schedule, '上一次运行尚未结束，本次跳过');
    return;
  }
  inFlight.add(schedule.id);
  try {
    const token = issueTokenForUser(schedule.ownerUserId);
    if (!token) {
      schedule.lastResult = 'error: 所有者账户不存在';
      persistSchedule(schedule);
      notify('run_error', schedule, schedule.lastResult);
      return;
    }
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };

    // 承载任务：首次创建，之后复用（转写连续）
    let taskId = schedule.taskId;
    if (!taskId) {
      const createResp = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
        method: 'POST', headers, body: JSON.stringify({ name: schedule.taskName }),
      });
      if (!createResp.ok) throw new Error(`创建任务失败 HTTP ${createResp.status}`);
      taskId = ((await createResp.json()) as { task: { id: string } }).task.id;
      schedule.taskId = taskId;
      persistSchedule(schedule);
    }

    // 触发一轮对话：消费完整 SSE 流直到 done/error
    const sseResp = await fetch(`http://127.0.0.1:${port}/api/tasks/${taskId}/messages`, {
      method: 'POST', headers, body: JSON.stringify({ content: schedule.content }),
      signal: AbortSignal.timeout(40 * 60_000),
    });
    if (sseResp.status === 409) {
      schedule.lastResult = 'skipped: 任务运行中';
      persistSchedule(schedule);
      notify('skipped_running', schedule, '任务运行中，本次跳过');
      return;
    }
    if (!sseResp.ok || !sseResp.body) throw new Error(`触发对话失败 HTTP ${sseResp.status}`);
    let outcome = 'unknown';
    const reader = sseResp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const line = buffer.slice(0, idx).split('\n').find((l) => l.startsWith('data:'));
        buffer = buffer.slice(idx + 2);
        if (!line) continue;
        try {
          const ev = JSON.parse(line.slice(5)) as { type?: string; stopReason?: string; message?: string };
          if (ev.type === 'done') outcome = `done:${ev.stopReason ?? '?'}`;
          if (ev.type === 'error') outcome = `error:${ev.message ?? '?'}`;
        } catch {
          /* 非 JSON 行跳过 */
        }
      }
    }
    schedule.lastRunAt = new Date().toISOString();
    schedule.lastResult = outcome.startsWith('done') ? outcome : `error:${outcome}`;
    persistSchedule(schedule);
    if (outcome.startsWith('done')) notify('run_ok', schedule, `${trigger} ${outcome}`);
    else notify('run_error', schedule, `${trigger} ${outcome}`);
  } catch (err) {
    schedule.lastRunAt = new Date().toISOString();
    schedule.lastResult = `error: ${err instanceof Error ? err.message : String(err)}`;
    persistSchedule(schedule);
    notify('run_error', schedule, `${trigger} ${schedule.lastResult}`);
  } finally {
    inFlight.delete(schedule.id);
  }
}

/** 手动立即运行（后台按钮）。 */
export async function runScheduleNow(id: string, port: number): Promise<void> {
  const schedule = getSchedule(id);
  if (!schedule) throw new Error(`定时任务不存在：${id}`);
  await runSchedule(schedule, port, 'manual');
}

// ---- 调度循环 + 启动补跑 ----

export function startScheduler(port: number): { stop: () => void } {
  const tickMs = Number(process.env['WORKPIVOT_SCHEDULE_TICK_MS']) || 30_000;

  // 启动补跑：enabled+catchup 且停机窗口内有匹配 → 补跑一次
  for (const schedule of listSchedules()) {
    if (!schedule.enabled || !schedule.catchup) continue;
    if (missedMatches(schedule.cron, schedule.lastRunAt, new Date())) {
      notify('missed_catchup', schedule, '停机期间有错过的触发，启动补跑一次');
      void runSchedule(schedule, port, 'catchup');
    }
  }

  const timer = setInterval(() => {
    void (async () => {
      const now = new Date();
      const minuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
      for (const schedule of listSchedules()) {
        if (!schedule.enabled) continue;
        if (!cronMatch(schedule.cron, now)) continue;
        // 同一分钟只跑一次（lastRunAt 的分钟键对比）
        if (schedule.lastRunAt) {
          const last = new Date(schedule.lastRunAt);
          const lastKey = `${last.getFullYear()}-${last.getMonth()}-${last.getDate()}-${last.getHours()}-${last.getMinutes()}`;
          if (lastKey === minuteKey) continue;
        }
        await runSchedule(schedule, port, 'tick');
      }
    })();
  }, tickMs);
  timer.unref?.();

  return { stop: () => clearInterval(timer) };
}
