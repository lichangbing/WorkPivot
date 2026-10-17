import { UsageRepository, priceValue, currencyValue, type UsageContext } from './usage.js';
import { streamWithRecovery } from './model-recovery.js';
import { safeModelError, modelFailureDetails } from './model-error.js';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createOpenAICompatibleClient, createAnthropicClient } from '@workpivot/core';
import { createAesBox, type SecretEnvelope } from '../secret.js';
import { RepositoryError, transaction, uuid } from './connection.js';

export interface ProviderInput { name: string; baseUrl: string; modelId: string; protocol: 'openai' | 'anthropic'; apiKey?: string | null; contextBudget?: number; inputPrice?: string|null; outputPrice?: string|null; currency?: string }
export interface PublicDatabaseProvider extends Omit<ProviderInput, 'apiKey'> { id: string; revision: number; active: boolean; hasApiKey: boolean }
const publicColumns = 'id,name,base_url AS "baseUrl",model_id AS "modelId",context_budget AS "contextBudget",protocol,input_price::text AS "inputPrice",output_price::text AS "outputPrice",currency,revision,active,secret IS NOT NULL AS "hasApiKey"';
const version = (v: number) => { if (!Number.isSafeInteger(v) || v < 1) throw new RepositoryError(400, '模型配置版本无效'); };
export class ProviderRepository {
  private readonly box;
  constructor(private readonly db: Pool, key: string) { this.box = createAesBox(key); }
  private validate(input: ProviderInput): ProviderInput {
    if(input?.contextBudget!==undefined&&(!Number.isSafeInteger(input.contextBudget)||input.contextBudget<12000||input.contextBudget>1000000))throw new RepositoryError(400,'上下文容量须为12000至1000000之间的整数');
    if (!input || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 120 || typeof input.modelId !== 'string' || !input.modelId.trim() || input.modelId.length > 200 || !['openai', 'anthropic'].includes(input.protocol)) throw new RepositoryError(400, '模型配置无效');
    let url: URL;
    try { if (typeof input.baseUrl !== 'string' || input.baseUrl.length > 2000) throw Error(); url = new URL(input.baseUrl); } catch { throw new RepositoryError(400, '模型地址无效'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new RepositoryError(400, '模型地址仅支持HTTP(S)，不能包含凭据或查询参数');
    if (input.apiKey !== undefined && input.apiKey !== null && (typeof input.apiKey !== 'string' || !input.apiKey.trim() || input.apiKey.length > 16000)) throw new RepositoryError(400, '模型密钥无效');
    for(const key of ['inputPrice','outputPrice'] as const) if(input[key]!==undefined)priceValue(input[key]);
    if(input.currency!==undefined)currencyValue(input.currency);
    return { ...input, name: input.name.trim(), modelId: input.modelId.trim(), baseUrl: url.toString().replace(/\/+$/, '') };
  }
  async list(actor: string): Promise<PublicDatabaseProvider[]> {
    return transaction(this.db, async c => (await c.query<PublicDatabaseProvider>(`SELECT ${publicColumns},EXISTS(SELECT 1 FROM workpivot.default_model d WHERE d.provider_id=workpivot.model_providers.id) AS shared FROM workpivot.model_providers ORDER BY created_at,id`)).rows, actor);
  }
  async save(actor: string, input: ProviderInput, id?: string, expected?: number): Promise<PublicDatabaseProvider> {
    const value = this.validate(input), providerId = id ?? randomUUID(); uuid(providerId);
    if (id) version(expected!);
    const secret = value.apiKey ? JSON.stringify(this.box.encrypt(JSON.stringify({ actor, providerId, key: value.apiKey }))) : null;
    return transaction(this.db, async c => {
      // 将该所有者的全部配置修改串行化，包括激活模型选择。
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['providers:' + actor]);
      if (id) {
        const old = (await c.query('SELECT revision,base_url FROM workpivot.model_providers WHERE id=$1', [id])).rows[0];
        if (!old) throw new RepositoryError(404, '模型配置不存在');
        if (old.revision !== expected) throw new RepositoryError(409, '模型配置已更新');
        if (old.base_url !== value.baseUrl && value.apiKey === undefined) throw new RepositoryError(400, '更换模型地址时请重新填写密钥或明确清除，避免将原密钥发送给新服务');
        return (await c.query<PublicDatabaseProvider>(`UPDATE workpivot.model_providers SET name=$2,base_url=$3,model_id=$4,protocol=$5,secret=CASE WHEN $6 THEN $7::jsonb ELSE secret END,context_budget=COALESCE($8,context_budget),input_price=CASE WHEN $9 THEN $10::numeric ELSE input_price END,output_price=CASE WHEN $11 THEN $12::numeric ELSE output_price END,currency=COALESCE($13,currency),revision=revision+1 WHERE id=$1 RETURNING ${publicColumns}`, [id, value.name, value.baseUrl, value.modelId, value.protocol, value.apiKey !== undefined, secret,value.contextBudget??null,value.inputPrice!==undefined,value.inputPrice??null,value.outputPrice!==undefined,value.outputPrice??null,value.currency??null])).rows[0]!;
      }
      return (await c.query<PublicDatabaseProvider>(`INSERT INTO workpivot.model_providers(id,owner_user_id,name,base_url,model_id,protocol,secret,context_budget,input_price,output_price,currency) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${publicColumns}`, [providerId, actor, value.name, value.baseUrl, value.modelId, value.protocol, secret,value.contextBudget??65536,value.inputPrice??null,value.outputPrice??null,value.currency??'CNY'])).rows[0]!;
    }, actor);
  }
  async activate(actor: string, id: string, expected: number, publish = false): Promise<void> {
    uuid(id); version(expected);
    await transaction(this.db, async c => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['providers:' + actor]);
      const old = (await c.query('SELECT revision,active FROM workpivot.model_providers WHERE id=$1', [id])).rows[0];
      if (!old) throw new RepositoryError(404, '模型配置不存在');
      if (old.revision !== expected) throw new RepositoryError(409, '模型配置已更新');
      if (publish) await c.query('INSERT INTO workpivot.default_model(singleton,owner_user_id,provider_id) VALUES(true,$1,$2) ON CONFLICT(singleton) DO UPDATE SET provider_id=EXCLUDED.provider_id', [actor,id]);
      if (old.active) return;
      await c.query('UPDATE workpivot.model_providers SET active=false,revision=revision+1 WHERE active');
      await c.query('UPDATE workpivot.model_providers SET active=true,revision=revision+1 WHERE id=$1', [id]);
    }, actor);
  }
  async remove(actor: string, id: string, expected: number): Promise<void> {
    uuid(id); version(expected);
    await transaction(this.db, async c => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['providers:' + actor]);
      const row = (await c.query('SELECT revision FROM workpivot.model_providers WHERE id=$1', [id])).rows[0];
      if (!row) throw new RepositoryError(404, '模型配置不存在');
      if (row.revision !== expected) throw new RepositoryError(409, '模型配置已更新');
      await c.query('DELETE FROM workpivot.model_providers WHERE id=$1', [id]);
    }, actor);
  }
  async diagnose(actor:string,id:string,expected:number) {
    uuid(id);version(expected);
    const row=(await this.list(actor)).find(p=>p.id===id);
    if(!row)throw new RepositoryError(404,'模型不存在');
    if(row.revision!==expected)throw new RepositoryError(409,'模型已变更，请刷新');
    const started=Date.now();
    try {
      const client=await this.client(actor,actor,{source:'diagnostic'},id);let text='';
      for await(const event of client.streamChat([{role:'user',content:'Reply only OK.'}],[],AbortSignal.timeout(20000))) if(event.type==='delta')text+=event.text;
      return {ok:text.trim().length>0,detail:text.trim()?'模型生成接口可用':'连接成功但未返回正文',durationMs:Date.now()-started};
    }catch(error){return {ok:false,detail:safeModelError(error),durationMs:Date.now()-started};}
  }
  async client(actor: string, usageActor = actor, context: UsageContext = {}, providerId?:string) {
    const row = await transaction(this.db, async c => (await c.query('SELECT id,base_url,model_id,protocol,secret,context_budget,input_price::text,output_price::text,currency FROM workpivot.model_providers WHERE ($1::uuid IS NULL AND active) OR id=$1', [providerId??null])).rows[0], actor);
    if (!row) throw new RepositoryError(400, '请先配置并选择模型');
    let apiKey: string | undefined;
    if (row.secret) {
      try {
        const secret = JSON.parse(this.box.decrypt(row.secret as SecretEnvelope));
        if (secret.actor !== actor || secret.providerId !== row.id || typeof secret.key !== 'string') throw Error();
        apiKey = secret.key;
      } catch { throw new RepositoryError(503, '模型密钥无法读取，请检查服务器加密配置'); }
    }
    const options = { providerId: row.id as string, baseUrl: row.base_url as string, model: row.model_id as string, apiKey };
    const client = row.protocol === 'anthropic' ? createAnthropicClient(options) : createOpenAICompatibleClient(options);
    const measured = new UsageRepository(this.db).wrap(usageActor,client,{inputPrice:row.input_price,outputPrice:row.output_price,currency:row.currency},context);
    return { providerId: client.providerId, model: client.model, contextBudget:row.context_budget as number, async *streamChat(...args: Parameters<typeof client.streamChat>) {
      try { yield* streamWithRecovery(measured, args); }
      catch (error) { throw new Error(safeModelError(error), { cause: modelFailureDetails(error) }); }
    } };
  }
}
