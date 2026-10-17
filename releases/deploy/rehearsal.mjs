// Linux 合成部署演练，不向任何容器传入 Docker 套接字。
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { backup, restore } from './snapshot.mjs';
const image = process.env.WORKPIVOT_IMAGE ?? 'workpivot-server:0.3.0-dev';
const prefix = `wp-rehearsal-${randomBytes(6).toString('hex')}`;
const root = mkdtempSync(join(tmpdir(), prefix));
const containers = [], volumes = [];
const key = randomBytes(32).toString('hex'), init = randomBytes(32).toString('hex');
const docker = (args, input) => execFileSync('docker', args, { input, encoding: 'utf8', timeout: 120000, maxBuffer: 2 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const results = [];
function assert(name, pass) { results.push({ name, pass }); console.log(`${pass ? '✅' : '❌'} ${name}`); if (!pass) throw Error(name); }
function newVolume(suffix) { const name = `${prefix}-${suffix}`; docker(['volume', 'create', name]); volumes.push(name); return name; }
function start(name, home, workspace, secret = key, imageId = image) {
  containers.push(name);
  docker(['run', '-d', '--name', name, '--init', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m',
    '--mount', `type=volume,src=${home},dst=/data/workpivot`, '--mount', `type=volume,src=${workspace},dst=/data/workspace`,
    '-e', `WORKPIVOT_SECRET_KEY=${secret}`, '-e', `WORKPIVOT_ADMIN_INIT_TOKEN=${init}`, imageId]);
}
function request(container, path, body, token) {
  const source = `let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',async()=>{const p=JSON.parse(input);try{const r=await fetch('http://127.0.0.1:39800'+p.path,{method:p.body===undefined?'GET':'POST',headers:{'content-type':'application/json',authorization:'Bearer '+(p.token||'')},body:p.body===undefined?undefined:JSON.stringify(p.body),signal:AbortSignal.timeout(4000)});console.log(JSON.stringify({status:r.status,data:await r.json()}));}catch(e){console.log(JSON.stringify({status:0,error:e.message}));}});`;
  return JSON.parse(docker(['exec', '-i', container, 'node', '-e', source], JSON.stringify({ path, body, token })));
}
async function healthy(name) {
  for (let i = 0; i < 40; i++) { try { if (request(name, '/api/health').status === 200) return; } catch { /* booting */ } await new Promise((r) => setTimeout(r, 250)); }
  throw Error(`Service did not start: ${name}`);
}
try {
  const home = newVolume('home'), workspace = newVolume('workspace');
  const service = `${prefix}-service`; start(service, home, workspace); await healthy(service);
  const config = JSON.parse(docker(['inspect', service]))[0];
  assert('RL3 Linux 非 root、只读根、禁止提权部署', config.Config.User === 'node' && config.HostConfig.ReadonlyRootfs && config.HostConfig.SecurityOpt.includes('no-new-privileges:true'));
  assert('RL3 默认部署没有 Docker socket 挂载', !config.Mounts.some((m) => m.Destination === '/var/run/docker.sock'));
  const web = JSON.parse(docker(['exec', service, 'node', '-e', "Promise.all(['/','/admin'].map(async p=>{const r=await fetch('http://127.0.0.1:39800'+p);return r.status===200&&(await r.text()).includes('<!doctype html>')})).then(v=>console.log(JSON.stringify(v)))"]));
  assert('RL3 用户端和管理端网页均可访问', web.every(Boolean));
  const registration = request(service, '/api/auth/register', { username: 'restore-admin', password: 'synthetic-test-password', initToken: init });
  assert('RL3 初始化凭据注册成功', registration.status === 200);
  const token = registration.data.token;
  const project = request(service, '/api/projects', { name: 'restore-project' }, token).data.project;
  assert('RL3 项目持久化可用', Boolean(project?.id));
  const provider = request(service, '/api/providers', { name: 'restore-provider', modelId: 'mock', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'synthetic-provider-secret', verify: false }, token);
  assert('RL3 供应商密钥保存成功', provider.status === 200);
  const trashCheck = docker(['exec', service, './node_modules/.bin/tsx', '-e', "const fs=require('fs');const {moveToTrash}=require('./packages/server/src/trash.ts');fs.writeFileSync('/data/workspace/trash-test.txt','recoverable');const moved=moveToTrash('/data/workspace/trash-test.txt','deployment-test');process.stdout.write(String(moved.ok&&!fs.existsSync('/data/workspace/trash-test.txt')&&fs.readFileSync(moved.trashPath+'/payload','utf8')==='recoverable'))"]);
  assert('RL3 跨数据卷删除完整保留回收副本', trashCheck === 'true');
  docker(['exec', service, 'node', '-e', "require('fs').writeFileSync('/data/workspace/restored.txt','snapshot-original')"]);
  const snapshot = join(root, 'snapshot'); const manifest = await backup(service, snapshot); await healthy(service);
  assert('RL3 停机一致性备份后服务恢复', request(service, '/api/auth/state', undefined, token).data.authenticated === true);
  docker(['exec', service, 'node', '-e', "require('fs').writeFileSync('/data/workspace/restored.txt','post-upgrade-change')"]);
  const restoredHome = `${prefix}-restored-home`, restoredWorkspace = `${prefix}-restored-workspace`;
  volumes.push(restoredHome, restoredWorkspace);
  await restore(snapshot, restoredHome, restoredWorkspace);
  const restored = `${prefix}-restored`; start(restored, restoredHome, restoredWorkspace, key, manifest.imageId); await healthy(restored);
  assert('RL3 恢复后历史会话失效', request(restored, '/api/auth/state', undefined, token).data.authenticated === false);
  const login = request(restored, '/api/auth/login', { username: 'restore-admin', password: 'synthetic-test-password' });
  assert('RL3 恢复后原账户可以重新登录', login.status === 200);
  assert('RL3 恢复项目和原供应商配置', JSON.stringify(request(restored, '/api/projects', undefined, login.data.token).data).includes(project.id) && JSON.stringify(request(restored, '/api/providers', undefined, login.data.token).data).includes('restore-provider'));
  const content = docker(['exec', restored, 'node', '-e', "process.stdout.write(require('fs').readFileSync('/data/workspace/restored.txt','utf8'))"]);
  assert('RL3 回滚使用快照镜像及升级前文件', content === 'snapshot-original' && JSON.parse(docker(['inspect', restored]))[0].Image === manifest.imageId);
  const original = docker(['exec', service, 'node', '-e', "process.stdout.write(require('fs').readFileSync('/data/workspace/restored.txt','utf8'))"]);
  assert('RL3 恢复不覆盖原卷', original === 'post-upgrade-change');
  let refused = false; try { await restore(snapshot, home, workspace); } catch { refused = true; }
  assert('RL3 恢复拒绝已存在目标卷', refused);
  const manifestFile = join(snapshot, 'manifest.json'); const old = readFileSync(manifestFile, 'utf8');
  const changed = JSON.parse(old); changed.sha256['home.tar'] = 'invalid'; writeFileSync(manifestFile, JSON.stringify(changed));
  refused = false; try { await restore(snapshot, `${prefix}-bad-home`, `${prefix}-bad-workspace`); } catch { refused = true; } writeFileSync(manifestFile, old);
  assert('RL3 损坏备份校验失败且不启动恢复', refused);
  docker(['stop', '--time', '10', restored]);
  assert('RL4 Linux 优雅停止退出码为0', JSON.parse(docker(['inspect', restored]))[0].State.ExitCode === 0);
  const wrong = `${prefix}-wrong-key`; start(wrong, restoredHome, restoredWorkspace, randomBytes(32).toString('hex'));
  for (let i = 0; i < 40; i++) { if (!JSON.parse(docker(['inspect', wrong]))[0].State.Running) break; await new Promise((r) => setTimeout(r, 100)); }
  assert('RL3 错误主密钥拒绝启动', JSON.parse(docker(['inspect', wrong]))[0].State.ExitCode !== 0);
} catch (error) { console.error(error.message); if (!results.some((r) => !r.pass)) results.push({ name: '部署彩排无异常', pass: false }); }
finally {
  for (const name of containers.reverse()) { try { docker(['rm', '-f', '-v', name]); } catch { /* only this run's fixtures */ } }
  for (const name of volumes) { try { docker(['volume', 'rm', name]); } catch { /* missing or retained for investigation */ } }
  // root 是 mkdtemp 创建的唯一测试目录，不删除宿主已有目录。
  rmSync(root, { recursive: true, force: true });
}
const report = { date: new Date().toISOString(), results, overall: results.every((r) => r.pass) ? 'pass' : 'fail' };
if (process.env.WORKPIVOT_REHEARSAL_REPORT) writeFileSync(process.env.WORKPIVOT_REHEARSAL_REPORT, JSON.stringify(report, null, 2));
console.log(`Deployment: ${results.filter((r) => r.pass).length}/${results.length}`);
process.exitCode = report.overall === 'pass' ? 0 : 1;
