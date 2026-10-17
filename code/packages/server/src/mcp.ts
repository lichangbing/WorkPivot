import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Tool, ToolContext } from '@workpivot/core';
import { ensureWorkpivotDir, readJsonSafe, writeAtomicWithBackup } from './store.js';
import { getSecretBox, type SecretEnvelope } from './secret.js';
import { TenantMap } from './tenant-map.js';

export interface RemoteTool { name: string; description: string; inputSchema: Record<string, unknown> }
interface Connection { id: string; revision: string; name: string; url: string; secret?: SecretEnvelope; enabled: boolean; tools: RemoteTool[]; disabledTools?: string[]; checkedAt?: string; status: 'untested' | 'ready' | 'error'; error?: string }
const enabledTools = (row: Connection) => row.tools.filter(t => !row.disabledTools?.includes(t.name));
export const mcpError = (message: string, status = 400): Error => Object.assign(new Error(message), { status });
const path = () => join(ensureWorkpivotDir('config'), 'mcp.json');
function read(): Connection[] { return readJsonSafe<Connection[]>(path(), []).value; }
function write(rows: Connection[]): void { writeAtomicWithBackup(path(), JSON.stringify(rows)); }
function get(id: string): Connection { const row = read().find(r => r.id === id); if (!row) throw mcpError('MCP 服务不存在', 404); return row; }
const active = new TenantMap<string, Set<AbortController>>();
function cancel(id: string): void { for (const controller of active.get(id) ?? []) controller.abort(); }
export function listMcp() { return read().map(({ secret, ...row }) => ({ ...row, hasToken: Boolean(secret), transport: 'Streamable HTTP' })); }
export function saveMcp(input: { id?: string; revision?: string; name?: unknown; url?: unknown; token?: unknown; clearToken?: unknown }) {
  const rows = read(); const old = input.id ? get(input.id) : undefined;
  if (old && old.revision !== input.revision) throw mcpError('配置已改变，请刷新后编辑', 409);
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80 || typeof input.url !== 'string' || input.url.length > 2048) throw mcpError('服务名称和地址必填');
  let url: URL; try { url = new URL(input.url); } catch { throw mcpError('服务地址无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw mcpError('仅支持 HTTP/HTTPS 地址，请把令牌填入凭据栏，不要放在地址中');
  if (input.token !== undefined && (typeof input.token !== 'string' || input.token.length > 8192 || /[\r\n]/.test(input.token))) throw mcpError('访问令牌格式无效');
  if (!old && rows.length >= 20) throw mcpError('每个账号最多20个 MCP 服务');
  const name = input.name.trim();
  if (rows.some(r => r.id !== old?.id && r.name === name)) throw mcpError('服务名称已存在');
  const token = typeof input.token === 'string' ? input.token : '';
  // 更换端点时不得隐式转发原端点凭据。
  const secret = token ? getSecretBox().encrypt(token) : input.clearToken === true || old?.url !== url.href ? undefined : old?.secret;
  const value: Connection = { id: old?.id ?? randomUUID(), revision: randomUUID(), name: input.name.trim(), url: url.href, secret, enabled: false, tools: [], disabledTools: old?.disabledTools ?? [], status: 'untested' };
  if (old) { cancel(old.id); rows[rows.findIndex(r => r.id === old.id)] = value; } else rows.push(value);
  write(rows); return listMcp().find(r => r.id === value.id)!;
}
export function toggleMcp(id: string, enabled: unknown, revision: unknown) {
  const rows = read(), row = get(id); if (row.revision !== revision) throw mcpError('配置已改变，请刷新', 409);
  if (typeof enabled !== 'boolean') throw mcpError('启停状态无效');
  if (enabled && (row.status !== 'ready' || !row.tools.length)) throw mcpError('请先测试连接并发现工具');
  if (enabled && rows.filter(r => r.id !== id && r.enabled).reduce((n, r) => n + enabledTools(r).length, enabledTools(row).length) > 128) throw mcpError('每个账号最多启用128个 MCP 工具，请先禁用其他服务');
  cancel(id); row.enabled = enabled; row.revision = randomUUID(); rows[rows.findIndex(r => r.id === id)] = row; write(rows); return { ok: true };
}
export function deleteMcp(id: string, revision: unknown) { const row = get(id); if (row.revision !== revision) throw mcpError('配置已改变，请刷新', 409); cancel(id); write(read().filter(r => r.id !== id)); return { ok: true }; }
export function toggleMcpTool(id: string, name: unknown, enabled: unknown, revision: unknown) {
  const rows = read(), row = get(id);
  if (row.revision !== revision) throw mcpError('配置已改变，请刷新', 409);
  if (typeof name !== 'string' || !row.tools.some(t => t.name === name)) throw mcpError('工具不存在', 404);
  if (typeof enabled !== 'boolean') throw mcpError('启停状态无效');
  const disabled = new Set(row.disabledTools ?? []);
  if (enabled) disabled.delete(name); else disabled.add(name);
  row.disabledTools = [...disabled];
  if (row.enabled && rows.filter(r => r.id !== id && r.enabled).reduce((n, r) => n + enabledTools(r).length, enabledTools(row).length) > 128) throw mcpError('每个账号最多启用128个 MCP 工具');
  cancel(id); row.revision = randomUUID(); rows[rows.findIndex(r => r.id === id)] = row; write(rows);
  return { ok: true };
}

type Rpc = { jsonrpc?: string; id?: string | number; method?: string; result?: unknown; error?: { code?: number } };
const protocols = ['2025-11-25', '2025-06-18', '2025-03-26'];
export class HttpSession {
  private session = '';
  private protocol = '';
  constructor(private row: Pick<Connection, 'url' | 'secret'>, private signal: AbortSignal, private bearer?: string) {}
  private headers(): Record<string, string> {
    return { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(this.bearer ? { authorization: `Bearer ${this.bearer}` } : this.row.secret ? { authorization: `Bearer ${getSecretBox().decrypt(this.row.secret)}` } : {}), ...(this.session ? { 'Mcp-Session-Id': this.session } : {}), ...(this.protocol ? { 'MCP-Protocol-Version': this.protocol } : {}) };
  }
  private async post(body: unknown, signal = this.signal): Promise<Response> {
    const response = await fetch(this.row.url, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), redirect: 'error', signal });
    if (!response.ok) { await response.body?.cancel(); throw mcpError(`MCP 服务返回 HTTP ${response.status}`, 502); }
    const session = response.headers.get('Mcp-Session-Id');
    if (session && !this.protocol) { if (!/^[\x21-\x7e]{1,1024}$/.test(session)) { await response.body?.cancel(); throw mcpError('MCP 会话标识无效', 502); } this.session = session; }
    return response;
  }
  private async packet(packet: Rpc, id: string): Promise<{ found: boolean; result?: unknown }> {
    if (packet.jsonrpc !== '2.0') throw mcpError('MCP 响应格式无效', 502);
    if (packet.method && packet.id !== undefined) {
      // 未声明采样、根目录或信息征询能力。
      const reply = await this.post({ jsonrpc: '2.0', id: packet.id, error: { code: -32601, message: 'Client capability not supported' } }); await reply.body?.cancel(); return { found: false };
    }
    if (packet.id !== id) return { found: false };
    if (packet.error) throw mcpError(`MCP 协议错误 (${packet.error.code ?? 'unknown'})`, 502);
    if (!Object.hasOwn(packet, 'result')) throw mcpError('MCP 响应缺少结果', 502);
    return { found: true, result: packet.result };
  }
  async rpc(method: string, params: unknown): Promise<unknown> {
    const id = randomUUID(); let dispatched = false;
    try {
      dispatched = true;
      const response = await this.post({ jsonrpc: '2.0', id, method, params });
      if (!response.body) throw mcpError('MCP 返回空响应', 502);
      const isSse = response.headers.get('content-type')?.includes('text/event-stream');
      if (!isSse && !response.headers.get('content-type')?.includes('application/json')) { await response.body.cancel(); throw mcpError('此地址不是支持的 MCP HTTP 端点', 502); }
      const reader = response.body.getReader(); const decoder = new TextDecoder('utf-8', { fatal: true }); let text = '', size = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) { text += decoder.decode(); break; }
          size += chunk.value.length; if (size > 2 * 1024 * 1024) throw mcpError('MCP 响应超过2MiB限制', 502);
          text += decoder.decode(chunk.value, { stream: true });
          if (isSse) {
            for (;;) {
              const separator = /\r?\n\r?\n/.exec(text); if (!separator) break;
              const frame = text.slice(0, separator.index); text = text.slice(separator.index + separator[0].length);
              const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
              if (!data.trim()) continue;
              const result = await this.packet(JSON.parse(data) as Rpc, id); if (result.found) return result.result;
            }
          }
        }
        if (!isSse) { const result = await this.packet(JSON.parse(text) as Rpc, id); if (result.found) return result.result; }
        throw mcpError('MCP 连接提前结束，执行结果未知；不会自动重试', 502);
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    } catch (error) {
      if (dispatched && method === 'tools/call') {
        await this.post({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'Client stopped waiting' } }, AbortSignal.timeout(1500)).then(r => r.body?.cancel()).catch(() => undefined);
      }
      throw error;
    }
  }
  async initialize(): Promise<void> {
    const value = await this.rpc('initialize', { protocolVersion: protocols[0], capabilities: {}, clientInfo: { name: 'WorkPivot', version: '1.0' } }) as { protocolVersion?: string; capabilities?: { tools?: unknown } };
    if (!value || !protocols.includes(value.protocolVersion ?? '') || !value.capabilities?.tools) throw mcpError('服务不支持当前 HTTP 协议版本或工具能力', 502);
    this.protocol = value.protocolVersion!;
    const response = await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }); await response.body?.cancel();
  }
  async tools(): Promise<RemoteTool[]> {
    const tools: RemoteTool[] = []; const cursors = new Set<string>(); let cursor: string | undefined;
    do {
      const page = await this.rpc('tools/list', cursor ? { cursor } : {}) as { tools?: unknown; nextCursor?: unknown };
      if (!page || !Array.isArray(page.tools)) throw mcpError('MCP 工具列表无效', 502);
      for (const tool of page.tools as Array<Partial<RemoteTool>>) {
        if (typeof tool?.name !== 'string' || !tool.name || tool.name.length > 128 || !tool.inputSchema || tool.inputSchema.type !== 'object' || JSON.stringify(tool.inputSchema).length > 16000 || (tool.description !== undefined && typeof tool.description !== 'string') || tools.some(t => t.name === tool.name)) throw mcpError('MCP 工具定义无效或重复', 502);
        tools.push({ name: tool.name, description: (tool.description ?? '').slice(0, 2000), inputSchema: tool.inputSchema });
        if (tools.length > 64) throw mcpError('单个服务最多支持64个工具', 502);
      }
      if (page.nextCursor !== undefined && (typeof page.nextCursor !== 'string' || !page.nextCursor || page.nextCursor.length > 2048 || cursors.has(page.nextCursor))) throw mcpError('MCP 分页游标无效', 502);
      cursor = page.nextCursor as string | undefined; if (cursor) cursors.add(cursor);
      if (cursors.size > 16) throw mcpError('MCP 工具分页过多', 502);
    } while (cursor);
    return tools;
  }
  async close(): Promise<void> {
    if (!this.session) return;
    await fetch(this.row.url, { method: 'DELETE', headers: this.headers(), redirect: 'error', signal: AbortSignal.timeout(1500) }).then(r => r.body?.cancel()).catch(() => undefined);
  }
}
async function connected<T>(row: Connection, signal: AbortSignal | undefined, fn: (session: HttpSession) => Promise<T>): Promise<T> {
  const controller = new AbortController(); const current = active.get(row.id) ?? new Set<AbortController>(); current.add(controller); active.set(row.id, current);
  const combined = AbortSignal.any([controller.signal, AbortSignal.timeout(30000), ...(signal ? [signal] : [])]); const session = new HttpSession(row, combined);
  try { await session.initialize(); return await fn(session); }
  catch (error) { if ((error as { status?: number }).status) throw error; throw mcpError(combined.aborted ? 'MCP 调用已停止或超时；远端操作可能仍在执行，请确认结果后再试' : 'MCP 连接或响应异常，请检查地址、服务和凭据；不会自动重试调用', 502); }
  finally { current.delete(controller); if (!current.size) active.delete(row.id); await session.close(); }
}
export async function testMcp(id: string, revision: unknown) {
  const row = get(id); if (row.revision !== revision) throw mcpError('配置已改变，请刷新', 409);
  try {
    const tools = await connected(row, undefined, session => session.tools());
    const rows = read(); const current = get(id); if (current.revision !== row.revision) throw mcpError('测试期间配置已改变，请重新测试', 409);
    cancel(id); Object.assign(current, { tools, checkedAt: new Date().toISOString(), status: 'ready', error: undefined, enabled: false, revision: randomUUID() }); rows[rows.findIndex(r => r.id === id)] = current; write(rows);
    return listMcp().find(r => r.id === id)!;
  } catch (error) {
    const rows = read(); const current = rows.find(r => r.id === id);
    if (current?.revision === row.revision) { cancel(id); Object.assign(current, { status: 'error', enabled: false, error: (error as Error).message, revision: randomUUID(), checkedAt: new Date().toISOString() }); write(rows); }
    throw error;
  }
}
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function mcpTools(): Tool[] {
  return read().filter(row => row.enabled && row.status === 'ready').flatMap(row => enabledTools(row).map(remote => {
    const name = 'mcp_' + fingerprint([row.id, remote.name]).slice(0, 24);
    return {
      name, displayName: `${row.name} / ${remote.name}`, kind: 'write' as const, description: `[MCP: ${row.name} / ${remote.name}] ${remote.description}`, parameters: remote.inputSchema,
      access(args: Record<string, unknown>) {
        const argumentsText = JSON.stringify(args); if (argumentsText.length > 16000) throw mcpError('MCP 调用参数超过16KiB');
        return { tool: name, kind: 'write' as const, paths: [], external: true, command: `服务：${row.name}\n地址：${row.url}\n工具：${remote.name}\n参数：${argumentsText}` };
      },
      async run(args: Record<string, unknown>, ctx: ToolContext) {
        if (!ctx.requestAccess) throw mcpError('MCP 调用必须经过任务授权');
        const current = get(row.id);
        if (!current.enabled || current.revision !== row.revision) throw mcpError('MCP 配置或工具已改变，请开始新一轮任务');
        return connected(current, ctx.signal, async session => {
          const fresh = (await session.tools()).find(t => t.name === remote.name);
          if (!fresh || fingerprint(fresh) !== fingerprint(remote)) throw mcpError('远端工具定义已改变，请在后台重新测试连接');
          const latest = get(row.id); if (!latest.enabled || latest.revision !== row.revision) throw mcpError('MCP 配置已停用或修改');
          const result = await session.rpc('tools/call', { name: remote.name, arguments: args }) as { content?: unknown; structuredContent?: unknown; isError?: boolean };
          if (!result || !Array.isArray(result.content)) throw mcpError('MCP 工具结果无效', 502);
          const content = result.content.map((block: { type?: string; text?: string; mimeType?: string }) => block.type === 'text' && typeof block.text === 'string' ? block.text : `[${block.type ?? 'unknown'} 内容，请在 MCP 服务中查看]`);
          if (result.isError === true) throw mcpError('MCP 工具执行失败：' + content.join('\n').slice(0, 8000), 502);
          return JSON.stringify({ server: row.name, tool: remote.name, isError: false, content, ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}) });
        });
      },
    };
  })).slice(0, 128);
}
