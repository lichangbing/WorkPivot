/**
 * R007 对话记录入库（文件链路混合存储）：chat schema 访问层。
 *
 * 只负责"任务元数据 + 对话消息"这一半；工作目录、上传件、成果字节仍在磁盘。
 * 未配置 WORKPIVOT_CHAT_DATABASE_URL 时整层关闭，调用方继续走 JSONL（行为不变）。
 *
 * 取号由数据库完成：`UPDATE chat.tasks SET last_seq=last_seq+1 RETURNING last_seq`，
 * 同一事务内插入消息，天然避免进程重启后 ordinal 复位与并发重号。
 */
import { Pool } from 'pg';

export type ChatTaskRow = {
  id: string;
  owner_user_id: string | null;
  tenant_id: string | null;
  name: string;
  directory: string;
  status: string;
  stop_reason: string | null;
  project_id: string | null;
  temp: boolean;
  last_seq: string;
  created_at: Date;
  updated_at: Date;
};

export type ChatMessageRow = {
  id: string;
  task_id: string;
  seq: string;
  kind: string;
  payload: Record<string, unknown>;
  parent_id: string | null;
  created_at: Date;
};

export type ChatMessageInput = {
  taskId: string;
  kind: string;
  payload: Record<string, unknown>;
  parentId?: string | null;
};

export type ChatTaskInput = {
  id: string;
  ownerUserId?: string | null;
  tenantId?: string | null;
  name: string;
  directory: string;
  status: string;
  stopReason?: string | null;
  projectId?: string | null;
  temp?: boolean;
  createdAt: Date;
};

let pool: Pool | undefined;

/** 运行时连接串；未配置返回 undefined，调用方据此保持 JSONL。 */
export function chatDatabaseUrl(): string | undefined {
  const value = process.env['WORKPIVOT_CHAT_DATABASE_URL']?.trim();
  return value ? value : undefined;
}

export function chatEnabled(): boolean {
  return chatDatabaseUrl() !== undefined;
}

export function chatPool(): Pool {
  const url = chatDatabaseUrl();
  if (!url) throw new Error('未配置 WORKPIVOT_CHAT_DATABASE_URL');
  pool ??= new Pool({ connectionString: url, max: 8, connectionTimeoutMillis: 5_000 });
  return pool;
}

export async function closeChatStore(): Promise<void> {
  const current = pool;
  pool = undefined;
  await current?.end();
}

/**
 * 启动探测：配置了就必须能连上且表已建好，否则直接失败。
 * 明确不回落到 JSONL——同一份对话不能有两个真值。
 */
export async function probeChatStore(): Promise<void> {
  if (!chatEnabled()) return;
  try {
    await chatPool().query('SELECT 1 FROM chat.tasks LIMIT 0');
  } catch (error) {
    throw new Error(`对话存储不可用（chat schema 未初始化或连接失败）：${error instanceof Error ? error.message : String(error)}；请先执行 pnpm chat:install`);
  }
}

/** 行 → 调用方结构（字符串序号保持原样，由上层决定是否转 number）。 */
export function taskFromRow(row: ChatTaskRow) {
  return {
    id: row.id,
    name: row.name,
    directory: row.directory,
    status: row.status,
    ...(row.stop_reason ? { stopReason: row.stop_reason } : {}),
    ...(row.project_id ? { projectId: row.project_id } : {}),
    temp: row.temp,
    createdAt: row.created_at.toISOString(),
    ...(row.owner_user_id ? { ownerUserId: row.owner_user_id } : {}),
    ...(row.tenant_id ? { tenantId: row.tenant_id } : {}),
  };
}

export function transcriptRowFromMessage(row: ChatMessageRow) {
  return {
    ts: row.created_at.toISOString(),
    ordinal: Number(row.seq),
    kind: row.kind,
    payload: row.payload,
    uuid: row.id,
    parentUuid: row.parent_id,
  };
}

export async function createChatTask(input: ChatTaskInput): Promise<void> {
  await chatPool().query(
    `INSERT INTO chat.tasks(id,owner_user_id,tenant_id,name,directory,status,stop_reason,project_id,temp,created_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [input.id, input.ownerUserId ?? null, input.tenantId ?? null, input.name, input.directory, input.status,
      input.stopReason ?? null, input.projectId ?? null, input.temp ?? false, input.createdAt],
  );
}

export async function getChatTask(id: string): Promise<ChatTaskRow | null> {
  const result = await chatPool().query<ChatTaskRow>('SELECT * FROM chat.tasks WHERE id=$1', [id]);
  return result.rows[0] ?? null;
}

export async function listChatTasks(ownerUserId?: string | null): Promise<ChatTaskRow[]> {
  if (ownerUserId === undefined) {
    return (await chatPool().query<ChatTaskRow>('SELECT * FROM chat.tasks ORDER BY created_at DESC,id DESC')).rows;
  }
  return (await chatPool().query<ChatTaskRow>('SELECT * FROM chat.tasks WHERE owner_user_id IS NOT DISTINCT FROM $1 ORDER BY created_at DESC,id DESC', [ownerUserId])).rows;
}

export async function updateChatTask(id: string, patch: { status?: string; stopReason?: string | null; projectId?: string | null; name?: string }): Promise<boolean> {
  const result = await chatPool().query(
    `UPDATE chat.tasks SET status=COALESCE($2,status), stop_reason=$3, project_id=$4, name=COALESCE($5,name), updated_at=now() WHERE id=$1 RETURNING id`,
    [id, patch.status ?? null, patch.stopReason ?? null, patch.projectId === undefined ? null : patch.projectId, patch.name ?? null],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function deleteChatTask(id: string): Promise<boolean> {
  const result = await chatPool().query('DELETE FROM chat.tasks WHERE id=$1', [id]);
  return (result.rowCount ?? 0) > 0;
}

/**
 * 追加一条消息：同一事务里取号 + 插入，并发安全。
 * 唯一约束冲突时重试一次（极端情况下的跨实例竞争）。
 */
export async function appendChatMessage(input: ChatMessageInput): Promise<{ seq: string; id: string }> {
  const client = await chatPool().connect();
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await client.query('BEGIN');
        const seq = (await client.query<{ last_seq: string }>('UPDATE chat.tasks SET last_seq=last_seq+1, updated_at=now() WHERE id=$1 RETURNING last_seq', [input.taskId])).rows[0]?.last_seq;
        if (!seq) throw new Error('任务不存在');
        const id = (await client.query<{ id: string }>(
          'INSERT INTO chat.messages(id,task_id,seq,kind,payload,parent_id,created_at) VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,now()) RETURNING id',
          [input.taskId, seq, input.kind, JSON.stringify(input.payload), input.parentId ?? null],
        )).rows[0]!.id;
        await client.query('COMMIT');
        return { seq, id };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        if (attempt === 1) throw error;
      }
    }
    throw new Error('追加消息失败');
  } finally {
    client.release();
  }
}

/** 分页读取：`before` 为上一页最小 seq（不含），默认取尾部 limit 条，按 seq 升序返回。 */
export async function readChatMessages(taskId: string, options: { before?: number; limit?: number } = {}): Promise<ChatMessageRow[]> {
  const limit = Math.min(500, Math.max(1, options.limit ?? 100));
  const rows = options.before === undefined
    ? (await chatPool().query<ChatMessageRow>('SELECT * FROM chat.messages WHERE task_id=$1 ORDER BY seq DESC LIMIT $2', [taskId, limit])).rows
    : (await chatPool().query<ChatMessageRow>('SELECT * FROM chat.messages WHERE task_id=$1 AND seq<$2 ORDER BY seq DESC LIMIT $3', [taskId, options.before, limit])).rows;
  return rows.reverse();
}

export async function readChatMessagesByKind(taskId: string, kinds: string[], limit = 200): Promise<ChatMessageRow[]> {
  const rows = (await chatPool().query<ChatMessageRow>('SELECT * FROM chat.messages WHERE task_id=$1 AND kind=ANY($2::text[]) ORDER BY seq DESC LIMIT $3', [taskId, kinds, limit])).rows;
  return rows.reverse();
}

/** 删除任务的消息由外键级联完成，这里只用于测试与统计。 */
export async function countChatMessages(taskId: string): Promise<number> {
  const result = await chatPool().query<{ count: string }>('SELECT count(*) AS count FROM chat.messages WHERE task_id=$1', [taskId]);
  return Number(result.rows[0]?.count ?? 0);
}
