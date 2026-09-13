// Run on the designated Linux Docker host, as the existing WorkPivot deployment user.
// Input directory must contain skill-worker.mjs, workpivot-worker.service, compose.worker.yml, snapshot.mjs.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
const run = (name, args) => execFileSync(name, args, { encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const source = resolve(process.argv[2] ?? '.'), deployment = resolve(process.argv[3] ?? join(homedir(), 'workpivot'));
const target = join(homedir(), 'workpivot-worker'), tokenPath = join(target, 'worker.env');
for (const file of ['skill-worker.mjs', 'workpivot-worker.service', 'compose.worker.yml', 'snapshot.mjs']) if (!existsSync(join(source, file))) throw Error(`Missing deployment input: ${file}`);
run('docker', ['image', 'inspect', 'workpivot-server:0.3.0-preview.7']); run('docker', ['image', 'inspect', 'workpivot-executor:0.1.0']);
if (run('loginctl', ['show-user', userInfo().username, '-p', 'Linger', '--value']) !== 'yes') throw Error('Enable linger for the deployment user before installation');
run('systemctl', ['--user', 'show-environment']);
const gateway = JSON.parse(run('docker', ['network', 'inspect', 'bridge']))[0].IPAM.Config[0].Gateway;
if (!/^\d+\.\d+\.\d+\.\d+$/.test(gateway)) throw Error('Unsupported Docker bridge address');
const composePath = join(deployment, 'compose.lan.yml'), envPath = join(deployment, '.env');
const oldCompose = readFileSync(composePath, 'utf8'), oldEnv = readFileSync(envPath, 'utf8');
if (!/image: workpivot-server:[a-zA-Z0-9.-]+/.test(oldCompose)) throw Error('Unexpected Compose image');
const existing = existsSync(tokenPath) ? readFileSync(tokenPath, 'utf8').match(/^WORKPIVOT_WORKER_TOKEN=([a-f0-9]{64})$/m)?.[1] : undefined;
const backendToken = oldEnv.match(/^WORKPIVOT_WORKER_TOKEN=(.+)$/m)?.[1];
if (backendToken && backendToken !== existing) throw Error('Existing worker token differs; refusing to replace credentials');
const token = existing ?? randomBytes(32).toString('hex');
run('docker', ['exec', 'workpivot-server', 'node', '-e', 'const fs=require("fs");const root="/data/workpivot/data/tasks";if(fs.readdirSync(root).some(x=>{const p=root+"/"+x+"/task.json";return fs.existsSync(p)&&JSON.parse(fs.readFileSync(p,"utf8")).status==="running"}))process.exit(1)']);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
run('node', [join(source, 'snapshot.mjs'), 'backup', 'workpivot-server', join(homedir(), 'workpivot-backups', `pre-worker-${stamp}`)]);
copyFileSync(composePath, join(deployment, `compose.pre-worker-${stamp}.yml`));
mkdirSync(target, { recursive: true, mode: 0o700 }); copyFileSync(join(source, 'skill-worker.mjs'), join(target, 'skill-worker.mjs'));
writeFileSync(tokenPath, `WORKPIVOT_WORKER_BIND=${gateway}\nWORKPIVOT_WORKER_PORT=39990\nWORKPIVOT_WORKER_TOKEN=${token}\nWORKPIVOT_WORKER_IMAGE=workpivot-executor:0.1.0\n`, { mode: 0o600 });
const units = join(homedir(), '.config/systemd/user'); mkdirSync(units, { recursive: true }); copyFileSync(join(source, 'workpivot-worker.service'), join(units, 'workpivot-worker.service'));
run('systemctl', ['--user', 'daemon-reload']); run('systemctl', ['--user', 'enable', '--now', 'workpivot-worker']); run('systemctl', ['--user', 'restart', 'workpivot-worker']);
let ready = false;
for (let attempt = 0; attempt < 20; attempt++) { try { const response = await fetch(`http://${gateway}:39990/v1/health`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2000) }); ready = response.ok && (await response.json()).protocol === 1; } catch {} if (ready) break; await new Promise((resolve) => setTimeout(resolve, 500)); }
if (!ready) throw Error('Worker health check failed; backend configuration has not been changed');
copyFileSync(join(source, 'compose.worker.yml'), join(deployment, 'compose.worker.yml'));
if (!backendToken) writeFileSync(envPath, `${oldEnv.trimEnd()}\nWORKPIVOT_WORKER_TOKEN=${token}\n`, { mode: 0o600 });
writeFileSync(composePath, oldCompose.replace(/image: workpivot-server:[a-zA-Z0-9.-]+/, 'image: workpivot-server:0.3.0-preview.7'));
try { run('docker', ['compose', '-p', 'workpivot', '-f', composePath, '-f', join(deployment, 'compose.worker.yml'), '--env-file', envPath, 'up', '-d']); }
catch { writeFileSync(composePath, oldCompose); run('docker', ['compose', '-p', 'workpivot', '-f', composePath, '--env-file', envPath, 'up', '-d']); throw Error('Backend upgrade failed; restored prior Compose configuration'); }
console.log('Worker and backend started; verify backend health and a real Skill task before accepting deployment.');
