import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { McpRepository } from '../packages/server/src/database/mcp.js';

export async function testMcpFailures(db: Pool, actor: string, check: (v: unknown, name: string) => void) {
  let mode = 'ok', calls = 0;
  let dispatched: (() => void) | undefined;
  const server = createServer(async (req, res) => {
    if (req.method === 'DELETE') { res.writeHead(204).end(); return; }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const packet = JSON.parse(Buffer.concat(chunks).toString());
    if (!packet.id) { res.writeHead(202).end(); return; }
    if (mode === 'unavailable') { res.writeHead(503).end(); return; }
    let result: unknown;
    if (packet.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} } };
    else if (packet.method === 'tools/list') result = { tools: [{ name: 'operation', description: 'test operation', inputSchema: { type: 'object', properties: {} } }] };
    else if (packet.method === 'tools/call') {
      calls++; dispatched?.();
      if (mode === 'disconnect') { req.socket.destroy(); return; }
      if (mode === 'hold') return;
      result = { content: [{ type: 'text', text: 'done' }], isError: mode === 'error' };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: packet.id, result }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing test port');
  const repo = new McpRepository(db, randomBytes(32).toString('hex'));
  let row = await repo.save(actor, { name: 'MCP failure fixture', url: `http://127.0.0.1:${address.port}/mcp` });
  try {
    row = await repo.discover(actor, row.id, row.revision); row = await repo.toggle(actor, row.id, row.revision, true);
    const tool = (await repo.tools(actor)).find(t => t.displayName === 'MCP failure fixture / operation')!;
    const context = { taskDir: '.', requestAccess: async () => true };
    mode = 'disconnect';
    await assert.rejects(tool.run({}, context), /不会自动重试/);
    check(calls === 1, 'MCP lost response dispatches side effect exactly once');
    mode = 'error'; await assert.rejects(tool.run({}, context), /执行失败/);
    check(calls === 2, 'MCP remote tool error is not automatically retried');
    mode = 'hold'; const abort = new AbortController();
    const sent = new Promise<void>(resolve => { dispatched = resolve; });
    const pending = assert.rejects(tool.run({}, { ...context, signal: abort.signal }));
    await sent; abort.abort(); await pending;
    check(calls === 3, 'cancelling an in-flight MCP operation does not dispatch it again');
    dispatched = undefined;
    mode = 'unavailable'; await assert.rejects(repo.discover(actor, row.id, row.revision));
    row = (await repo.list(actor)).find(r => r.id === row.id)!;
    check(row.status === 'error' && !row.enabled, 'failed MCP reconnection disables the connection');
    mode = 'ok'; row = await repo.discover(actor, row.id, row.revision);
    check(row.status === 'ready' && !row.enabled, 'successful rediscovery still requires explicit enable');
    row = await repo.toggle(actor, row.id, row.revision, true);
    await assert.rejects(tool.run({}, context));
    check(calls === 3, 'old tool snapshot cannot bypass reconfiguration');
    const fresh = (await repo.tools(actor)).find(t => t.displayName === tool.displayName)!;
    check((await fresh.run({}, context)).includes('done') && calls === 4, 'explicitly enabled fresh MCP tool works after reconnection');
  } finally {
    await repo.remove(actor, row.id, row.revision);
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
