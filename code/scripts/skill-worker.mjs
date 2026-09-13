// Run on the Docker host as a dedicated service. No socket is mounted into any container.
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, writeFileSync, rmSync, readdirSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const execute = promisify(execFile);
const LIMIT = 16 * 1024 * 1024;
const OWNER = 'workpivot-skill-worker-v1';
export function validateFiles(value) {
  if (!Array.isArray(value) || value.length > 4000) throw Error('文件列表无效');
  const seen = new Set(); let total = 0;
  return value.map((entry) => {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || typeof entry[1] !== 'string' || /[\\:\0]/.test(entry[0]) || entry[0].split('/').some((part) => !part || part === '.' || part === '..') || seen.has(entry[0])) throw Error('文件路径无效');
    const bytes = Buffer.from(entry[1], 'base64');
    if (bytes.toString('base64') !== entry[1]) throw Error('文件编码无效');
    total += bytes.length; if (total > LIMIT) throw Error('文件超过16MiB');
    seen.add(entry[0]); return [entry[0], bytes];
  });
}
// Executed in the sandbox, where all files remain untrusted. No host writes from exported paths.
function exportFiles() {
  // Serialized into `node -e` inside the sandbox, which uses CommonJS.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs'), path = require('node:path');
  const files = []; let total = 0, entries = 0;
  function walk(relative) {
    for (const name of fs.readdirSync(path.join('/workspace', relative))) {
      if (++entries > 4000) throw Error('too many files');
      const rel = relative ? `${relative}/${name}` : name, file = path.join('/workspace', rel), stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || stat.isFile() && stat.nlink !== 1) throw Error('links forbidden');
      if (stat.isDirectory()) { walk(rel); continue; }
      if (!stat.isFile()) throw Error('special files forbidden');
      total += stat.size; if (total > 16 * 1024 * 1024) throw Error('output too large');
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try { const opened = fs.fstatSync(fd); if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size !== stat.size || opened.nlink !== 1) throw Error('file changed'); const data = Buffer.alloc(stat.size); let offset = 0; while (offset < data.length) { const n = fs.readSync(fd, data, offset, data.length - offset, offset); if (!n) throw Error('file truncated'); offset += n; } files.push([rel, data.toString('base64')]); } finally { fs.closeSync(fd); }
    }
  }
  walk(''); process.stdout.write(JSON.stringify(files));
}
export async function startWorker({ host = '127.0.0.1', port = 39990, token, image, timeoutMs = 120000, owner = OWNER, stateDir = join(tmpdir(), owner) }) {
  if (!token || token.length < 32 || !image) throw Error('Worker token and fixed image are required');
  if (!/^[a-z0-9-]{1,64}$/.test(owner)) throw Error('Invalid worker instance');
  const docker = (args, signal, maxBuffer = 1024 * 1024) => execute('docker', args, { signal, timeout: timeoutMs + 10000, maxBuffer });
  await docker(['image', 'inspect', image]);
  // Remove only our own stranded, short-lived workers; never business containers.
  const old = await docker(['ps', '-a', '--filter', `label=workpivot.worker=${owner}`, '--format', '{{.Names}}']);
  for (const name of old.stdout.trim().split('\n').filter(Boolean)) if (/^wp-skill-[a-f0-9-]{36}$/.test(name)) await docker(['rm', '-f', name]);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  if (lstatSync(stateDir).isSymbolicLink()) throw Error('Worker state cannot be a link');
  for (const entry of readdirSync(stateDir)) if (/^job-[a-f0-9-]{36}$/.test(entry)) { const path = join(stateDir, entry); if (lstatSync(path).isSymbolicLink()) throw Error('Worker staging cannot be a link'); rmSync(path, { recursive: true, force: true }); }
  const active = new Set();
  const server = createServer(async (req, res) => {
    const supplied = Buffer.from(req.headers.authorization ?? ''), expected = Buffer.from(`Bearer ${token}`);
    const reply = (status, value) => { if (!res.destroyed) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); } };
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { reply(401, { error: '未授权' }); req.resume(); return; }
    if (req.method === 'GET' && req.url === '/v1/health') { reply(200, { ok: true, protocol: 1, busy: active.size }); return; }
    if (req.method !== 'POST' || req.url !== '/v1/run') { reply(404, { error: '接口不存在' }); return; }
    if (active.size >= 2) { reply(429, { error: '执行服务繁忙，请稍后重试' }); req.resume(); return; }
    const controller = new AbortController(); active.add(controller);
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', abort);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let directory, name; let created = false;
    try {
      let length = 0; const chunks = [];
      for await (const chunk of req) { length += chunk.length; if (length > 24 * 1024 * 1024) throw Error('请求过大'); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (Object.keys(body).some((key) => !['command', 'files', 'skills'].includes(key)) || typeof body.command !== 'string' || !body.command.trim() || body.command.length > 65536) throw Error('请求无效');
      const input = validateFiles(body.files), resources = validateFiles(body.skills);
      if ([...input, ...resources].reduce((sum, [, bytes]) => sum + bytes.length, 0) > LIMIT) throw Error('任务和技能文件合计超过16MiB');
      directory = join(stateDir, 'job-' + randomUUID()); mkdirSync(directory, { mode: 0o700 });
      for (const folder of ['input', 'skills']) mkdirSync(join(directory, folder));
      for (const [folder, files] of [['input', input], ['skills', resources]]) for (const [path, bytes] of files) { const target = join(directory, folder, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes); }
      controller.signal.throwIfAborted(); name = `wp-skill-${randomUUID()}`; created = true;
      await docker(['create', '--rm', '--name', name, '--label', `workpivot.worker=${owner}`, '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--pids-limit', '128', '--memory', '512m', '--cpus', '1', '--user', '1000:1000', '--mount', `type=bind,src=${directory}/input,dst=/input,readonly`, '--mount', `type=bind,src=${directory}/skills,dst=/skills,readonly`, '--tmpfs', '/workspace:rw,nosuid,nodev,size=64m,uid=1000,gid=1000', '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m', '--tmpfs', '/data/workpivot:ro,size=1m', '--tmpfs', '/data/workspace:ro,size=1m', '--workdir', '/workspace', '--env', 'HOME=/tmp', '--env', 'NODE_PATH=/app/packages/server/node_modules', '--entrypoint', '/bin/sh', image, '-c', 'exec sleep 150']);
      controller.signal.throwIfAborted(); await docker(['start', name], controller.signal);
      await docker(['exec', name, 'cp', '-R', '/input/.', '/workspace/'], controller.signal);
      const result = await docker(['exec', name, '/bin/sh', '-c', body.command], controller.signal);
      const output = await docker(['exec', name, 'node', '-e', `(${exportFiles.toString()})()`], controller.signal, 24 * 1024 * 1024);
      await docker(['rm', '-f', name]); created = false;
      controller.signal.throwIfAborted();
      const files = JSON.parse(output.stdout); validateFiles(files);
      reply(200, { files, output: (result.stdout + result.stderr).slice(0, 65536) });
    } catch (error) {
      // Never include worker environment, Docker arguments or host staging paths in errors.
      const detail = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr ?? '').slice(0, 4000) : '';
      reply(400, { error: controller.signal.aborted ? '执行已停止或超时，未回写文件' : `执行失败，未回写文件${detail ? `：${detail}` : ''}` });
    } finally {
      clearTimeout(timer); res.removeListener('close', abort);
      try { if (created) await docker(['rm', '-f', name]); if (directory) rmSync(directory, { recursive: true, force: true }); }
      catch { console.error('Worker cleanup failed; TTL recovery will remove the sandbox'); }
      active.delete(controller);
    }
  });
  server.requestTimeout = 15000;
  await new Promise((resolve) => server.listen(port, host, resolve));
  return { server, close: async () => { for (const controller of active) controller.abort(); await new Promise((resolve) => server.close(resolve)); } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const worker = await startWorker({ host: process.env.WORKPIVOT_WORKER_BIND ?? '127.0.0.1', port: Number(process.env.WORKPIVOT_WORKER_PORT ?? 39990), token: process.env.WORKPIVOT_WORKER_TOKEN, image: process.env.WORKPIVOT_WORKER_IMAGE });
  console.log('Skill worker ready');
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void worker.close().then(() => process.exit(0)); });
}
