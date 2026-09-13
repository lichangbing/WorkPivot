/** Real Docker integration. Missing Docker/image is a failure, never a skipped pass. */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sandboxCommand } from '../packages/server/src/command-sandbox.js';
import type { Task } from '../packages/server/src/tasks.js';
const root = mkdtempSync(join(tmpdir(), 'wp15-'));
const directory = join(root, 'project'); mkdirSync(directory);
process.env['WORKPIVOT_HOME'] = join(root, 'home');
process.env['WORKPIVOT_TEST_SECRET'] = 'host-secret-never-export';
const task: Task = { id: 'sandbox-fixture', directory, name: 'fixture', status: 'idle', createdAt: new Date().toISOString() };
const results: boolean[] = [];
function assert(name: string, pass: boolean): void { results.push(pass); console.log(`${pass ? '✅' : '❌'} ${name}`); }
async function rejected(action: () => unknown): Promise<boolean> { try { await action(); return false; } catch (error) { console.log(String(error).slice(0, 350)); return true; } }
const policy = (path: string, mode: 'read' | 'write'): boolean => !path.includes('private') && !(mode === 'write' && path.toLowerCase().endsWith('memory.md'));
const run = () => sandboxCommand(task, policy, new AbortController().signal);
try {
  writeFileSync(join(directory, 'input.txt'), 'input');
  writeFileSync(join(directory, 'private.txt'), 'private-secret');
  writeFileSync(join(directory, 'MEMORY.md'), 'read-only-memory');
  writeFileSync(join(directory, 'probe.cjs'), `const fs=require('fs'); fs.writeFileSync('result.json', JSON.stringify({input:fs.readFileSync('input.txt','utf8'),private:fs.existsSync('private.txt'),home:fs.existsSync('/data/workpivot'),socket:fs.existsSync('/var/run/docker.sock'),secret:process.env.WORKPIVOT_TEST_SECRET,uid:process.getuid(),net:fs.readFileSync('/proc/net/route','utf8').trim().split('\\n').length})); fs.writeFileSync('output.txt','generated');`);
  await run()('node probe.cjs');
  const probe = JSON.parse(readFileSync(join(directory, 'result.json'), 'utf8'));
  assert('RL2 沙箱可读任务输入并回写输出', probe.input === 'input' && readFileSync(join(directory, 'output.txt'), 'utf8') === 'generated');
  assert('RL2 私有文件未复制进沙箱', probe.private === false && readFileSync(join(directory, 'private.txt'), 'utf8') === 'private-secret');
  assert('RL2 沙箱无应用数据、Docker socket、宿主密钥', !probe.socket && !probe.secret && !existsSync(join(directory, 'host-secret-never-export')));
  assert('RL2 沙箱非 root 且无外网路由', probe.uid === 1000 && probe.net === 1);
  assert('RL2 禁止修改项目记忆且整批产物不回写', await rejected(() => run()('echo bad > MEMORY.md; echo bad > forbidden-batch.txt')) && readFileSync(join(directory, 'MEMORY.md'), 'utf8') === 'read-only-memory' && !existsSync(join(directory, 'forbidden-batch.txt')));
  assert('RL2 非零退出不回写半成品', await rejected(() => run()('echo bad > failed.txt; exit 7')) && !existsSync(join(directory, 'failed.txt')));
  assert('RL2 链接产物整批拒绝', await rejected(() => run()('ln -s /etc/passwd escaped; echo bad > linked-batch.txt')) && !existsSync(join(directory, 'linked-batch.txt')));
  const stopped = new AbortController();
  const promise = sandboxCommand(task, policy, stopped.signal)('echo started > cancel.txt; sleep 60');
  const cancel = setTimeout(() => stopped.abort(), 5000);
  assert('RL2 停止清理容器且不回写', await rejected(() => promise) && !existsSync(join(directory, 'cancel.txt'))); clearTimeout(cancel);
  const conflict = run()('sleep 3; echo container > input.txt');
  const concurrent = setTimeout(() => writeFileSync(join(directory, 'input.txt'), 'other-task'), 1000);
  assert('RL2 并发修改不被沙箱旧副本覆盖', await rejected(() => conflict) && readFileSync(join(directory, 'input.txt'), 'utf8') === 'other-task'); clearTimeout(concurrent);
  writeFileSync(join(directory, 'office.cjs'), `const fs=require('fs'); (async()=>{const {Document,Packer,Paragraph}=require('docx');await fs.promises.writeFile('report.docx',await Packer.toBuffer(new Document({sections:[{children:[new Paragraph('WorkPivot sandbox verification')]}]}))); const ExcelJS=require('exceljs'); const wb=new ExcelJS.Workbook(); wb.addWorksheet('test').addRow(['value',42]); await wb.xlsx.writeFile('report.xlsx'); const PptxGenJS=require('pptxgenjs'); const ppt=new PptxGenJS();ppt.addSlide().addText('WorkPivot',{x:1,y:1,w:6,h:1}); await ppt.writeFile({fileName:'report.pptx'});})().catch(e=>{console.error(e);process.exit(1)});`);
  await run()('node office.cjs');
  for (const ext of ['docx', 'xlsx', 'pptx']) { const bytes = readFileSync(join(directory, `report.${ext}`)); assert(`RL4 沙箱真实生成 ${ext} ZIP 文档`, bytes.length > 2000 && bytes[0] === 0x50 && bytes[1] === 0x4b); }
  writeFileSync(join(directory, 'delete-me.txt'), 'recoverable');
  await run()('rm delete-me.txt');
  const trash = join(root, 'home', 'trash');
  assert('RL2 沙箱删除进入回收站', !existsSync(join(directory, 'delete-me.txt')) && readdirSync(trash).some((name) => readFileSync(join(trash, name, 'payload'), 'utf8') === 'recoverable'));
  assert('RL2 镜像声明的数据卷不可写', await rejected(() => run()('echo bad > /data/workpivot/attempt.txt')));
  const stageRoot = process.env['WORKPIVOT_EXECUTION_ROOT'] ?? join(tmpdir(), 'workpivot-execution');
  assert('RL2 完成后清理隔离暂存文件', readdirSync(stageRoot).length === 0);
} catch (error) { console.error(error); assert('Docker 隔离集成无异常', false); }
finally { rmSync(root, { recursive: true, force: true }); }
console.log(`\n===== W15 真实沙箱：${results.filter(Boolean).length}/${results.length} 通过 =====`);
process.exit(results.every(Boolean) ? 0 : 1);
