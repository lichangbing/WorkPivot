// Isolated protocol fixture: persist a real side effect, then withhold its response.
import { createServer } from 'node:http';
import { appendFile, readFile } from 'node:fs/promises';
if (process.env.WORKPIVOT_SERVICE_RECOVERY_FIXTURE !== '1') throw Error('Disposable fixture only');
const auditPath = '/tmp/recovery-mcp-audit.txt';
const pending = new Set();
let released = false;
const finish = (res, id) => res.end(JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'side effect persisted' }] } }));
const server = createServer(async (req, res) => {
  try {
    if (req.url === '/audit' && req.method === 'GET') {
      let content = '';
      try { content = await readFile(auditPath, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ calls: content.split('\n').filter(Boolean).length, released })); return;
    }
    if (req.url === '/release' && req.method === 'POST') {
      released = true;
      for (const entry of pending) finish(entry.res, entry.id);
      pending.clear(); res.end('released'); return;
    }
    if (req.method === 'DELETE') { res.writeHead(204).end(); return; }
    if (req.url !== '/mcp' || req.method !== 'POST') { res.writeHead(404).end(); return; }
    const chunks = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const packet = JSON.parse(Buffer.concat(chunks).toString());
    if (!packet.id) { res.writeHead(202).end(); return; }
    res.setHeader('content-type', 'application/json');
    if (packet.method === 'tools/call') {
      await appendFile(auditPath, 'executed\n', { mode: 0o600 });
      if (released) finish(res, packet.id);
      else {
        const entry = { res, id: packet.id }; pending.add(entry);
        res.once('close', () => pending.delete(entry));
      }
      return;
    }
    const result = packet.method === 'initialize'
      ? { protocolVersion: '2025-11-25', capabilities: { tools: {} } }
      : { tools: [{ name: 'persist_marker', description: 'Write one test audit marker', inputSchema: { type: 'object', properties: {} } }] };
    res.end(JSON.stringify({ jsonrpc: '2.0', id: packet.id, result }));
  } catch { res.writeHead(500).end(); }
});
server.listen(39801, '0.0.0.0');
