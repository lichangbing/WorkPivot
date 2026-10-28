import type { Pool } from 'pg';
import { AccountRepository, type DatabaseUser } from './accounts.js';
import { RepositoryError, transaction, uuid } from './connection.js';

const MESSAGE_MAX = 100000;
const TOKEN_MAX = 1000000000;
const UPLOAD_MAX = 1099511627776;
const CONCURRENT_MAX = 100;

function integer(value: unknown, maximum: number, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new RepositoryError(400, `${label}需为0至${maximum}的整数`);
  }
  return value;
}

function revision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new RepositoryError(400, '限额版本无效');
  return value;
}

function validate(input: Record<string, unknown>) {
  return {
    messageQuota: integer(input.messageQuota, MESSAGE_MAX, '每日对话条数'),
    tokenQuota: integer(input.tokenQuota, TOKEN_MAX, '每日 Token 限额'),
    uploadQuotaBytes: integer(input.uploadQuotaBytes, UPLOAD_MAX, '每日上传额度'),
    concurrentTaskLimit: integer(input.concurrentTaskLimit, CONCURRENT_MAX, '并发任务数'),
  };
}

/** 独立的用户日限额读写；用量由身份表计数和运行表即时状态组成。 */
export class DailyLimits {
  constructor(private readonly auth: Pool, private readonly db: Pool) {}

  private async administrator(token: string): Promise<DatabaseUser> {
    const user = await new AccountRepository(this.auth).resolve(token);
    if (!user || user.role !== 'admin' || user.mustChangePassword) throw new RepositoryError(403, '需要有效管理员登录');
    return user;
  }

  private async runningTasks(userId: string): Promise<number> {
    const row = await transaction(this.db, async c => (await c.query(
      "SELECT count(DISTINCT task_id)::int AS n FROM workpivot.task_runs WHERE owner_user_id=$1 AND status='running'",
      [userId],
    )).rows[0], userId);
    return Number(row?.n ?? 0);
  }

  async overview(token: string) {
    await this.administrator(token);
    const accounts = new AccountRepository(this.auth);
    const [users, policy] = await Promise.all([accounts.listUsers(token), accounts.adminAccessPolicy(token)]);
    const rows = await Promise.all(users.map(async user => ({
      id: user.id,
      username: user.username,
      role: user.role,
      platformAdmin: user.platformAdmin,
      disabled: user.disabled,
      provisioningSource: user.provisioningSource,
      revision: user.limitsRevision,
      resetsAt: user.quotaResetAt,
      limits: {
        messageQuota: user.messageQuota,
        tokenQuota: user.tokenQuota,
        uploadQuotaBytes: user.uploadQuotaBytes,
        concurrentTaskLimit: user.concurrentTaskLimit,
      },
      usage: {
        messages: user.messagesUsed,
        tokens: user.tokensUsed,
        uploadBytes: user.uploadBytesUsed,
        concurrentTasks: user.platformAdmin ? 0 : await this.runningTasks(user.id),
      },
    })));
    return {
      defaults: {
        messageQuota: policy.defaultMessageQuota,
        tokenQuota: policy.defaultTokenQuota,
        uploadQuotaBytes: policy.defaultUploadQuotaBytes,
        concurrentTaskLimit: policy.defaultConcurrentTaskLimit,
        revision: policy.revision,
      },
      users: rows,
      notice: '0 表示不限；每日额度按北京时间 12:00 刷新。管理员创建的账户默认四项全部不限，平台管理员始终不限。',
    };
  }

  async updateUser(token: string, userId: string, input: Record<string, unknown>) {
    uuid(userId);
    const limits = validate(input), expected = revision(input.revision);
    return transaction(this.auth, async c => {
      const actor = await this.administrator(token);
      const row = (await c.query(
        'SELECT platform_admin,limits_revision FROM identity.users WHERE id=$1 FOR UPDATE',
        [userId],
      )).rows[0];
      if (!row) throw new RepositoryError(404, '用户不存在');
      if (row.platform_admin) throw new RepositoryError(400, '平台管理员始终不限，不能修改');
      if (row.limits_revision !== expected) throw new RepositoryError(409, '限额已变化，请刷新后重试');
      const updated = await c.query(
        `UPDATE identity.users SET message_quota=$2,token_quota=$3,upload_quota_bytes=$4,
          concurrent_task_limit=$5,limits_revision=limits_revision+1,updated_at=now()
         WHERE id=$1 AND limits_revision=$6
         RETURNING limits_revision AS revision`,
        [userId, limits.messageQuota, limits.tokenQuota, limits.uploadQuotaBytes, limits.concurrentTaskLimit, expected],
      );
      if (!updated.rowCount) throw new RepositoryError(409, '限额已变化，请刷新后重试');
      await c.query("INSERT INTO identity.audit_events(actor_id,target_id,action) VALUES($1,$2,'user_limits_updated')", [actor.id, userId]);
      return updated.rows[0];
    });
  }
}
