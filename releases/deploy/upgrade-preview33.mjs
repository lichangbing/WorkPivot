import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { backup } from './snapshot.mjs';
const mode = process.argv[2];
const redeploy = process.argv.includes('--redeploy');
if (!['local', 'lan'].includes(mode)) throw Error('Usage: node upgrade-preview33.mjs local|lan');
const local = mode === 'local';
const container = local ? 'workpivot-local-server' : 'workpivot-server';
const directory = join(homedir(), local ? 'workpivot-local' : 'workpivot');
const config = join(directory, local ? 'compose.yml' : 'compose.lan.yml');
const run = (args, input) => execFileSync('docker', args, { input, encoding: 'utf8', timeout: 300000, maxBuffer: 1024 * 1024 });
const original = readFileSync(config, 'utf8');
if (!original.includes(redeploy ? 'workpivot-server:0.3.0-preview.33' : 'workpivot-server:0.3.0-preview.32')) throw Error('Unexpected deployed version; unchanged');
run(['image', 'inspect', 'workpivot-server:0.3.0-preview.33']);
const active = run(['exec', '-i', '-w', '/app', container, './node_modules/.bin/tsx', '--input-type=module'], `
import {listTenants,withTenant,withAccount} from './packages/server/src/tenants.ts';
import {listUsers} from './packages/server/src/auth.ts';
import {listTasks} from './packages/server/src/tasks.ts';
let count=0; for(const t of listTenants()) withTenant(t.id,()=>{for(const u of listUsers()) withAccount(u,()=>{count+=listTasks().filter(t=>['running','waiting','queued'].includes(t.status)).length;});});
console.log(count);
`).trim();
if (active !== '0') throw Error('Active tasks found; deployment unchanged');
const stamp = Date.now();
const backupPath = join(homedir(), 'workpivot-backups', 'pre-preview33-' + stamp);
await backup(container, backupPath);
copyFileSync(config, config + '.pre-preview33-' + stamp);
const compose = ['compose', '-p', local ? 'workpivot-local' : 'workpivot', '--env-file', join(directory, '.env'), '-f', config, ...(!local ? ['-f', join(directory, 'compose.worker.yml')] : [])];
try {
  writeFileSync(config, original.replace('workpivot-server:0.3.0-preview.32', 'workpivot-server:0.3.0-preview.33'));
  run([...compose, 'config', '--quiet']);
  run([...compose, 'up', '-d', ...(redeploy ? ['--force-recreate'] : []), '--wait', '--wait-timeout', '60']);
  const response = await fetch(`http://127.0.0.1:${local ? 39880 : 39800}/api/health`, { signal: AbortSignal.timeout(10000) });
  const health = await response.json();
  if (!response.ok || !health.ok || health.version !== '0.3.0-preview.33') throw Error('Health check failed');
  console.log('preview.33 healthy; backup=' + backupPath);
} catch(error) {
  writeFileSync(config, original);
  run([...compose, 'up', '-d', '--wait', '--wait-timeout', '60']);
  throw error;
}
