/** 显式启用真实供应商与生产运行链路，仅使用一次性本地数据库。 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pool, installSchema } from '../packages/server/src/database/connection.js';
import { AccountRepository } from '../packages/server/src/database/accounts.js';
import { WorkspaceRepository } from '../packages/server/src/database/workspace.js';
import { ProviderRepository } from '../packages/server/src/database/providers.js';
import { Experts } from '../packages/server/src/database/experts.js';
import { seedOfficeSkills, officeSkillNames } from '../packages/server/src/database/office-skills.js';
import { DatabaseSkills } from '../packages/server/src/database/skills.js';
import { createDatabaseRuntime } from '../packages/server/src/database/runtime.js';

const target = process.env.WORKPIVOT_TEST_PG_URL;
if (process.env.WORKPIVOT_LIVE_EVAL !== '1' || process.env.WORKPIVOT_TEST_PG_DISPOSABLE !== '1' || !target || new URL(target).hostname !== '127.0.0.1' || new URL(target).pathname !== '/workpivot_test') throw Error('Opt-in disposable local database required');
if (process.env.WORKPIVOT_LIVE_ENV_FILE) process.loadEnvFile(process.env.WORKPIVOT_LIVE_ENV_FILE);
if (!process.env.DEEPSEEK_API_KEY) throw Error('DEEPSEEK_API_KEY must be provided locally');
const secret = randomBytes(32).toString('hex');
const schema = pool(target);
const urlFor = (role: string) => { const url = new URL(target); url.username = role; url.password = secret; return url.toString(); };
const db = pool(urlFor('live_app')), auth = pool(urlFor('live_auth'));
const root = await mkdtemp(join(tmpdir(), 'workpivot-live-browser-'));
const accounts = new AccountRepository(auth);
let cleanupRuntime: (() => void) | undefined;
let server: ReturnType<Awaited<ReturnType<typeof createDatabaseRuntime>>['listen']> | undefined;
let closing = false;
async function close() {
  if (closing) return; closing = true;
  cleanupRuntime?.();
  if (server) { server.closeAllConnections(); await new Promise<void>(r => server!.close(() => r())); }
  await Promise.all([db.end(), auth.end(), schema.end()]);
  await rm(root, { recursive: true, force: true });
}
try {
  await schema.query(`CREATE ROLE live_app LOGIN PASSWORD '${secret}' NOSUPERUSER NOBYPASSRLS; CREATE ROLE live_auth LOGIN PASSWORD '${secret}' NOSUPERUSER NOBYPASSRLS;`);
  await installSchema(schema, 'live_app', 'live_auth');
  const actor = (await accounts.registerFirst('live-test', 'Live-Test-2026!', secret, secret)).user.id;
  const workspace = new WorkspaceRepository(db), experts = new Experts(db);
  const project = await workspace.createProject(actor, '单用户真实模型验收（合成资料）');
  const expert = await experts.create(actor, '验收研究员', { role: '办公研究员，核对事实与计算结果。', startup: '先检查已确认记忆与资料，不自动重跑历史工具。', skills: [] });
  await experts.bind(actor, 'projects', project.id, expert.id, project.revision);
  await workspace.createTask(actor, '真实办公流程', project.id);
  await workspace.createTask(actor, '新任务记忆复用', project.id);
  const providers = new ProviderRepository(db, secret);
  // 多格式文档验收显式配置保守字节预算，不改变业务账号或通用默认容量。
  const provider = await providers.save(actor, { name: 'DeepSeek 真实验收', baseUrl: 'https://api.deepseek.com', modelId: process.env.DEEPSEEK_MODEL || 'deepseek-flash', protocol: 'openai', apiKey: process.env.DEEPSEEK_API_KEY, ...(process.env.WORKPIVOT_OFFICE_STAGE === '1' ? { contextBudget: 262144 } : {}) });
  await providers.activate(actor, provider.id, provider.revision);
  const workerConfig: { url?: string; token?: string } = process.env.WORKPIVOT_LIVE_WORKER_FILE ? JSON.parse(await readFile(process.env.WORKPIVOT_LIVE_WORKER_FILE, 'utf8')) : {};
  const workerUrl = workerConfig.url || process.env.WORKPIVOT_WORKER_URL, workerToken = workerConfig.token || process.env.WORKPIVOT_WORKER_TOKEN;
  if (Boolean(workerUrl) !== Boolean(workerToken)) throw Error('Both worker URL and token are required');
  if (workerUrl && process.env.WORKPIVOT_OFFICE_STAGE === '1') {
    if (new URL(workerUrl).hostname !== '127.0.0.1') throw Error('验收执行器必须是本机服务');
    const skills = new DatabaseSkills(db);
    await seedOfficeSkills(skills, actor);
    for (const name of officeSkillNames) await skills.select(actor, name, true);
    await workspace.saveSetting(actor, 'execution.mode', 'auto', 0);
    await workspace.createTask(actor, '文档阶段端到端验收');
  } else if (workerUrl) {
    if (new URL(workerUrl).hostname !== '127.0.0.1') throw Error('Live fixture worker must be local');
    const skills = new DatabaseSkills(db);
    let skill = await skills.create(actor, 'office-acceptance');
    skill = await skills.save(actor, 'office-acceptance', 'SKILL.md', Buffer.from(`---\nname: office-acceptance\ndescription: Read budget Excel and generate a versioned Word report\n---\nUse list_uploaded_files to locate budget.xlsx. Run node /skills/office-acceptance/report.cjs INPUT OUTPUT MULTIPLIER using execute_skill. Inputs are /workspace/inputs/<versionId>/<name>; output must be /workspace/budget-report.docx. The script sums column B after its header and multiplies by MULTIPLIER. For updates use list_artifacts and keep the same documentId at its current revision. Do not invent calculations or results.`), skill.revision);
    const script = `const E=require('exceljs'),{Document,Packer,Paragraph}=require('docx'),fs=require('fs');(async()=>{const b=new E.Workbook();await b.xlsx.readFile(process.argv[2]);let n=0;b.worksheets[0].eachRow((r,i)=>{if(i>1)n+=Number(r.getCell(2).value)});n*=Number(process.argv[4]);fs.writeFileSync(process.argv[3],await Packer.toBuffer(new Document({sections:[{children:[new Paragraph('Budget total: '+n)]}]})));console.log('Computed total: '+n)})().catch(()=>{console.error('Office fixture failed');process.exitCode=1});`;
    skill = await skills.save(actor, 'office-acceptance', 'report.cjs', Buffer.from(script), skill.revision);
    await skills.publish(actor, 'office-acceptance', skill.revision);
    await skills.select(actor, 'office-acceptance', true);
  }
  const app = await createDatabaseRuntime(auth, db, { initToken: secret, secretKey: secret, filesRoot: root, webDist: resolve('apps/web/dist'), ...(workerUrl && workerToken ? { worker: { url: workerUrl, token: workerToken } } : {}) });
  cleanupRuntime = app.locals['stopMemoryWorker'];
  app.post('/fixture/stop', async (req, res) => {
    const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '';
    if (!await accounts.resolve(token)) { res.status(401).json({ error: '未授权' }); return; }
    res.json({ ok: true }); setTimeout(() => void close(), 100).unref();
  });
  server = app.listen(Number(process.env.WORKPIVOT_FIXTURE_PORT ?? 39987), '127.0.0.1', () => console.log('Live disposable fixture http://127.0.0.1:' + (process.env.WORKPIVOT_FIXTURE_PORT ?? 39987) + ' ; live-test / Live-Test-2026! ; real DeepSeek requests incur usage; worker=' + Boolean(workerUrl)));
  setTimeout(() => void close(), 3600000).unref();
  process.on('SIGINT', () => void close()); process.on('SIGTERM', () => void close());
} catch {
  await close();
  throw Error('Live fixture setup failed; credentials withheld');
}
