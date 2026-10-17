import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { RepositoryError, transaction, uuid } from './connection.js';

type Kind = 'user' | 'assistant' | 'thinking' | 'tool_use' | 'tool_result' | 'meta';
interface Turn { id: string; sequence: string }
interface Event { id: string; sequence: string; turnId: string; runId: string; kind: Kind; content: string; truncated: boolean }
interface Cursor { v: 1; task: string; snapshot: string; before: string }
const eventColumns = `id,sequence,turn_id AS "turnId",run_id AS "runId",kind,left(content,4000) AS content,length(content)>4000 AS truncated,
CASE WHEN kind='user' THEN COALESCE((SELECT jsonb_agg(jsonb_build_object('id',a.id,'name',v.name,'deleted',v.id IS NULL) ORDER BY a.position) FROM workpivot.task_runs r CROSS JOIN LATERAL unnest(r.attachment_ids) WITH ORDINALITY AS a(id,position) LEFT JOIN workpivot.document_versions v ON v.id=a.id WHERE r.id=conversation_events.run_id), '[]'::jsonb) ELSE '[]'::jsonb END AS attachments`;
const eventLimit = 20;
const counter = (s: unknown): s is string => typeof s === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(s) && BigInt(s) <= 9223372036854775807n;
function cursor(raw: string, taskId: string): Cursor {
  try {
    if (raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw Error();
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString()) as Cursor;
    if (c.v !== 1 || c.task !== taskId || !counter(c.before) || !counter(c.snapshot)) throw Error();
    return c;
  } catch { throw new RepositoryError(400, '历史游标无效或不属于此任务'); }
}
async function lockTask(c: PoolClient, id: string, write: boolean): Promise<{ nextSequence: string; nextTurn: string }> {
  const result = await c.query(`SELECT next_sequence AS "nextSequence",next_turn_sequence AS "nextTurn" FROM workpivot.tasks WHERE id=$1 AND deleted_at IS NULL FOR ${write ? 'UPDATE' : 'SHARE'}`, [id]);
  if (!result.rows[0]) throw new RepositoryError(404, '任务不存在');
  return result.rows[0];
}

/** 只负责持久化；执行层管理运行标识，重试追加到原轮次。 */
export class ConversationRepository {
  constructor(private readonly db: Pool) {}
  async startTurn(actor: string, taskId: string, content: string, requestId: string, runId: string): Promise<Turn> {
    uuid(taskId); uuid(requestId); uuid(runId); this.validateContent(content);
    return transaction(this.db, async c => {
      await lockTask(c, taskId, true);
      const old = (await c.query<Turn>('SELECT id,sequence FROM workpivot.conversation_turns WHERE task_id=$1 AND request_id=$2', [taskId, requestId])).rows[0];
      if (old) {
        const first = (await c.query('SELECT content,run_id FROM workpivot.conversation_events WHERE turn_id=$1 ORDER BY sequence LIMIT 1', [old.id])).rows[0];
        if (first?.content !== content || first?.run_id !== runId) throw new RepositoryError(409, '重复请求内容不同');
        return old;
      }
      const sequence = (await c.query('UPDATE workpivot.tasks SET next_turn_sequence=next_turn_sequence+1 WHERE id=$1 RETURNING next_turn_sequence-1 AS sequence', [taskId])).rows[0].sequence;
      const turn = { id: randomUUID(), sequence };
      await c.query('INSERT INTO workpivot.conversation_turns(id,owner_user_id,task_id,sequence,request_id) VALUES($1,$2,$3,$4,$5)', [turn.id, actor, taskId, sequence, requestId]);
      await this.insertEvent(c, actor, taskId, turn.id, runId, 'user', content, requestId);
      return turn;
    }, actor);
  }
  async appendEvent(actor: string, taskId: string, turnId: string, runId: string, kind: Exclude<Kind, 'user'>, content: string, requestId: string): Promise<string> {
    for (const id of [taskId, turnId, runId, requestId]) uuid(id);
    this.validateContent(content);
    if (!['assistant', 'thinking', 'tool_use', 'tool_result', 'meta'].includes(kind)) throw new RepositoryError(400, '事件类型无效');
    return transaction(this.db, async c => {
      await lockTask(c, taskId, true);
      if (!(await c.query('SELECT id FROM workpivot.conversation_turns WHERE id=$1 AND task_id=$2', [turnId, taskId])).rowCount) throw new RepositoryError(404, '对话轮次不存在');
      return this.insertEvent(c, actor, taskId, turnId, runId, kind, content, requestId);
    }, actor);
  }
  private validateContent(content: string): void {
    if (typeof content !== 'string' || content.length > 200000) throw new RepositoryError(400, '事件内容无效或过长');
  }
  private async insertEvent(c: PoolClient, actor: string, taskId: string, turnId: string, runId: string, kind: Kind, content: string, requestId: string): Promise<string> {
    const old = (await c.query('SELECT id,turn_id,run_id,kind,content FROM workpivot.conversation_events WHERE task_id=$1 AND request_id=$2', [taskId, requestId])).rows[0];
    if (old) {
      if (old.turn_id !== turnId || old.run_id !== runId || old.kind !== kind || old.content !== content) throw new RepositoryError(409, '重复事件内容不同');
      return old.id;
    }
    const sequence = (await c.query('UPDATE workpivot.tasks SET next_sequence=next_sequence+1 WHERE id=$1 RETURNING next_sequence-1 AS sequence', [taskId])).rows[0].sequence;
    const id = randomUUID();
    await c.query('INSERT INTO workpivot.conversation_events(id,owner_user_id,task_id,turn_id,sequence,request_id,run_id,kind,content) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [id, actor, taskId, turnId, sequence, requestId, runId, kind, content]);
    return id;
  }
  async page(actor: string, taskId: string, before?: string) {
    uuid(taskId); const bounds = before === undefined ? undefined : cursor(before, taskId);
    return transaction(this.db, async c => {
      // 写入者同样锁定任务，保证整份响应使用稳定事件水位。
      const head = await lockTask(c, taskId, false);
      const snapshot = bounds?.snapshot ?? String(BigInt(head.nextSequence) - 1n);
      if (BigInt(snapshot) >= BigInt(head.nextSequence)) throw new RepositoryError(400, '历史快照无效');
      const limit = bounds ? 1 : 5;
      const rows = (await c.query<Turn>(`SELECT t.id,t.sequence FROM workpivot.conversation_turns t
        WHERE t.task_id=$1 AND t.sequence<$2 AND EXISTS(SELECT 1 FROM workpivot.conversation_events e WHERE e.turn_id=t.id AND e.sequence<=$3)
        ORDER BY t.sequence DESC LIMIT $4`, [taskId, bounds?.before ?? head.nextTurn, snapshot, limit + 1])).rows;
      const hasMore = rows.length > limit, selected = rows.slice(0, limit).reverse();
      const turns = [];
      for (const turn of selected) {
        const events = await this.events(c, taskId, turn.id, '0', snapshot);
        turns.push({ ...turn, ...events });
      }
      return { turns, hasMore, snapshotSequence: snapshot, nextCursor: hasMore ? Buffer.from(JSON.stringify({ v: 1, task: taskId, snapshot, before: selected[0]!.sequence } satisfies Cursor)).toString('base64url') : null };
    }, actor);
  }
  private async events(c: PoolClient, taskId: string, turnId: string, after: string, snapshot: string) {
    const rows = (await c.query<Event>(`SELECT ${eventColumns} FROM workpivot.conversation_events WHERE task_id=$1 AND turn_id=$2 AND sequence>$3 AND sequence<=$4 ORDER BY sequence LIMIT $5`, [taskId, turnId, after, snapshot, eventLimit + 1])).rows;
    const events = rows.slice(0, eventLimit);
    return { events, hasMoreEvents: rows.length > eventLimit, nextEventSequence: rows.length > eventLimit ? events.at(-1)!.sequence : null };
  }
  async turnEvents(actor: string, taskId: string, turnId: string, after: string, snapshot: string) {
    uuid(taskId); uuid(turnId);
    if (!counter(after) || !counter(snapshot) || BigInt(after) > BigInt(snapshot)) throw new RepositoryError(400, '事件分页参数无效');
    return transaction(this.db, async c => {
      const head = await lockTask(c, taskId, false);
      if (BigInt(snapshot) >= BigInt(head.nextSequence)) throw new RepositoryError(400, '历史快照无效');
      if (!(await c.query('SELECT id FROM workpivot.conversation_turns WHERE task_id=$1 AND id=$2', [taskId, turnId])).rowCount) throw new RepositoryError(404, '对话轮次不存在');
      return this.events(c, taskId, turnId, after, snapshot);
    }, actor);
  }
  async changes(actor: string, taskId: string, after: string, through?: string) {
    uuid(taskId);
    if (!counter(after) || (through !== undefined && (!counter(through) || BigInt(after) > BigInt(through)))) throw new RepositoryError(400, '补拉参数无效');
    return transaction(this.db, async c => {
      const head = await lockTask(c, taskId, false);
      const snapshotSequence = through ?? String(BigInt(head.nextSequence) - 1n);
      if (BigInt(snapshotSequence) >= BigInt(head.nextSequence) || BigInt(after) > BigInt(snapshotSequence)) throw new RepositoryError(400, '补拉快照无效');
      const rows = (await c.query<Event>(`SELECT ${eventColumns} FROM workpivot.conversation_events WHERE task_id=$1 AND sequence>$2 AND sequence<=$3 ORDER BY sequence LIMIT $4`, [taskId, after, snapshotSequence, eventLimit + 1])).rows;
      const events = rows.slice(0, eventLimit), hasMore = rows.length > eventLimit;
      // 读取结束后也推进仅持久化备注的水位，避免在序号间隙循环。
      return { events, hasMore, snapshotSequence, nextSequence: hasMore ? events.at(-1)!.sequence : snapshotSequence };
    }, actor);
  }
  async eventContent(actor: string, taskId: string, eventId: string, offset: number) {
    uuid(taskId); uuid(eventId);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 200000) throw new RepositoryError(400, '内容位置无效');
    return transaction(this.db, async c => {
      await lockTask(c, taskId, false);
      // 使用 SQL 子串限制网络和应用内存占用，兼容大型工具结果。
      const row = (await c.query('SELECT substring(content FROM $3 FOR 16000) AS content,length(content) AS length FROM workpivot.conversation_events WHERE task_id=$1 AND id=$2', [taskId, eventId, offset + 1])).rows[0];
      if (!row) throw new RepositoryError(404, '事件不存在');
      return { content: row.content as string, nextOffset: offset + 16000 < row.length ? offset + 16000 : null };
    }, actor);
  }
}
