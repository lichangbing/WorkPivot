import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
const useWsl = process.platform === 'win32';
const docker = args => {
  try { return execFileSync(useWsl ? 'wsl' : 'docker', useWsl ? ['-d', 'Ubuntu-24.04', '--', 'docker', ...args] : args, { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch { throw Error('PostgreSQL测试容器操作失败（凭据已隐藏）'); }
};
const workflow = process.argv.includes('--workflow');
const live = process.argv.includes('--live');
if (process.argv.slice(2).some(arg => !['--workflow', '--live'].includes(arg)) || workflow && live) throw Error('Unsupported browser fixture option');
if (live && process.env.WORKPIVOT_LIVE_EVAL !== '1') throw Error('Real model calls require WORKPIVOT_LIVE_EVAL=1');
const image = process.env.WORKPIVOT_TEST_PG_IMAGE || (workflow ? 'pgvector/pgvector:pg15' : 'pgvector/pgvector:pg16');
const container = 'workpivot-pg-test-' + Date.now();
const password = randomBytes(24).toString('hex'); let started = false, keeper;
try {
  if (useWsl) { keeper = spawn('wsl', ['-d', 'Ubuntu-24.04', '--', 'sleep', 'infinity'], { windowsHide: true, stdio: 'ignore' }); await once(keeper, 'spawn'); }
  docker(['image', 'inspect', image]);
  docker(['run', '-d', '--name', container, '--label', 'workpivot.disposable=postgres-test', '--tmpfs', '/var/lib/postgresql/data:rw,nosuid,size=512m', '-p', '127.0.0.1::5432', '-e', 'POSTGRES_PASSWORD=' + password, '-e', 'POSTGRES_DB=workpivot_test', image]);
  started = true;
  let ready = false;
  for (let i = 0; i < 30; i++) { try { docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'workpivot_test']); ready = true; break; } catch { await new Promise(r => setTimeout(r, 500)); } }
  if (!ready) throw Error('测试数据库启动超时');
  const info = JSON.parse(docker(['inspect', container]))[0];
  const port = info.NetworkSettings.Ports['5432/tcp'][0].HostPort;
  console.log('Disposable PostgreSQL ready; isolated tmpfs, no business volumes, no Docker socket mount');
  const run = spawnSync(process.execPath, ['--import', 'tsx', live ? 'eval/live-browser-workflow.mts' : workflow ? 'eval/browser-workflow.mts' : 'eval/rc-browser.mts'], { cwd: resolve(import.meta.dirname, '..'), env: { ...process.env, WORKPIVOT_TEST_PG_DISPOSABLE: '1', WORKPIVOT_TEST_PG_URL: `postgresql://postgres:${password}@127.0.0.1:${port}/workpivot_test` }, stdio: 'inherit', timeout: live ? 3620000 : 920000 });
  if (run.error) throw Error('数据库测试未能完成');
  process.exitCode = run.status ?? 1;
} finally {
  try { if (started) {
    const info = JSON.parse(docker(['inspect', container]))[0];
    if (info.Config.Labels['workpivot.disposable'] !== 'postgres-test') throw Error('拒绝清理非本次测试容器');
    docker(['rm', '-f', container]);
    console.log('Disposable PostgreSQL container cleaned');
  } } finally { keeper?.kill(); }
}
