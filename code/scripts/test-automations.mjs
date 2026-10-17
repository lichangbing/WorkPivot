import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
const webOnly = process.argv.includes('--web');
if (process.argv.slice(2).some(arg => arg !== '--web')) throw Error('Unsupported automation test option');
const useWsl = process.platform === 'win32';
const docker = args => {
  try { return execFileSync(useWsl ? 'wsl' : 'docker', useWsl ? ['-d', 'Ubuntu-24.04', '--', 'docker', ...args] : args, { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch { throw Error('PostgreSQL测试容器操作失败（凭据已隐藏）'); }
};
const image = process.env.WORKPIVOT_TEST_PG_IMAGE || 'pgvector/pgvector:pg16';
const container = 'workpivot-automations-' + Date.now();
const password = randomBytes(24).toString('hex'); let started = false;
let keepAlive;
try {
  // 在短暂 Docker 命令调用和 Windows 测试进程之间保持 WSL 运行。
  // 此辅助进程仅属于本次调用，不挂载 Docker 套接字。
  if (useWsl) {
    keepAlive = spawn('wsl', ['-d', 'Ubuntu-24.04', '--', 'sleep', 'infinity'], { windowsHide: true, stdio: 'ignore' });
    await once(keepAlive, 'spawn');
  }
  docker(['image', 'inspect', image]);
  docker(['run', '-d', '--name', container, '--label', 'workpivot.disposable=postgres-test', '--tmpfs', '/var/lib/postgresql/data:rw,nosuid,size=512m', '-p', '127.0.0.1::5432', '-e', 'POSTGRES_PASSWORD=' + password, '-e', 'POSTGRES_DB=workpivot_test', image]);
  started = true;
  let ready = false;
  for (let i = 0; i < 30; i++) { try { docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'workpivot_test']); ready = true; break; } catch { await new Promise(r => setTimeout(r, 500)); } }
  if (!ready) throw Error('测试数据库启动超时');
  const info = JSON.parse(docker(['inspect', container]))[0];
  const port = info.NetworkSettings.Ports['5432/tcp'][0].HostPort;
  console.log('Disposable PostgreSQL ready; isolated tmpfs, no business volumes, no Docker socket mount');
  const run = spawnSync(process.execPath, ['--import', 'tsx', webOnly ? 'eval/web-database.mts' : 'eval/automation-workflow.mts'], { cwd: resolve(import.meta.dirname, '..'), env: { ...process.env, WORKPIVOT_TEST_PG_DISPOSABLE: '1', WORKPIVOT_TEST_PG_URL: `postgresql://postgres:${password}@127.0.0.1:${port}/workpivot_test` }, stdio: 'inherit', timeout: 900000 });
  if (run.error) throw Error('数据库测试未能完成');
  process.exitCode = run.status ?? 1;
} finally {
  try { if (started) {
    const info = JSON.parse(docker(['inspect', container]))[0];
    if (info.Config.Labels['workpivot.disposable'] !== 'postgres-test') throw Error('拒绝清理非本次测试容器');
    docker(['rm', '-f', container]);
    console.log('Disposable PostgreSQL container cleaned');
  } } finally { keepAlive?.kill(); }
}
