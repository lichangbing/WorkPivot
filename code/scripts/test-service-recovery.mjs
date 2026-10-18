import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const soakSeconds=Number(process.env.WORKPIVOT_TEST_SOAK_SECONDS??0);
if(!Number.isSafeInteger(soakSeconds)||soakSeconds<0||soakSeconds>86400)throw Error('稳定性持续时间须为0至86400秒');
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
// 长时间验收收到停止信号后走finally，回收本轮容器和内部网络。
const shutdown=new AbortController();
const stop=()=>shutdown.abort();
process.once('SIGINT',stop);process.once('SIGTERM',stop);
const wait=ms=>delay(ms,undefined,{signal:shutdown.signal});
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
  // 发布镜像可能不带 eval 目录；复制当前夹具目录，避免依赖历史镜像内的测试文件。
  docker(['cp', linuxPath(resolve(code, 'eval')), `${server}:/app/`]);
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
  if(soakSeconds){
    const samples=[],started=Date.now();
    do{
      shutdown.signal.throwIfAborted();
      const output=probe('soak');
      if(!output.includes('17 checks passed'))throw Error('稳定性探针未完成全部检查');
      const stats=JSON.parse(docker(['stats','--no-stream','--format','{{json .}}',server]));
      const memory=stats.MemUsage.split('/')[0].trim(),match=/^([0-9.]+)([KMGT]?i?B)$/.exec(memory);
      const factors={B:1,KB:1000,MB:1000000,GB:1000000000,KiB:1024,MiB:1048576,GiB:1073741824};
      if(!match||!factors[match[2]])throw Error('无法解析容器内存样本');
      samples.push({elapsedSeconds:Math.round((Date.now()-started)/1000),memoryBytes:Number(match[1])*factors[match[2]],pids:Number(stats.PIDs)});
      if(samples.length===1||samples.length%6===0)console.log(JSON.stringify({phase:'短时稳定性基线',...samples.at(-1),rounds:samples.length}));
      if(Date.now()-started<soakSeconds*1000)await wait(Math.min(5000,soakSeconds*1000-(Date.now()-started)));
    }while(Date.now()-started<soakSeconds*1000);
    shutdown.signal.throwIfAborted();
    const baseline=samples[Math.min(2,samples.length-1)],steady=samples.slice(Math.min(2,samples.length-1));
    const checks={memoryBounded:steady.every(s=>Number.isFinite(s.memoryBytes)&&s.memoryBytes-baseline.memoryBytes<=128*1024*1024),pidsBounded:steady.every(s=>Number.isSafeInteger(s.pids)&&s.pids-baseline.pids<=8)};
    const report={startedAt:new Date(started).toISOString(),durationSeconds:Math.round((Date.now()-started)/1000),requestedSeconds:soakSeconds,rounds:samples.length,checksPerRound:17,checks,samples,scope:'隔离受控运行时、文件幂等和SSE重连；不含真实模型、浏览器、Worker或全天业务负载'};
    if(process.env.WORKPIVOT_TEST_SOAK_REPORT)await writeFile(resolve(process.env.WORKPIVOT_TEST_SOAK_REPORT),JSON.stringify(report,null,2),{flag:'wx',mode:0o600});
    if(Object.values(checks).some(ok=>!ok))throw Error('稳定性资源增长超过基线阈值');
    console.log(JSON.stringify({...report,samples:undefined}));
  }

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
  } finally { keeper?.kill();process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop); }
}
