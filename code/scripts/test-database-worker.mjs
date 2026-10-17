// Linux/WSL 宿主测试入口：专用 PostgreSQL、真实执行器及受控模型夹具。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { startWorker } from './skill-worker.mjs';

if (process.platform !== 'linux') throw Error('Run on WSL/Linux Docker host');
const execute = promisify(execFile);
const docker = async args => (await execute('docker', args, { timeout: 120000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
const prefix = 'wp-joint-' + randomBytes(8).toString('hex'), database = prefix + '-db', api = prefix + '-api';
const owner = prefix + '-worker', token = randomBytes(24).toString('hex'), password = randomBytes(24).toString('hex');
const stateDir = await mkdtemp(join(tmpdir(), prefix));
const code = resolve(import.meta.dirname, '..');
const image = process.env.WORKPIVOT_TEST_SERVICE_IMAGE || 'workpivot-server:0.3.0-rc.1-recovery-validation-20260929';
let worker, control, dbCreated = false, apiCreated = false;
const sandboxes = async () => (await docker(['ps', '-a', '--filter', `label=workpivot.worker=${owner}`, '--format', '{{.Names}}'])).split('\n').filter(Boolean);
const wait = async predicate => {
  for (let i = 0; i < 100; i++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 100)); }
  throw Error('Fixture condition timed out');
};
try {
  worker = await startWorker({ token, image: process.env.WORKPIVOT_TEST_IMAGE || 'workpivot-executor:0.2.0', port: 0, owner, stateDir, timeoutMs: 60000 });
  const workerUrl = `http://127.0.0.1:${worker.server.address().port}`;
  control = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.headers.authorization !== `Bearer ${token}` || !['/started', '/kill', '/idle'].includes(req.url)) { res.writeHead(403).end(); return; }
    try {
      if (req.url === '/idle') {
        await wait(async () => {
          const health = await (await fetch(workerUrl + '/v1/health', { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1000) })).json();
          return health.busy === 0 && (await sandboxes()).length === 0;
        });
      } else {
        let name;
        await wait(async () => {
          const list = await sandboxes(); if (list.length !== 1) return false;
          try { await docker(['exec', list[0], 'test', '-f', '/workspace/started']); name = list[0]; return true; } catch { return false; }
        });
        if (req.url === '/kill') await docker(['kill', '--signal', 'KILL', name]);
      }
      res.end('ok');
    } catch { res.writeHead(500).end('Fixture control failed'); }
  });
  await new Promise(r => control.listen(0, '127.0.0.1', r));
  await docker(['run', '-d', '--name', database, '--label', 'workpivot.disposable=joint-worker', '--tmpfs', '/var/lib/postgresql/data:rw,nosuid,size=512m', '-p', '127.0.0.1::5432', '-e', 'POSTGRES_DB=workpivot_joint', '-e', 'POSTGRES_PASSWORD=' + password, process.env.WORKPIVOT_TEST_PG_IMAGE || 'pgvector/pgvector:pg15']); dbCreated = true;
  await wait(async () => { try { await docker(['exec', database, 'pg_isready', '-U', 'postgres', '-d', 'workpivot_joint']); return true; } catch { return false; } });
  const dbInfo = JSON.parse(await docker(['inspect', database]))[0];
  const port = dbInfo.NetworkSettings.Ports['5432/tcp'][0].HostPort;
  // 可信测试代码通过宿主回环连接专用执行器；技能沙箱仍使用 network=none。
  await docker(['create', '--name', api, '--label', 'workpivot.disposable=joint-worker', '--network', 'host', '--user', 'node',
    '-e', 'WORKPIVOT_JOINT_FIXTURE=1', '-e', `WORKPIVOT_TEST_PG_URL=postgresql://postgres:${password}@127.0.0.1:${port}/workpivot_joint`,
    '-e', 'WORKPIVOT_WORKER_URL=' + workerUrl, '-e', 'WORKPIVOT_WORKER_TOKEN=' + token,
    '-e', `WORKPIVOT_JOINT_CONTROL_URL=http://127.0.0.1:${control.address().port}`, image,
    './node_modules/.bin/tsx', 'eval/database-worker-joint.mts']); apiCreated = true;
  for (const folder of ['server', 'core', 'shared']) await docker(['cp', resolve(code, `packages/${folder}/src`) + '/.', `${api}:/app/packages/${folder}/src/`]);
  await docker(['cp', resolve(code, 'eval/database-worker-joint.mts'), `${api}:/app/eval/database-worker-joint.mts`]);
  await docker(['start', api]);
  const status = await docker(['wait', api]);
  const logs = await execute('docker', ['logs', api], { timeout: 15000, maxBuffer: 1024 * 1024 });
  console.log((logs.stdout + logs.stderr).replaceAll(password, '[redacted]').replaceAll(token, '[redacted]'));
  if (status !== '0') throw Error('Database worker integration failed');
} catch (error) {
  // execFile 错误包含参数及临时密码，禁止打印整个错误对象。
  console.error(error.message === 'Database worker integration failed' ? error.message : 'Joint fixture failed; credentials withheld'); process.exitCode = 1;
} finally {
  control?.closeAllConnections(); if (control) await new Promise(r => control.close(r));
  await worker?.close();
  for (const name of await sandboxes()) await docker(['rm', '-f', name]);
  for (const [created, name] of [[apiCreated, api], [dbCreated, database]]) if (created) {
    const info = JSON.parse(await docker(['inspect', name]))[0];
    if (info.Config.Labels?.['workpivot.disposable'] !== 'joint-worker') throw Error('Refusing to remove non-test container');
    await docker(['rm', '-f', name]);
  }
  await rm(stateDir, { recursive: true, force: true });
}
