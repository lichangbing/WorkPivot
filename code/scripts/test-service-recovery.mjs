import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

const windows = process.platform === 'win32';
const prefix = `workpivot-recovery-test-${Date.now()}`;
const database = prefix + '-db', server = prefix + '-api';
const mcp = prefix + '-mcp';
const image = process.env.WORKPIVOT_TEST_SERVICE_IMAGE || 'workpivot-server:0.3.0-rc.1-recovery-validation-20260929';
const pgImage = process.env.WORKPIVOT_TEST_PG_IMAGE || 'pgvector/pgvector:pg15';
const docker = args => {
  try {
    return execFileSync(windows ? 'wsl' : 'docker', windows ? ['-d', 'Ubuntu-24.04', '--', 'docker', ...args] : args,
      { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch { throw Error('Disposable recovery container operation failed; credentials withheld'); }
};
const linuxPath = path => windows ? execFileSync('wsl', ['-d', 'Ubuntu-24.04', '--', 'wslpath', '-a', path.replaceAll('\\', '/')], { encoding: 'utf8', timeout: 30000 }).trim() : path;
const code = resolve(import.meta.dirname, '..');
let keeper, networkCreated = false, dbCreated = false, apiCreated = false, mcpCreated = false;
const wait = ms => new Promise(r => setTimeout(r, ms));
try {
  if (windows) {
    keeper = spawn('wsl', ['-d', 'Ubuntu-24.04', '--', 'sleep', 'infinity'], { windowsHide: true, stdio: 'ignore' });
    await once(keeper, 'spawn');
  }
  docker(['image', 'inspect', image]); docker(['image', 'inspect', pgImage]);
  docker(['network', 'create', '--internal', '--label', 'workpivot.disposable=service-recovery', prefix]); networkCreated = true;
  const password = randomBytes(24).toString('hex');
  docker(['run', '-d', '--name', database, '--network', prefix, '--label', 'workpivot.disposable=service-recovery',
    '--tmpfs', '/var/lib/postgresql/data:rw,nosuid,size=512m', '-e', 'POSTGRES_PASSWORD=' + password, '-e', 'POSTGRES_DB=recovery', pgImage]); dbCreated = true;
  let ready = false;
  for (let i = 0; i < 30; i++) {
    try { docker(['exec', database, 'pg_isready', '-U', 'postgres', '-d', 'recovery']); ready = true; break; } catch { await wait(500); }
  }
  if (!ready) throw Error('Disposable database readiness timeout');
  docker(['create', '--name', mcp, '--network', prefix, '--label', 'workpivot.disposable=service-recovery', '--user', 'node',
    '-e', 'WORKPIVOT_SERVICE_RECOVERY_FIXTURE=1', image, 'node', '/tmp/recovery-mcp-service.mjs']); mcpCreated = true;
  docker(['cp', linuxPath(resolve(code, 'eval/recovery-mcp-service.mjs')), `${mcp}:/tmp/recovery-mcp-service.mjs`]);
  docker(['start', mcp]);
  const url = user => `postgresql://${user}:${password}@${database}:5432/recovery`;
  docker(['create', '--name', server, '--network', prefix, '--label', 'workpivot.disposable=service-recovery', '--user', 'root',
    '-e', 'WORKPIVOT_SERVICE_RECOVERY_FIXTURE=1', '-e', 'WORKPIVOT_DATABASE_ADMIN_URL=' + url('postgres'),
    '-e', 'WORKPIVOT_RECOVERY_MCP_URL=http://' + mcp + ':39801',
    '-e', 'WORKPIVOT_DATABASE_URL=' + url('wp_recovery_app'), '-e', 'WORKPIVOT_AUTH_DATABASE_URL=' + url('wp_recovery_auth'),
    image, './node_modules/.bin/tsx', 'eval/wsl-service-recovery.mts', 'serve']); apiCreated = true;
  // 用已有依赖镜像验证当前检出源码，不操作已部署服务。
  for (const folder of ['server', 'core', 'shared']) docker(['cp', linuxPath(resolve(code, `packages/${folder}/src/.`)) + '/.', `${server}:/app/packages/${folder}/src/`]);
  docker(['cp', linuxPath(resolve(code, 'eval/wsl-service-recovery.mts')), `${server}:/app/eval/wsl-service-recovery.mts`]);
  docker(['start', server]);
  const probe = phase => docker(['exec', server, './node_modules/.bin/tsx', 'eval/wsl-service-recovery.mts', phase]);
  let live = false;
  for (let i = 0; i < 30; i++) { try { console.log(probe('before')); live = true; break; } catch { await wait(500); } }
  if (!live) throw Error('Full runtime failed initial readiness/confirmation check');
  docker(['kill', '--signal', 'KILL', server]);
  if (JSON.parse(docker(['inspect', server]))[0].State.Running) throw Error('Server did not stop');
  console.log('Entire API container killed; waiting for real 30-second lease expiry');
  await wait(31000);
  docker(['start', server]);
  let recovered = false;
  for (let i = 0; i < 25; i++) { try { console.log(probe('after')); recovered = true; break; } catch { await wait(1000); } }
  if (!recovered) throw Error('Full runtime did not pass recovery checks');
  docker(['restart', '--time', '1', server]);
  await wait(2000);
  console.log(probe('after'));
  console.log('PASS second full restart preserves single recovery event; no Docker socket mounted');
} finally {
  // 只清理本次调用创建且名称唯一的资源。
  try {
    for (const [created, name] of [[apiCreated, server], [mcpCreated, mcp], [dbCreated, database]]) {
      if (created) {
        const info = JSON.parse(docker(['inspect', name]))[0];
        if (info.Config.Labels?.['workpivot.disposable'] !== 'service-recovery') throw Error('Refusing to clean non-test container');
        docker(['rm', '-f', name]);
      }
    }
    if (networkCreated) docker(['network', 'rm', prefix]);
  } finally { keeper?.kill(); }
}
