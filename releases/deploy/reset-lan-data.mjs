// 破坏性运维命令，仅适用于指定名称的 WorkPivot 局域网部署。
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, existsSync, realpathSync, rmSync, lstatSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
if (process.argv[2] !== '--erase-all-workpivot-data') throw Error('Explicit erase flag required');
const directory = '/home/lichb/workpivot';
if (realpathSync(directory) !== directory) throw Error('Deployment path must not be a symlink');
const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 300000, maxBuffer: 1024 * 1024 });
const info = JSON.parse(docker(['inspect', 'workpivot-server']))[0];
if (info.Config.Labels['com.docker.compose.project'] !== 'workpivot') throw Error('Wrong deployment');
for (const [name, destination] of [['workpivot_workpivot-data', '/data/workpivot'], ['workpivot_workpivot-workspace', '/data/workspace']]) {
  if (!info.Mounts.some(m => m.Type === 'volume' && m.Name === name && m.Destination === destination)) throw Error('Unexpected volume layout');
}
const caches = ['/home/lichb/workpivot-backups', '/tmp/workpivot-skill-worker-v1'];
for (const path of caches) if (existsSync(path) && (lstatSync(path).isSymbolicLink() || realpathSync(path) !== path)) throw Error('Unexpected cleanup path');
const config = join(directory, 'compose.lan.yml');
let composeText = readFileSync(config, 'utf8');
if (!composeText.includes('/app/packages/server/skills:ro,size=1m')) {
  if (!composeText.includes('      - /tmp:rw,nosuid,nodev,size=256m')) throw Error('Unexpected Compose layout');
  composeText = composeText.replace('      - /tmp:rw,nosuid,nodev,size=256m', '      - /tmp:rw,nosuid,nodev,size=256m\n      - /app/packages/server/skills:ro,size=1m');
}
execFileSync('systemctl', ['--user', 'stop', 'workpivot-worker']);
docker(['stop', '--time', '30', 'workpivot-server']);
const sandboxes = docker(['ps', '-aq', '--filter', 'label=workpivot.worker=workpivot-skill-worker-v1']).trim().split(/\s+/).filter(Boolean);
if (sandboxes.length) docker(['rm', '-f', ...sandboxes]);
docker(['rm', 'workpivot-server']);
docker(['run', '--rm', '--network', 'none', '--read-only', '--user', '0',
  '--mount', 'type=volume,src=workpivot_workpivot-data,dst=/reset-home',
  '--mount', 'type=volume,src=workpivot_workpivot-workspace,dst=/reset-workspace',
  '--entrypoint', 'node', info.Image, '-e',
  "const fs=require('fs'); for(const root of ['/reset-home','/reset-workspace']) { for(const name of fs.readdirSync(root)) fs.rmSync(root+'/'+name,{recursive:true,force:true}); fs.chownSync(root,1000,1000); if(fs.readdirSync(root).length) throw Error('Volume not empty'); } console.log('Both business volumes emptied');"]);
for (const path of caches) rmSync(path, { recursive: true, force: true });
for (const name of readdirSync(directory)) if (name.startsWith('.env.pre-')) rmSync(join(directory, name));
const token = randomBytes(32).toString('hex');
let env = readFileSync(join(directory, '.env'), 'utf8');
for (const [key, value] of [['WORKPIVOT_SECRET_KEY', randomBytes(32).toString('hex')], ['WORKPIVOT_ADMIN_INIT_TOKEN', token]]) {
  if (!new RegExp(`^${key}=`, 'm').test(env)) throw Error('Missing environment key');
  env = env.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`);
}
writeFileSync(join(directory, '.env'), env, { mode: 0o600 });
writeFileSync(config, composeText);
writeFileSync(join(directory, 'first-login.txt'), `WorkPivot 已清空，需重新注册管理员\n地址：https://workpivot.lichb.cc.cd/\n初始化凭据：${token}\n此凭据仅用于首次注册，不是登录密码。\n`, { mode: 0o600 });
execFileSync('systemctl', ['--user', 'start', 'workpivot-worker']);
docker(['compose', '-p', 'workpivot', '--env-file', join(directory, '.env'), '-f', config, '-f', join(directory, 'compose.worker.yml'), 'up', '-d', '--wait', '--wait-timeout', '60']);
console.log('Reset complete; new initialization credential saved in /home/lichb/workpivot/first-login.txt');
