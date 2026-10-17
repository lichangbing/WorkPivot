// Linux Docker 宿主联调；不挂载套接字，测试产物留在临时执行器中。
import { startWorker, validateFiles } from '../scripts/skill-worker.mjs';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const results = [];
const assert = (name, pass) => { results.push(pass); console.log(`${pass ? '✅' : '❌'} ${name}`); };
const rejectFiles = (files) => { try { validateFiles(files); return false; } catch { return true; } };
assert('Worker拒绝输入路径穿越', rejectFiles([['../escape', '']]));
assert('Worker拒绝绝对路径', rejectFiles([['/root/file', '']]));
assert('Worker拒绝重复路径', rejectFiles([['a', ''], ['a', '']]));
assert('Worker拒绝无效编码', rejectFiles([['a', '%%%']]));
const token = randomBytes(32).toString('hex');
const worker = await startWorker({ token, image: process.env.WORKPIVOT_TEST_IMAGE ?? 'workpivot-executor:0.1.0', port: 39991, timeoutMs: 6000, owner: 'workpivot-skill-worker-test' });
const endpoint = 'http://127.0.0.1:39991';
const encode = (text) => Buffer.from(text).toString('base64');
const send = (body, signal) => fetch(endpoint + '/v1/run', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
try {
  assert('Worker未认证请求拒绝', (await fetch(endpoint + '/v1/health')).status === 401);
  assert('Worker拒绝任意Docker参数', (await send({ command: 'true', files: [], skills: [], image: 'other' })).status === 400);
  const script = "const fs=require('fs');if(process.getuid()===0)throw Error('root');if(fs.existsSync('/var/run/docker.sock'))throw Error('socket');if(process.env.WORKPIVOT_WORKER_TOKEN)throw Error('secret');const a=fs.readFileSync('/skills/test/template.bin');fs.writeFileSync('result.bin',a);console.log(require('adm-zip')?'DEPENDENCY_OK':'bad');";
  const success = await send({ command: 'node /skills/test/run.cjs', files: [['input.txt', encode('input')]], skills: [['test/run.cjs', encode(script)], ['test/template.bin', Buffer.from([0, 1, 255]).toString('base64')]] });
  const data = await success.json();
  assert('Worker运行Skill脚本与预装依赖', success.ok && data.output.includes('DEPENDENCY_OK'));
  assert('Worker支持二进制模板及产物', data.files?.some(([name, content]) => name === 'result.bin' && content === 'AAH/'));
  const readOnly = await send({ command: 'echo changed > /skills/test/template.txt', files: [], skills: [['test/template.txt', encode('original')]] });
  assert('Worker技能资源只读', !readOnly.ok);
  const failure = await send({ command: 'echo partial > partial.txt; exit 1', files: [], skills: [] });
  assert('Worker失败不返回待回写文件', !failure.ok && !(await failure.json()).files);
  const link = await send({ command: 'ln -s /etc/passwd leaked', files: [], skills: [] });
  assert('Worker拒绝链接产物', !link.ok);
  const network = await send({ command: "node -e \"const os=require('os'); if(Object.keys(os.networkInterfaces()).some(x=>x!=='lo'))process.exit(1)\"", files: [], skills: [] });
  assert('Worker没有外部网络接口', network.ok);
  const python = await send({ command: 'python3 -c "print(6 * 7)"', files: [], skills: [] });
  assert('Worker支持Python脚本', python.ok && (await python.json()).output.includes('42'));
  const timed = await send({ command: 'sleep 30', files: [], skills: [] });
  assert('Worker超时终止且不返回产物', !timed.ok && (await timed.json()).error.includes('超时'));
  const controller = new AbortController();
  const pending = send({ command: 'sleep 30', files: [], skills: [] }, controller.signal).catch(() => null);
  await new Promise((resolve) => setTimeout(resolve, 800)); controller.abort(); await pending;
  let empty = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    const info = await (await fetch(endpoint + '/v1/health', { headers: { authorization: `Bearer ${token}` } })).json();
    if (info.busy === 0) { empty = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert('Worker断线回收执行槽', empty);
  const remaining = execFileSync('docker', ['ps', '-a', '--filter', 'label=workpivot.worker=workpivot-skill-worker-test', '--format', '{{.Names}}'], { encoding: 'utf8' }).trim();
  assert('Worker无残留隔离容器', remaining === '');
} finally { await worker.close(); }
console.log(`W21 worker: ${results.filter(Boolean).length}/${results.length}`);
if (results.some((pass) => !pass)) process.exitCode = 1;
