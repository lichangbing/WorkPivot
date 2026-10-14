import type { Pool } from 'pg';
import { RepositoryError, transaction } from './connection.js';
import { ProviderRepository } from './providers.js';

/** Only this server-side service resolves the admin-owned default; no credentials reach users. */
export class DatabaseModelService {
  constructor(private readonly auth: Pool, private readonly db: Pool, private readonly providers: ProviderRepository) {}
  private async resolve(actor: string) {
    const shared = await transaction(this.db, async c => (await c.query('SELECT owner_user_id,provider_id FROM workpivot.default_model')).rows[0], actor);
    if (shared) {
      const admin = (await this.auth.query("SELECT id FROM identity.users WHERE id=$1 AND role='admin' AND NOT disabled", [shared.owner_user_id])).rows[0];
      if (admin) {
        const row = (await this.providers.list(admin.id)).find(p => p.id === shared.provider_id && p.active);
        if (row) return { owner: admin.id as string, row, shared: true };
      }
      return null;
    }
    // Existing administrator configurations remain usable until published as the default.
    const row = (await this.providers.list(actor)).find(p => p.active);
    return row ? { owner: actor, row, shared: false } : null;
  }
  async status(actor: string) {
    const model = await this.resolve(actor);
    return model ? { available: true, name: model.row.name, modelId: model.row.modelId, shared: model.shared } : { available: false };
  }
  async client(actor: string) {
    const model = await this.resolve(actor);
    if (!model) throw new RepositoryError(400,'暂无可用模型，请联系管理员在模型管理中启用默认模型');
    return this.providers.client(model.owner);
  }
}
