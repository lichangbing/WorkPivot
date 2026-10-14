import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { Tool } from '@workpivot/core';
import { HttpSession, type RemoteTool } from '../mcp.js';
import { createAesBox, type SecretEnvelope } from '../secret.js';
import { RepositoryError, transaction, uuid } from './connection.js';

interface Connection { id: string; name: string; url: string; secret: SecretEnvelope | null; revision: number; enabled: boolean; status: string; tools: RemoteTool[]; disabled_tools: string[] }
const fingerprint = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const version = (v: number) => { if (!Number.isSafeInteger(v) || v < 1) throw new RepositoryError(400, 'MCP版本无效'); };
const publicRow = ({ secret, disabled_tools, ...row }: Connection) => ({ ...row, disabledTools: disabled_tools, hasToken: !!secret, transport: 'Streamable HTTP' });
export class McpRepository {
  private readonly box;
  constructor(private readonly db: Pool, key: string) { this.box = createAesBox(key); }
  private async locked(c: PoolClient, actor: string, id: string, revision: number): Promise<Connection> {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['mcp:' + actor]);
    const row = (await c.query<Connection>('SELECT * FROM workpivot.mcp_connections WHERE id=$1', [id])).rows[0];
    if (!row) throw new RepositoryError(404, 'MCP服务不存在');
    if (row.revision !== revision) throw new RepositoryError(409, 'MCP配置已改变');
    return row;
  }
  async list(actor: string) { return transaction(this.db, async c => (await c.query<Connection>('SELECT * FROM workpivot.mcp_connections ORDER BY name,id')).rows.map(publicRow), actor); }
  async save(actor: string, input: { name: string; url: string; token?: string | null }, id?: string, revision?: number) {
    const key = id ?? randomUUID(); uuid(key); if (id) version(revision!);
    let url: URL;
    try { url = new URL(input.url); } catch { throw new RepositoryError(400, 'MCP地址无效'); }
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80 || input.url.length > 2048 || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new RepositoryError(400, 'MCP名称或地址无效');
    if (input.token !== undefined && input.token !== null && (typeof input.token !== 'string' || input.token.length > 8192 || /[\r\n]/.test(input.token))) throw new RepositoryError(400, 'MCP令牌无效');
    return transaction(this.db, async c => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['mcp:' + actor]);
      const old = id ? await this.locked(c, actor, id, revision!) : undefined;
      if (!old && (await c.query('SELECT count(*)::int AS count FROM workpivot.mcp_connections')).rows[0].count >= 20) throw new RepositoryError(400, '最多20个MCP服务');
      const secret = input.token ? this.box.encrypt(JSON.stringify({ actor, id: key, token: input.token })) : input.token !== undefined || old?.url !== url.href ? null : old?.secret;
      const values = [key, input.name.trim(), url.href, JSON.stringify(secret ?? null)];
      const result = old
        ? await c.query<Connection>("UPDATE workpivot.mcp_connections SET name=$2,url=$3,secret=$4,revision=revision+1,enabled=false,status='untested',tools='[]' WHERE id=$1 RETURNING *", values)
        : await c.query<Connection>('INSERT INTO workpivot.mcp_connections(id,name,url,secret,owner_user_id) VALUES($1,$2,$3,$4,$5) RETURNING *', [...values, actor]);
      return publicRow(result.rows[0]!);
    }, actor);
  }
  private async current(actor: string, id: string): Promise<Connection> {
    uuid(id);
    return transaction(this.db, async c => {
      const row = (await c.query<Connection>('SELECT * FROM workpivot.mcp_connections WHERE id=$1', [id])).rows[0];
      if (!row) throw new RepositoryError(404, 'MCP服务不存在'); return row;
    }, actor);
  }
  private async session<T>(actor: string, row: Connection, signal: AbortSignal | undefined, fn: (session: HttpSession) => Promise<T>): Promise<T> {
    let token: string | undefined;
    try { if (row.secret) { const v = JSON.parse(this.box.decrypt(row.secret)); if (v.actor !== actor || v.id !== row.id || typeof v.token !== 'string') throw Error(); token = v.token; } }
    catch { throw new RepositoryError(503, 'MCP凭据无法解密'); }
    const controller = new AbortController();
    let checking = false;
    const timer = setInterval(() => {
      if (checking) return; checking = true;
      void this.current(actor, row.id).then(v => { if (v.revision !== row.revision) controller.abort(); }).catch(() => controller.abort()).finally(() => { checking = false; });
    }, 1000); timer.unref();
    const combined = AbortSignal.any([controller.signal, AbortSignal.timeout(30000), ...(signal ? [signal] : [])]);
    const session = new HttpSession({ url: row.url }, combined, token);
    try { await session.initialize(); return await fn(session); }
    catch (error) { if (error instanceof RepositoryError) throw error; throw new RepositoryError(502, 'MCP连接失败、配置改变或调用已停止；远端结果可能未知，不会自动重试'); }
    finally { clearInterval(timer); await session.close(); }
  }
  async discover(actor: string, id: string, revision: number) {
    version(revision); const row = await this.current(actor, id);
    if (row.revision !== revision) throw new RepositoryError(409, 'MCP配置已改变');
    let tools: RemoteTool[];
    try { tools = await this.session(actor, row, undefined, session => session.tools()); }
    catch (error) {
      await transaction(this.db, async c => { await this.locked(c, actor, id, revision); await c.query("UPDATE workpivot.mcp_connections SET status='error',enabled=false,revision=revision+1 WHERE id=$1", [id]); }, actor);
      throw error;
    }
    return transaction(this.db, async c => {
      await this.locked(c, actor, id, revision);
      return publicRow((await c.query<Connection>("UPDATE workpivot.mcp_connections SET tools=$2,status='ready',enabled=false,revision=revision+1 WHERE id=$1 RETURNING *", [id, JSON.stringify(tools)])).rows[0]!);
    }, actor);
  }
  async toggle(actor: string, id: string, revision: number, enabled: boolean, toolName?: string) {
    uuid(id); version(revision); if (typeof enabled !== 'boolean') throw new RepositoryError(400, 'MCP启停参数无效');
    return transaction(this.db, async c => {
      const row = await this.locked(c, actor, id, revision);
      if (toolName !== undefined) {
        if (!row.tools.some(t => t.name === toolName)) throw new RepositoryError(404, 'MCP工具不存在');
        row.disabled_tools = enabled ? row.disabled_tools.filter(n => n !== toolName) : [...new Set([...row.disabled_tools, toolName])];
      } else row.enabled = enabled;
      if (row.enabled && (row.status !== 'ready' || !row.tools.length)) throw new RepositoryError(400, '请先测试连接');
      const others = (await c.query<Connection>('SELECT * FROM workpivot.mcp_connections WHERE enabled AND id<>$1', [id])).rows;
      const count = [...others, ...(row.enabled ? [row] : [])].reduce((n, r) => n + r.tools.filter(t => !r.disabled_tools.includes(t.name)).length, 0);
      if (count > 128) throw new RepositoryError(400, '最多启用128个MCP工具');
      return publicRow((await c.query<Connection>('UPDATE workpivot.mcp_connections SET enabled=$2,disabled_tools=$3,revision=revision+1 WHERE id=$1 RETURNING *', [id, row.enabled, JSON.stringify(row.disabled_tools)])).rows[0]!);
    }, actor);
  }
  async remove(actor: string, id: string, revision: number) {
    uuid(id); version(revision);
    await transaction(this.db, async c => { await this.locked(c, actor, id, revision); await c.query('DELETE FROM workpivot.mcp_connections WHERE id=$1', [id]); }, actor);
  }
  async tools(actor: string): Promise<Tool[]> {
    const rows = await transaction(this.db, async c => (await c.query<Connection>("SELECT * FROM workpivot.mcp_connections WHERE enabled AND status='ready'")).rows, actor);
    return rows.flatMap(row => row.tools.filter(t => !row.disabled_tools.includes(t.name)).map(remote => {
      const name = 'mcp_' + fingerprint([row.id, remote.name]).slice(0, 24);
      return { name, kind: 'write' as const, displayName: `${row.name} / ${remote.name}`, description: remote.description, parameters: remote.inputSchema,
        run: async (args, ctx) => {
          const text = JSON.stringify(args); if (text.length > 16000) throw new RepositoryError(400, 'MCP参数过大');
          if (!await ctx.requestAccess?.({ tool: name, kind: 'write', paths: [], external: true, command: `${row.name} / ${remote.name}\n${row.url}\n${text}` })) throw new RepositoryError(403, 'MCP调用未获授权');
          const validate = async () => { const v = await this.current(actor, row.id); if (!v.enabled || v.revision !== row.revision) throw new RepositoryError(409, 'MCP配置或工具已改变'); };
          await validate();
          return this.session(actor, row, ctx.signal, async session => {
            const fresh = (await session.tools()).find(t => t.name === remote.name);
            if (!fresh || fingerprint(fresh) !== fingerprint(remote)) throw new RepositoryError(409, '远端工具定义已改变，请重新测试连接');
            await validate();
            const result = await session.rpc('tools/call', { name: remote.name, arguments: args }) as { content?: unknown; isError?: boolean };
            await validate();
            if (!result || !Array.isArray(result.content) || result.isError) throw new RepositoryError(502, 'MCP工具执行失败或结果无效');
            return JSON.stringify(result);
          });
        },
      } satisfies Tool;
    }));
  }
}
