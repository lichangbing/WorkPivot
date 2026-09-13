import { startWorker } from '../scripts/skill-worker.mjs';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
const token = randomBytes(32).toString('hex');
const gateway = JSON.parse(execFileSync('docker', ['network', 'inspect', 'bridge'], { encoding: 'utf8' }))[0].IPAM.Config[0].Gateway;
const worker = await startWorker({ host: gateway, port: 39992, token, image: 'workpivot-executor:0.1.0', owner: 'workpivot-skill-worker-service-test' });
try {
  const code = await new Promise((resolve, reject) => {
    const child = spawn('docker', ['run', '--rm', '--network', 'bridge', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--tmpfs', '/tmp:rw,size=128m', '--tmpfs', '/data/workpivot:rw,uid=1000,gid=1000', '--tmpfs', '/data/workspace:rw,uid=1000,gid=1000', '-e', 'NODE_ENV=test', '-e', 'WORKPIVOT_HOST=127.0.0.1', '-e', `WORKPIVOT_WORKER_URL=http://${gateway}:39992`, '-e', `WORKPIVOT_WORKER_TOKEN=${token}`, '--entrypoint', './node_modules/.bin/tsx', 'workpivot-server:0.3.0-preview.7', 'eval/W23-skill-service.mts'], { stdio: 'inherit' }); child.on('error', reject); child.on('exit', resolve);
  });
  if (code !== 0) process.exitCode = 1;
} finally { await worker.close(); }
