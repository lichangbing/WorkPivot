import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
const root = mkdtempSync(join(tmpdir(), 'wp31-'));
Object.assign(process.env, { WORKPIVOT_HOME: join(root, 'home'), WORKPIVOT_WORKSPACE: join(root, 'workspace'), WORKPIVOT_HOST: '127.0.0.1', WORKPIVOT_SECRET_KEY: '12'.repeat(32), WORKPIVOT_EXECUTION_MODE: 'disabled', NODE_ENV: 'test' });
const { withTenant, withAccount } = await import('../packages/server/src/tenants.js');
const auth = await import('../packages/server/src/auth.js');
const { createApp } = await import('../packages/server/src/app.js');
const mcp = await import('../packages/server/src/mcp.js');
const { ensureWorkpivotDir } = await import('../packages/server/src/store.js');
const { createTask } = await import('../packages/server/src/tasks.js');
const { saveProvider } = await import('../packages/server/src/providers.js');
const admin = withTenant('default', () => auth.registerFirstAdmin('mcp-admin', 'fixture-password'));
const other = withTenant('default', () => { auth.createUser('other-admin', 'fixture-password', 'admin'); return auth.login('other-admin', 'fixture-password'); });
const member = withTenant('default', () => { auth.createUser('member', 'fixture-password', 'member'); return auth.login('member', 'fixture-password'); });
let calls = 0, closes = 0, protocolHeaders = 0, tokenHeaders = 0, changed = false, hold = false, broken = false;
const remote = createServer((req, res) => {
  if (req.method === 'DELETE') { closes++; res.writeHead(204); res.end(); return; }
  let body = ''; req.on('data', chunk => { body += chunk.toString(); });
  req.on('end', () => {
    if (req.url === '/redirect') { res.writeHead(307, { location: '/mcp' }); res.end(); return; }
    const packet = JSON.parse(body);
    if (req.headers.authorization === 'Bearer fixture-mcp-token') tokenHeaders++;
    if (req.headers['mcp-session-id'] === 'fixture-session' && req.headers['mcp-protocol-version'] === '2025-11-25') protocolHeaders++;
    if (!packet.id) { res.writeHead(202); res.end(); return; }
    let result: unknown;
    if (packet.method === 'initialize') { res.setHeader('Mcp-Session-Id', 'fixture-session'); result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }; }
    else if (packet.method === 'tools/list') result = packet.params?.cursor ? { tools: [{ name: 'second', description: 'second tool', inputSchema: { type: 'object' } }] } : { tools: [{ name: 'echo', description: changed ? 'changed' : 'Echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }], nextCursor: 'page2' };
    else if (packet.method === 'tools/call') { calls++; if (hold) return; if (broken) { res.destroy(); return; } result = { content: [{ type: 'text', text: '收到：' + packet.params.arguments.text }], structuredContent: { ok: true } }; }
    else { res.writeHead(400); res.end(); return; }
    const response = JSON.stringify({ jsonrpc: '2.0', id: packet.id, result });
    if (packet.method === 'tools/call') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const bytes = Buffer.from('event: message\r\ndata: ' + response + '\r\n\r\n');
      const split = bytes.indexOf(Buffer.from('收到')) + 1;
      res.write(bytes.subarray(0, split)); setTimeout(() => res.end(bytes.subarray(split)), 5);
    } else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(response); }
  });
});
remote.listen(0, '127.0.0.1'); await new Promise<void>(r => remote.once('listening', r));
const remoteAddress = remote.address(); if (!remoteAddress || typeof remoteAddress === 'string') throw Error('port');
const endpoint = 'http://127.0.0.1:' + remoteAddress.port + '/mcp';
const model = createServer((req, res) => {
  let body = ''; req.on('data', chunk => { body += chunk.toString(); }); req.on('end', () => {
    const input = JSON.parse(body);
    const tool = input.tools?.find((t: { function: { name: string } }) => t.function.name.startsWith('mcp_'));
    const result = input.messages.findLast((m: { role: string }) => m.role === 'tool');
    const delta = result ? { content: '模型收到工具结果：' + result.content } : { tool_calls: [{ index: 0, id: 'mcp-call', function: { name: tool.function.name, arguments: '{"text":"你好"}' } }] };
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\ndata: [DONE]\n\n');
  });
});
model.listen(0, '127.0.0.1'); await new Promise<void>(r => model.once('listening', r));
const modelAddress = model.address(); if (!modelAddress || typeof modelAddress === 'string') throw Error('port');
await withTenant('default', () => saveProvider({ name: 'fixture', baseUrl: 'http://127.0.0.1:' + modelAddress.port + '/v1', modelId: 'fixture', apiKey: 'fixture', verify: false }));
const server = createApp().listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
const address = server.address(); if (!address || typeof address === 'string') throw Error('port');
const request = (path: string, method = 'GET', body?: unknown, token = admin.token) => fetch('http://127.0.0.1:' + address.port + '/api' + path, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
let count = 0; function check(name: string, value: unknown): void { assert.ok(value, name); count++; console.log('✅ ' + name); }
const current = () => withAccount(admin.user, () => mcp.listMcp()[0]!);
try {
  check('member cannot configure MCP', (await request('/mcp', 'GET', undefined, member.token)).status === 403);
  check('credential in URL rejected', (await request('/mcp', 'POST', { name: 'bad', url: endpoint + '?token=secret' })).status === 400);
  let row = await (await request('/mcp', 'POST', { name: 'Fixture', url: endpoint, token: 'fixture-mcp-token' })).json();
  check('created disabled and credential redacted', !row.enabled && row.hasToken && !JSON.stringify(row).includes('fixture-mcp-token'));
  const stored = withAccount(admin.user, () => readFileSync(join(ensureWorkpivotDir('config'), 'mcp.json'), 'utf8'));
  check('credential encrypted at rest', stored.includes('aes-256-gcm') && !stored.includes('fixture-mcp-token'));
  check('other admin cannot see configuration', !(await (await request('/mcp', 'GET', undefined, other.token)).json()).connections.length);
  check('other admin cannot mutate connection', (await request('/mcp/' + row.id, 'DELETE', { revision: row.revision }, other.token)).status === 404);
  check('untested connection cannot enable', (await request('/mcp/' + row.id + '/toggle', 'POST', { revision: row.revision, enabled: true })).status === 400);
  row = await (await request('/mcp/' + row.id + '/test', 'POST', { revision: row.revision })).json();
  check('handshake and paginated discovery', row.status === 'ready' && row.tools.length === 2 && protocolHeaders >= 3 && tokenHeaders >= 4 && closes === 1);
  check('stale update rejected', (await request('/mcp/' + row.id, 'PUT', { ...row, revision: 'stale' })).status === 409);
  await request('/mcp/' + row.id + '/toggle', 'POST', { revision: row.revision, enabled: true });
  check('enabled tools enter account catalog', withAccount(admin.user, () => mcp.mcpTools().length) === 2 && withAccount(other.user, () => mcp.mcpTools().length) === 0);
  row = current();
  check('foreign admin cannot toggle individual tool', (await request('/mcp/' + row.id + '/tools/toggle', 'POST', { name: 'second', enabled: false, revision: row.revision }, other.token)).status === 404);
  check('unknown tool rejected', (await request('/mcp/' + row.id + '/tools/toggle', 'POST', { name: 'absent', enabled: false, revision: row.revision })).status === 404);
  check('invalid tool switch rejected', (await request('/mcp/' + row.id + '/tools/toggle', 'POST', { name: 'second', enabled: 'false', revision: row.revision })).status === 400);
  const oldTool = withAccount(admin.user, () => mcp.mcpTools()[1]!);
  await request('/mcp/' + row.id + '/tools/toggle', 'POST', { name: 'second', enabled: false, revision: row.revision });
  check('disabled tool excluded while sibling remains', withAccount(admin.user, () => mcp.mcpTools().length) === 1);
  await assert.rejects(withAccount(admin.user, () => oldTool.run({}, { taskDir: root, requestAccess: async () => true })), /已改变/);
  check('stale tool reference cannot bypass disable', calls === 0);
  check('stale switch rejected', (await request('/mcp/' + row.id + '/tools/toggle', 'POST', { name: 'second', enabled: true, revision: row.revision })).status === 409);
  row = current(); row = await (await request('/mcp/' + row.id + '/test', 'POST', { revision: row.revision })).json();
  check('retest retains individual disabled choices', row.disabledTools.includes('second'));
  await request('/mcp/' + row.id + '/toggle', 'POST', { revision: row.revision, enabled: true });
  const sidebar = await (await request('/sidebar')).json();
  check('sidebar exposes tool names and availability', sidebar.mcp[0].toolCount === 1 && sidebar.mcp[0].tools.find((t: { name: string }) => t.name === 'second').enabled === false);
  withTenant('default', () => auth.setUserTier(admin.user.id, 'auto'));
  for (const decision of ['deny', 'allow']) {
    const task = withAccount(admin.user, () => createTask({ name: decision, directory: '', temp: true, ownerUserId: admin.user.id }));
    const before = calls;
    const stream = await request('/tasks/' + task.id + '/messages', 'POST', { content: 'call MCP' });
    let detail;
    for (let i = 0; i < 200; i++) { detail = await (await request('/tasks/' + task.id)).json(); if (detail.pending?.length) break; await new Promise(r => setTimeout(r, 20)); }
    check('external approval requested in auto mode: ' + decision, detail.pending?.[0]?.scope === 'once' && detail.pending[0].command.includes('你好') && calls === before);
    check('foreign account cannot inspect approval: ' + decision, (await request('/tasks/' + task.id, 'GET', undefined, other.token)).status === 404);
    check('permanent approval rejected: ' + decision, (await request('/tasks/' + task.id + '/permission', 'POST', { id: detail.pending[0].id, decision: 'forever' })).status >= 400);
    await request('/tasks/' + task.id + '/permission', 'POST', { id: detail.pending[0].id, decision });
    const output = await stream.text();
    const events = output.split('\n').filter(l => l.startsWith('data:')).map(l => JSON.parse(l.slice(5)));
    const resultEvent = events.find(e => e.type === 'tool_result');
    check('friendly metadata and status: ' + decision, resultEvent.displayName === 'Fixture / echo' && resultEvent.callId === 'mcp-call' && resultEvent.status === (decision === 'allow' ? 'ok' : 'denied') && resultEvent.durationMs >= 0);
    check('execution transition only after approval: ' + decision, events.some(e => e.type === 'tool_status' && e.status === 'running') === (decision === 'allow'));
    check('task completed with expected external call count: ' + decision, calls === before + (decision === 'allow' ? 1 : 0));
    if (decision === 'allow') check('SSE Unicode result reaches model and assistant', output.includes('收到') && output.includes('你好') && output.includes('模型收到工具结果'));
  }
  const context = { taskDir: root, requestAccess: async () => true };
  const tool = withAccount(admin.user, () => mcp.mcpTools()[0]!);
  changed = true;
  await assert.rejects(withAccount(admin.user, () => tool.run({ text: 'blocked' }, context)), /工具定义已改变/); check('changed remote schema blocked before execution', calls === 1); changed = false;
  broken = true;
  await assert.rejects(withAccount(admin.user, () => tool.run({ text: 'once' }, context))); check('disconnect does not retry side effects', calls === 2); broken = false;
  hold = true;
  const pending = withAccount(admin.user, () => tool.run({ text: 'cancel' }, context));
  const rejected = assert.rejects(pending);
  for (let i = 0; i < 100 && calls < 3; i++) await new Promise(r => setTimeout(r, 10));
  row = current(); await request('/mcp/' + row.id + '/tools/toggle', 'POST', { revision: row.revision, name: 'echo', enabled: false });
  await rejected; check('disable aborts in-flight call and hides tools', withAccount(admin.user, () => mcp.mcpTools().length) === 0); hold = false;
  row = current(); await request('/mcp/' + row.id + '/tools/toggle', 'POST', { revision: row.revision, name: 'second', enabled: true });
  check('individual tool can re-enable', withAccount(admin.user, () => mcp.mcpTools().length) === 1);
  row = current(); row = await (await request('/mcp/' + row.id, 'PUT', { ...row, url: endpoint.replace('/mcp', '/redirect') })).json();
  check('changing endpoint clears old token', !row.hasToken);
  check('redirect refused', (await request('/mcp/' + row.id + '/test', 'POST', { revision: row.revision })).status === 502);
  row = current(); check('failed test stays disabled', row.status === 'error' && !row.enabled);
  check('delete succeeds', (await request('/mcp/' + row.id, 'DELETE', { revision: row.revision })).status === 200 && !withAccount(admin.user, () => mcp.listMcp().length));
  console.log('W31 ' + count + '/' + count + ' passed');
} finally { for (const item of [server, model, remote]) { item.closeAllConnections(); await new Promise<void>(r => item.close(() => r())); } }
