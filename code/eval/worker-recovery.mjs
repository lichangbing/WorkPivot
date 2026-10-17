// 在 Linux Docker 宿主运行，禁止将 Docker 套接字挂入容器。
import assert from 'node:assert/strict';
import { fork, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startWorker } from '../scripts/skill-worker.mjs';

if (process.platform !== 'linux') throw Error('Run this test in WSL/Linux on the Docker host');
if (process.argv[2] === '--child') {
  process.once('message', async options => {
    try {
      const worker = await startWorker({ ...options, host: '127.0.0.1', port: 0, timeoutMs: 60000 });
      process.send({ port: worker.server.address().port });
    } catch { process.send({ error: 'Test worker startup failed' }); process.disconnect(); process.exitCode = 1; }
  });
} else {
  const owner = 'wp-recovery-' + randomBytes(12).toString('hex');
  const stateDir = await mkdtemp(join(tmpdir(), owner + '-'));
  const token = randomBytes(32).toString('hex');
  const image = process.env.WORKPIVOT_TEST_IMAGE || 'workpivot-executor:0.2.0';
  const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const containers = () => docker(['ps', '-a', '--filter', `label=workpivot.worker=${owner}`, '--format', '{{.Names}}']).split('\n').filter(Boolean);
  const waitFor = async predicate => {
    for (let i = 0; i < 100; i++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 100)); }
    throw Error('Recovery condition not reached within 10 seconds');
  };
  let child, endpoint, checks = 0;
  const check = (value, message) => { assert.ok(value, message); checks++; console.log('PASS ' + message); };
  const killWorker = async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    }
  };
  const launch = async () => {
    child = fork(fileURLToPath(import.meta.url), ['--child'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const ready = once(child, 'message', { signal: AbortSignal.timeout(20000) });
    child.send({ token, owner, stateDir, image });
    const [message] = await ready; assert.ok(!message.error, message.error);
    endpoint = `http://127.0.0.1:${message.port}`;
  };
  const send = (command, signal = AbortSignal.timeout(20000)) => fetch(endpoint + '/v1/run', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ command, files: [], skills: [] }), signal,
  });
  const idle = async () => {
    const response = await fetch(endpoint + '/v1/health', { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000) });
    return (await response.json()).busy === 0;
  };
  const started = async () => {
    let sandbox;
    await waitFor(() => {
      const names = containers(); if (names.length !== 1) return false;
      try { docker(['exec', names[0], 'test', '-f', '/workspace/partial.txt']); sandbox = names[0]; return true; } catch { return false; }
    });
    return sandbox;
  };
  const clean = async () => { await waitFor(async () => await idle() && containers().length === 0 && (await readdir(stateDir)).length === 0); };
  try {
    await launch();
    const abort = new AbortController();
    const cancelled = send('echo partial > partial.txt; sleep 30', abort.signal).catch(() => null);
    await started(); abort.abort();
    check(await cancelled === null, 'client cancellation receives no partial output');
    await clean(); check(true, 'client cancellation removes sandbox, staging and busy slot');

    const interrupted = send('echo partial > partial.txt; sleep 30');
    const sandbox = await started();
    docker(['kill', '--signal', 'KILL', sandbox]);
    const response = await interrupted, body = await response.json();
    check(!response.ok && !body.files, 'sandbox crash returns failure without partial files');
    await clean(); check(true, 'sandbox crash releases worker resources');

    const disconnected = send('echo partial > partial.txt; sleep 30').catch(() => null);
    await started(); await killWorker();
    check(await disconnected === null, 'worker process death breaks request without returning files');
    check(containers().length === 1 && (await readdir(stateDir)).length === 1, 'test observes stranded sandbox and staging before restart');
    await launch(); await clean();
    check(true, 'same worker instance restart removes only its stranded resources');

    const retry = await send('echo completed > result.txt');
    const result = await retry.json();
    check(retry.ok && result.files?.length === 1 && result.files[0][0] === 'result.txt' && Buffer.from(result.files[0][1], 'base64').toString() === 'completed\n', 'explicit new request succeeds without previous partial output');
    await clean(); check(true, 'successful retry also leaves no sandbox or staging');
    console.log(`Worker recovery: ${checks}/${checks} passed`);
  } finally {
    await killWorker();
    for (const name of containers()) {
      if (!/^wp-skill-[a-f0-9-]{36}$/.test(name)) throw Error('Unexpected test container name');
      docker(['rm', '-f', name]);
    }
    // 仅清理上方 mkdtemp 返回的目录，不涉及已有执行器状态目录。
    await rm(stateDir, { recursive: true, force: true });
  }
}
