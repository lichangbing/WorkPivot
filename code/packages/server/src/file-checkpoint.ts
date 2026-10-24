/**
 * R006 P3：文件链路的检查点与对账。
 *
 * 数据库链路把完整消息存在 `task_runs.model_messages`；文件链路没有这张表，
 * 这里把每个 step 的消息快照写到 `<任务目录>/.workpivot/runs/<runId>/messages.json`，
 * 启动或下次执行时按同一套 `reconcileMessages` 规则补齐未闭合的工具调用并标记中断。
 *
 * 边界：只保证"历史合法 + 标记中断"，暂不做自动续跑（文件链路正被数据库链路替代）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatMessage } from '@workpivot/core';
import { reconcileMessages } from './database/recovery.js';

const STALE_MS = 2 * 60_000;

export interface FileRunState {
  status: 'running' | 'completed' | 'interrupted' | 'aborted';
  at: string;
  repaired?: number;
}

function runDir(taskDir: string, runId: string): string {
  return join(taskDir, '.workpivot', 'runs', runId);
}

function writeJson(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.tmp`;
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(temporary, JSON.stringify(value), 'utf8');
  renameSync(temporary, path);
}

/** 写入当前 step 的消息快照（覆盖式，原子替换；单轮上限 2MB）。 */
export function writeFileCheckpoint(taskDir: string, runId: string, messages: ChatMessage[]): void {
  if (JSON.stringify(messages).length > 2_000_000) return;
  const directory = runDir(taskDir, runId);
  writeJson(join(directory, 'messages.json'), messages);
  writeJson(join(directory, 'state.json'), { status: 'running', at: new Date().toISOString() } satisfies FileRunState);
}

export function finishFileCheckpoint(taskDir: string, runId: string, status: FileRunState['status']): void {
  const directory = runDir(taskDir, runId);
  if (!existsSync(directory)) return;
  try { writeJson(join(directory, 'state.json'), { status, at: new Date().toISOString() } satisfies FileRunState); } catch { /* 状态写失败不影响主流程 */ }
}

/**
 * 对账一个任务目录下所有"仍在 running 且已过期"的运行：
 * 补齐未闭合的 tool_call，改写快照，并把状态标为 interrupted。返回修复记录。
 */
export function reconcileFileCheckpoints(taskDir: string, now = Date.now()): Array<{ runId: string; repaired: number }> {
  const root = join(taskDir, '.workpivot', 'runs');
  if (!existsSync(root)) return [];
  const results: Array<{ runId: string; repaired: number }> = [];
  for (const runId of readdirSync(root)) {
    const directory = join(root, runId);
    try {
      const statePath = join(directory, 'state.json');
      const messagesPath = join(directory, 'messages.json');
      if (!existsSync(statePath) || !existsSync(messagesPath)) continue;
      const state = JSON.parse(readFileSync(statePath, 'utf8')) as FileRunState;
      if (state.status !== 'running') continue;
      const updatedAt = Date.parse(state.at);
      if (Number.isFinite(updatedAt) && now - updatedAt < STALE_MS) continue;
      const messages = JSON.parse(readFileSync(messagesPath, 'utf8')) as ChatMessage[];
      const { messages: fixed, repaired } = reconcileMessages(messages);
      if (repaired.length) writeJson(messagesPath, fixed);
      writeJson(statePath, { status: 'interrupted', at: new Date(now).toISOString(), repaired: repaired.length } satisfies FileRunState);
      results.push({ runId, repaired: repaired.length });
    } catch { /* 单个运行目录损坏不影响其他任务 */ }
  }
  return results;
}

/** 最近一次运行的快照与状态，供"可继续"提示与排障使用。 */
export function latestFileCheckpoint(taskDir: string): { runId: string; state: FileRunState; messages: ChatMessage[] } | null {
  const root = join(taskDir, '.workpivot', 'runs');
  if (!existsSync(root)) return null;
  const runs = readdirSync(root).sort();
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const runId = runs[index]!;
    const directory = join(root, runId);
    try {
      const state = JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8')) as FileRunState;
      const messages = JSON.parse(readFileSync(join(directory, 'messages.json'), 'utf8')) as ChatMessage[];
      return { runId, state, messages };
    } catch { continue; }
  }
  return null;
}

/** 清理已结束且过旧的运行快照（默认保留 20 份）。 */
export function pruneFileCheckpoints(taskDir: string, keep = 20): void {
  const root = join(taskDir, '.workpivot', 'runs');
  if (!existsSync(root)) return;
  const runs = readdirSync(root).sort();
  for (const runId of runs.slice(0, Math.max(0, runs.length - keep))) {
    try { rmSync(join(root, runId), { recursive: true, force: true }); } catch { /* 清理失败不影响执行 */ }
  }
}
