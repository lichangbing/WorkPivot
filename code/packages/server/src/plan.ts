/**
 * M1-12/A03：计划工具（类 TodoWrite 的 update_plan）。
 * 语义：全量替换当前计划（主线条目 ≤ MAX_PLAN_STEPS），状态 pending/in_progress/completed；
 * 持久化 data/tasks/<id>/plan.json（应用数据，与工作产物分离）；
 * 每次更新经 SSE plan_update 事件推给前端渲染计划卡。
 */
import { join } from 'node:path';
import type { Tool } from '@workpivot/core';
import { ensureWorkpivotDir, readJsonSafe, writeAtomicWithBackup } from './store.js';

export type PlanStatus = 'pending' | 'in_progress' | 'completed';
export interface PlanStep {
  step: string;
  status: PlanStatus;
}

/** 主线条目上限：计划=阶段级主线，不是细粒度 checklist。 */
export const MAX_PLAN_STEPS = 20;

function planPath(taskId: string): string {
  return join(ensureWorkpivotDir('data', 'tasks', taskId), 'plan.json');
}

export function readPlan(taskId: string): PlanStep[] {
  return readJsonSafe<{ steps: PlanStep[] }>(planPath(taskId), { steps: [] }, (v) => Boolean(v && typeof v === 'object' && Array.isArray((v as { steps?: unknown }).steps))).value.steps;
}

function savePlan(taskId: string, steps: PlanStep[]): void {
  writeAtomicWithBackup(planPath(taskId), JSON.stringify({ steps }, null, 2));
}

type Send = (payload: unknown) => void;

export function buildPlanTool(taskId: string, send: Send): Tool {
  return {
    name: 'update_plan',
    kind: 'read',
    description:
      `更新当前任务的阶段计划（全量替换）。多步任务开工前先建立计划；每完成一个阶段或计划变化时更新。` +
      `规则：条目是阶段级主线，不超过 ${MAX_PLAN_STEPS} 条；同一时间只应有一个 in_progress；全部完成即结束。`,
    parameters: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          description: '完整的计划条目列表（全量替换，不是增量）',
          items: {
            type: 'object',
            properties: {
              step: { type: 'string', description: '阶段描述，一句话' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: '状态' },
            },
            required: ['step', 'status'],
          },
        },
      },
      required: ['steps'],
    },
    async run(args) {
      const raw = args['steps'];
      if (!Array.isArray(raw) || raw.length === 0) return '错误：steps 必须是非空数组';
      const steps: PlanStep[] = [];
      for (const item of raw) {
        if (typeof item !== 'object' || item === null) return '错误：steps 条目必须是对象';
        const it = item as Record<string, unknown>;
        const step = String(it['step'] ?? '').trim();
        const status = it['status'];
        if (step === '') return '错误：step 必填';
        if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') {
          return `错误：status 非法（${String(status)}），应为 pending/in_progress/completed`;
        }
        steps.push({ step, status });
      }
      if (steps.length > MAX_PLAN_STEPS) return `错误：计划条目超过 ${MAX_PLAN_STEPS} 条上限——计划应是阶段级主线，请合并`;
      savePlan(taskId, steps);
      send({ type: 'plan_update', steps });
      return `计划已更新（${steps.length} 条，${steps.filter((s) => s.status === 'completed').length} 条已完成）。继续执行当前阶段。`;
    },
  };
}
