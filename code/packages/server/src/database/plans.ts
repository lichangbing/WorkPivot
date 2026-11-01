import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { PlanDocument, PlanStepView } from '@workpivot/shared';
import type { Tool } from '@workpivot/core';
import { RepositoryError, transaction, uuid } from './connection.js';
import { authorizationDigest } from './tool-authorization.js';

const text = (value: unknown, limit: number): string => {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, limit);
};

const list = (value: unknown, limit = 30): string[] => {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.flatMap((item) => {
    const value = text(item, 1000);
    return value ? [value] : [];
  }))].slice(0, limit);
};

function steps(value: unknown): PlanStepView[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) throw new RepositoryError(400, '计划步骤需要1至20项');
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new RepositoryError(400, `第${index + 1}个计划步骤无效`);
    const source = item as Record<string, unknown>;
    const step = text(source['step'], 1000);
    const status = source['status'];
    if (!step) throw new RepositoryError(400, `第${index + 1}个计划步骤缺少描述`);
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') throw new RepositoryError(400, '计划步骤状态无效');
    return { step, status };
  });
}

interface PlanRow {
  id: string;
  revision: number;
  status: PlanDocument['status'];
  goal: string;
  assumptions: string[];
  data_scope: string[];
  business_rules: string[];
  steps: PlanStepView[];
  external_actions: string[];
  outputs: string[];
  risks: string[];
  verification: string[];
  plan_hash: string;
  updated_at: Date;
}

function document(row: PlanRow): PlanDocument {
  return {
    id: row.id,
    revision: Number(row.revision),
    hash: row.plan_hash,
    status: row.status,
    goal: row.goal,
    assumptions: row.assumptions,
    dataScope: row.data_scope,
    businessRules: row.business_rules,
    steps: row.steps,
    externalActions: row.external_actions,
    outputs: row.outputs,
    risks: row.risks,
    verification: row.verification,
    updatedAt: row.updated_at.toISOString(),
  };
}

export class PlanRepository {
  constructor(private readonly db: Pool) {}

  async latest(actor: string, taskId: string): Promise<PlanDocument | null> {
    uuid(taskId);
    return transaction(this.db, async (c) => {
      const row = (await c.query('SELECT * FROM workpivot.task_plans WHERE task_id=$1 ORDER BY revision DESC LIMIT 1', [taskId])).rows[0];
      return row ? document(row as PlanRow) : null;
    }, actor);
  }

  async save(actor: string, taskId: string, raw: Record<string, unknown>): Promise<PlanDocument> {
    uuid(taskId);
    const normalized = {
      goal: text(raw['goal'], 4000),
      assumptions: list(raw['assumptions']),
      dataScope: list(raw['data_scope']),
      businessRules: list(raw['business_rules']),
      steps: steps(raw['steps']),
      externalActions: list(raw['external_actions']),
      outputs: list(raw['outputs']),
      risks: list(raw['risks']),
      verification: list(raw['verification']),
    };
    if (!normalized.goal) throw new RepositoryError(400, '计划必须填写目标');
    return transaction(this.db, async (c) => {
      await c.query('SELECT id FROM workpivot.tasks WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [taskId]);
      const latest = (await c.query('SELECT revision FROM workpivot.task_plans WHERE task_id=$1 ORDER BY revision DESC LIMIT 1', [taskId])).rows[0];
      const revision = Number(latest?.revision ?? 0) + 1;
      const hash = authorizationDigest({ ...normalized, revision });
      await c.query("UPDATE workpivot.task_plans SET status='superseded',updated_at=now() WHERE task_id=$1 AND status<>'superseded'", [taskId]);
      const row = (await c.query(
        `INSERT INTO workpivot.task_plans(
          id,owner_user_id,task_id,revision,goal,assumptions,data_scope,business_rules,
          steps,external_actions,outputs,risks,verification,plan_hash
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [
          randomUUID(), actor, taskId, revision, normalized.goal,
          JSON.stringify(normalized.assumptions), JSON.stringify(normalized.dataScope),
          JSON.stringify(normalized.businessRules), JSON.stringify(normalized.steps),
          JSON.stringify(normalized.externalActions), JSON.stringify(normalized.outputs),
          JSON.stringify(normalized.risks), JSON.stringify(normalized.verification), hash,
        ],
      )).rows[0];
      return document(row as PlanRow);
    }, actor);
  }

  async markApproved(actor: string, taskId: string, id: string, revision: number): Promise<void> {
    uuid(taskId);
    uuid(id);
    await transaction(this.db, async (c) => {
      await c.query(
        "UPDATE workpivot.task_plans SET status='approved',updated_at=now() WHERE id=$1 AND task_id=$2 AND revision=$3 AND status='draft'",
        [id, taskId, revision],
      );
    }, actor);
  }

  tool(actor: string, taskId: string, onUpdate: (plan: PlanDocument) => void | Promise<void>): Tool {
    const save = (raw: Record<string, unknown>) => this.save(actor, taskId, raw);
    return {
      name: 'update_plan',
      displayName: '更新任务计划',
      kind: 'read',
      description:
        '为当前办公任务建立或更新可审阅计划。复杂、多步骤或会生成多个成果的任务必须先调用。' +
        '必须写清目标、读取范围、业务规则、执行步骤、外部动作、预期成果、风险和验收方式。' +
        '计划每次调用全量替换并生成新 revision；资料范围或计划变化后此前批准自动失效。',
      parameters: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: '本次要交付的业务目标' },
          assumptions: { type: 'array', items: { type: 'string' }, description: '已采用的合理假设；可从资料确认的内容不得列为假设' },
          data_scope: { type: 'array', items: { type: 'string' }, description: '将读取的文件版本、知识和业务事实范围' },
          business_rules: { type: 'array', items: { type: 'string' }, description: '必须遵守的业务口径和用户约束' },
          steps: {
            type: 'array', minItems: 1, maxItems: 20,
            items: {
              type: 'object',
              properties: {
                step: { type: 'string' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
              },
              required: ['step', 'status'],
            },
          },
          external_actions: { type: 'array', items: { type: 'string' }, description: '将访问的网页、将发送或共享的外部动作；没有则空数组' },
          outputs: { type: 'array', items: { type: 'string' }, description: '最终交付的成果及格式' },
          risks: { type: 'array', items: { type: 'string' }, description: '数据、口径、覆盖或外部影响风险' },
          verification: { type: 'array', items: { type: 'string' }, description: '交付前如何进行机器或人工核验' },
        },
        required: ['goal', 'data_scope', 'steps', 'outputs', 'verification'],
      },
      async run(args) {
        const plan = await save(args);
        await onUpdate(plan);
        return `计划已更新到 revision ${plan.revision}。继续执行，但在首个写入或执行动作前必须获得用户确认。`;
      },
    };
  }
}

export function planForApproval(plan: PlanDocument | null): { complete: boolean; missing: string[] } {
  if (!plan) return { complete: false, missing: ['计划'] };
  const missing: string[] = [];
  if (!plan.goal.trim()) missing.push('目标');
  if (!plan.dataScope.length) missing.push('数据范围');
  if (!plan.steps.length) missing.push('执行步骤');
  if (!plan.outputs.length) missing.push('预期成果');
  if (!plan.verification.length) missing.push('验收方式');
  return { complete: missing.length === 0, missing };
}
