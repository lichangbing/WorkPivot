/**
 * RC 真模型门禁运行器。
 * 只使用一次性 PostgreSQL；模型凭据从本机受保护配置读取并只传给子进程。
 */
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const docker = args => {
  try {
    return execFileSync('docker', args, { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    throw Error('一次性 PostgreSQL 操作失败（凭据已隐藏）');
  }
};

async function modelKey() {
  if (process.env['DEEPSEEK_API_KEY']) return process.env['DEEPSEEK_API_KEY'];
  const config = await readFile(process.env['CODEX_CONFIG_FILE'] ?? resolve(homedir(), '.codex/config.toml'), 'utf8');
  const key = config.match(/experimental_bearer_token\s*=\s*"([^"]+)"/)?.[1];
  if (!key) throw Error('本机真实模型凭据不可用；请设置 DEEPSEEK_API_KEY');
  return key;
}

async function workerEnvironment() {
  const file = process.env['WORKPIVOT_LOCAL_STACK_ENV'] ?? resolve(homedir(), 'workpivot-v65-test/stack.env');
  const text = await readFile(file, 'utf8');
  const values = Object.fromEntries(text.split(/\r?\n/).filter(line => /^[A-Z0-9_]+=/.test(line)).map(line => {
    const index = line.indexOf('=');
    return [line.slice(0, index), line.slice(index + 1)];
  }));
  const token = values['WORKPIVOT_WORKER_TOKEN'];
  if (!token) throw Error('本机 Worker 凭据不可用');
  return {
    WORKPIVOT_WORKER_URL: values['WORKPIVOT_WORKER_URL'],
    WORKPIVOT_WORKER_TOKEN: token,
  };
}

const image = process.env['WORKPIVOT_TEST_PG_IMAGE'] ?? 'pgvector/pgvector:pg16';
const container = 'workpivot-rc-live-pg-' + Date.now();
const password = randomBytes(24).toString('hex');
let started = false;
try {
  docker(['image', 'inspect', image]);
  docker(['run', '-d', '--name', container, '--label', 'workpivot.disposable=rc-live-gate',
    '--tmpfs', '/var/lib/postgresql/data:rw,nosuid,size=768m', '-p', '127.0.0.1::5432',
    '-e', 'POSTGRES_PASSWORD=' + password, '-e', 'POSTGRES_DB=workpivot_test', image]);
  started = true;
  let ready = false;
  for (let index = 0; index < 40; index++) {
    try {
      docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'workpivot_test']);
      ready = true;
      break;
    } catch {
      await new Promise(done => setTimeout(done, 500));
    }
  }
  if (!ready) throw Error('一次性 PostgreSQL 启动超时');
  const info = JSON.parse(docker(['inspect', container]))[0];
  const port = info.NetworkSettings.Ports['5432/tcp'][0].HostPort;
  const child = spawn(process.execPath, ['--import', 'tsx', 'eval/rc-live-model-gate.mts'], {
    cwd: resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      ...await workerEnvironment(),
      DEEPSEEK_API_KEY: await modelKey(),
      WORKPIVOT_LIVE_EVAL: '1',
      WORKPIVOT_TEST_PG_DISPOSABLE: '1',
      WORKPIVOT_TEST_PG_URL: `postgresql://postgres:${password}@127.0.0.1:${port}/workpivot_test`,
      WORKPIVOT_OFFICE_STAGE: '1',
      WORKPIVOT_INTERACTION_CLARIFY_V2: '0',
      WORKPIVOT_INTERACTION_PLAN_APPROVAL: '0',
      WORKPIVOT_INTERACTION_PERMISSION_PREVIEW: '0',
      WORKPIVOT_INTERACTION_ARTIFACT_REVIEW: '0',
      WORKPIVOT_AGENT_MAX_STEPS: '120',
      WORKPIVOT_AGENT_MAX_DURATION_MINUTES: '60',
      WORKPIVOT_CONTEXT_CHARS: '200000',
    },
    stdio: 'inherit',
  });
  const status = await new Promise((resolveStatus, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolveStatus(code ?? 1));
  });
  process.exitCode = status;
} finally {
  if (started) {
    try {
      const info = JSON.parse(docker(['inspect', container]))[0];
      if (info.Config.Labels?.['workpivot.disposable'] !== 'rc-live-gate') throw Error('拒绝清理非本次测试容器');
      docker(['rm', '-f', container]);
      console.log('一次性 PostgreSQL 已清理');
    } catch {
      console.error('一次性 PostgreSQL 清理失败，请按容器标签人工检查');
    }
  }
}
