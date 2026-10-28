import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const docker = args => {
  try {
    return execFileSync('docker', args, { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    throw Error('PostgreSQL 测试容器操作失败（凭据已隐藏）');
  }
};
const image = process.env.WORKPIVOT_TEST_PG_IMAGE || 'pgvector/pgvector:pg16';
const container = 'workpivot-limits-test-' + Date.now();
const password = randomBytes(24).toString('hex');
let started = false;
try {
  docker(['image', 'inspect', image]);
  docker(['run', '-d', '--name', container, '--label', 'workpivot.disposable=postgres-test', '--tmpfs', '/var/lib/postgresql/data:rw,nosuid,size=512m', '-p', '127.0.0.1::5432', '-e', 'POSTGRES_PASSWORD=' + password, '-e', 'POSTGRES_DB=workpivot_limits', image]);
  started = true;
  let ready = false;
  for (let index = 0; index < 40; index++) {
    try {
      docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'workpivot_limits']);
      ready = true;
      break;
    } catch {
      await new Promise(done => setTimeout(done, 500));
    }
  }
  if (!ready) throw Error('测试数据库启动超时');
  const info = JSON.parse(docker(['inspect', container]))[0];
  const port = info.NetworkSettings.Ports['5432/tcp'][0].HostPort;
  const run = spawnSync(process.execPath, ['--import', 'tsx', 'eval/database-limits.mts'], {
    cwd: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
    env: {
      ...process.env,
      WORKPIVOT_TEST_PG_DISPOSABLE: '1',
      WORKPIVOT_TEST_PG_URL: `postgresql://postgres:${password}@127.0.0.1:${port}/workpivot_limits`,
    },
    stdio: 'inherit',
    timeout: 180000,
  });
  if (run.error) throw Error('限额数据库测试未能完成');
  process.exitCode = run.status ?? 1;
} finally {
  try {
    if (started) {
      const info = JSON.parse(docker(['inspect', container]))[0];
      if (info.Config.Labels['workpivot.disposable'] !== 'postgres-test') throw Error('拒绝清理非本次测试容器');
      docker(['rm', '-f', container]);
    }
  } finally {
    // 仅清理本次临时容器。
  }
}
