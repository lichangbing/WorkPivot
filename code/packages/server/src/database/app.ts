import type {BrowserProfiles} from './browser-profiles.js';
import {NetworkTargets} from './network-targets.js';
import {requestAudit,RequestAudits} from './request-audit.js';
import {AdminOperations} from './admin-operations.js';
import {PersonalData} from './personal-data.js';
import type { BrowserWorkspace } from '../web/browser-workspace.js';
import type {Embeddings} from './embeddings.js';
import type {EmbeddingInput} from './embedding-client.js';
import {TrashRepository} from './trash.js';
import { Automations } from './automations.js';
import { automationRoutes } from './automation-routes.js';
import { SkillBuilds } from './skill-builds.js';
import { skillBuildRoutes } from './skill-build-routes.js';
import { MemoryTemplates } from './memory-templates.js';
import {expertRoutes} from './expert-routes.js';
import {Experts} from './experts.js';
import { TaskNotifications } from './task-notifications.js';
import { taskStream } from './task-stream.js';
import { MemoryControls } from './memory-controls.js';
import { KnowledgeRepository } from './knowledge.js';
import { DocumentProcessing } from './document-processing.js';
import { DatabaseModelService } from './model-service.js';
import { transaction } from './connection.js';
import { MemorySuggestions } from './memory-suggestions.js';
import { DatabaseSkills } from './skills.js';
import { databaseSkillRoutes } from './skill-routes.js';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import type { Pool } from 'pg';
import { AccountRepository, type DatabaseUser } from './accounts.js';
import { WorkspaceRepository } from './workspace.js';
import { RepositoryError, assertRestrictedRole } from './connection.js';
import { authThrottle } from '../auth-throttle.js';
import { ConversationRepository } from './conversation.js';
import type { DatabaseExecution } from './execution.js';
import type { ProviderRepository, ProviderInput } from './providers.js';
import type { McpRepository } from './mcp.js';
import { API_PROTOCOL } from '@workpivot/shared';
import type { FileRepository } from './files.js';

/** K01 联调接口；各服务适配完成后接入生产界面。 */
export async function createDatabaseApp(authPool: Pool, appPool: Pool, initToken: string, execution?: DatabaseExecution, providers?: ProviderRepository, mcp?: McpRepository, webDist?: string, files?: FileRepository, skillBuilds?: SkillBuilds, automations?: Automations, embeddings?: Embeddings, browserWorkspace?: BrowserWorkspace,browserProfiles?:BrowserProfiles): Promise<Express> {
  await assertRestrictedRole(authPool, 'identity'); await assertRestrictedRole(appPool, 'workpivot');
  const accounts = new AccountRepository(authPool), workspace = new WorkspaceRepository(appPool);
  const conversation = new ConversationRepository(appPool);
  const notifications = new TaskNotifications(appPool);
  const app = express(); app.disable('x-powered-by'); app.use(requestAudit(authPool)); app.use(express.json({ limit: '1mb' }));
  app.get(['/admin', '/admin.html'], (_req, res) => { if (webDist) res.sendFile('admin.html', { root: webDist }); else res.status(503).send('管理页面尚未构建'); });
  app.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  const token = (req: Request): string => req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '';
  const actor = (res: Response): DatabaseUser => res.locals['user'] as DatabaseUser;
  const body = (req: Request): Record<string, unknown> => req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
  const str = (value: unknown): string => { if (typeof value !== 'string') throw new RepositoryError(400, '缺少文本参数'); return value; };
  const num = (value: unknown): number => { if (typeof value !== 'number') throw new RepositoryError(400, '缺少版本参数'); return value; };
  app.get('/api/health', async (_req, res) => {
    await appPool.query('SELECT 1'); await authPool.query('SELECT 1');
    res.json({ ok: true, name: 'workpivot', version: '0.3.0-rc.1', releaseStage: 'rc', releaseScope: 'single-user', apiProtocol: API_PROTOCOL, storage: 'postgresql', productionReady: false, chatEnabled: !!execution, filesEnabled: !!files, providersEnabled: !!providers, mcpEnabled: !!mcp });
  });
  app.get('/api/auth/state', async (req, res) => { const user = await accounts.resolve(token(req)); res.json({ needsSetup: await accounts.needsSetup(), setupTokenRequired: true, authenticated: !!user, user }); });
  const throttle = authThrottle(() => { /* 数据库预览入口不得持久化旧文件审计。 */ });
  app.post('/api/auth/register', throttle, async (req, res) => { const b = body(req); res.json(await accounts.registerFirst(str(b.username), str(b.password), str(b.initToken), initToken)); });
  app.post('/api/auth/login', throttle, async (req, res) => { const b = body(req); res.json(await accounts.login(str(b.username), str(b.password))); });
  app.use('/api', async (req, res, next) => {
    const user = await accounts.resolve(token(req));
    if (!user) throw new RepositoryError(401, '未登录或会话失效');
    if (user.mustChangePassword && !['/auth/password', '/auth/logout'].includes(req.path)) throw new RepositoryError(403, '请先修改临时密码');
    res.locals['user'] = user; next();
  });
  if(browserProfiles){
    app.get('/api/browser-profiles',async(_req,res)=>res.json(await browserProfiles.list(actor(res).id)));
    app.post('/api/browser-profiles',async(req,res)=>res.json(await browserProfiles.create(actor(res).id,body(req))));
    app.post('/api/browser-profiles/:id/open',async(req,res)=>res.json(await browserProfiles.open(actor(res).id,str(req.params['id']),num(body(req).revision))));
    app.post('/api/browser-profiles/:id/frame',async(req,res)=>res.json(await browserProfiles.frame(actor(res).id,str(req.params['id']),str(body(req).leaseId))));
    app.post('/api/browser-profiles/:id/command',async(req,res)=>res.json(await browserProfiles.command(actor(res).id,str(req.params['id']),str(body(req).leaseId),body(req))));
    app.post('/api/browser-profiles/:id/save',async(req,res)=>res.json(await browserProfiles.save(actor(res).id,str(req.params['id']),str(body(req).leaseId))));
    app.post('/api/browser-profiles/:id/cancel',async(req,res)=>res.json(await browserProfiles.cancel(actor(res).id,str(req.params['id']),str(body(req).leaseId))));
    app.post('/api/browser-profiles/:id/revoke',async(req,res)=>res.json(await browserProfiles.revoke(actor(res).id,str(req.params['id']),num(body(req).revision))));
  }
  if(browserWorkspace){
    app.get('/api/tasks/:id/browser',async(req,res)=>{res.json(await browserWorkspace.request(actor(res).id,str(req.params['id'])));});
    app.post('/api/tasks/:id/browser',async(req,res)=>{const controller=new AbortController();const cancel=()=>{if(!res.writableEnded)controller.abort();};res.on('close',cancel);try{res.json(await browserWorkspace.request(actor(res).id,str(req.params['id']),body(req),controller.signal));}finally{res.removeListener('close',cancel);}});
  }
  app.use('/api/automations', automationRoutes(automations ?? new Automations(appPool)));
  if(embeddings){
    app.use('/api/embeddings',(_req,res,next)=>{if(actor(res).role!=='admin')throw new RepositoryError(403,'仅管理员可配置本地向量服务');next();});
    app.get('/api/embeddings',async(_req,res)=>res.json({spaces:await embeddings.list(actor(res).id)}));
    app.post('/api/embeddings',async(req,res)=>res.json(await embeddings.create(actor(res).id,body(req) as unknown as EmbeddingInput)));
    app.post('/api/embeddings/:id/test',async(req,res)=>res.json(await embeddings.test(actor(res).id,str(req.params['id']),num(body(req).revision))));
    app.post('/api/embeddings/:id/action',async(req,res)=>res.json(await embeddings.action(actor(res).id,str(req.params['id']),num(body(req).revision),str(body(req).action))));
    app.post('/api/embeddings/search',async(req,res)=>res.json(await embeddings.search(actor(res).id,str(body(req).taskId),str(body(req).query))));
  }
  const personal=new PersonalData(appPool,files);
  app.get('/api/personal-data',async(_req,res)=>res.json(await personal.preview(actor(res).id)));
  app.post('/api/personal-data/clear',async(req,res)=>res.json(await personal.clear(actor(res).id,str(body(req).fingerprint),str(body(req).confirmation))));
  app.get('/api/personal-data/export',async(_req,res)=>{const data=await personal.export(actor(res).id);res.type('application/zip').setHeader('Content-Disposition','attachment; filename="workpivot-personal.zip"');res.send(data);});
  const trash=new TrashRepository(appPool,files);
  const adminOperations=new AdminOperations(authPool,appPool);
  const requestAudits=new RequestAudits(authPool);
  const networkTargets=new NetworkTargets(authPool,appPool);
  app.get('/api/admin/network-targets',async(req,res)=>res.json(await networkTargets.list(token(req),str(req.query['userId']))));
  app.post('/api/admin/network-targets',async(req,res)=>res.json(await networkTargets.approve(token(req),str(body(req).userId),body(req))));
  app.post('/api/admin/network-targets/:id/revoke',async(req,res)=>{const owner=str(body(req).userId);const result=await networkTargets.revoke(token(req),owner,str(req.params['id']));await browserProfiles?.reap(owner);res.json(result);});

  app.get('/api/admin/request-audits/cleanup-preview',async(req,res)=>res.json(await requestAudits.cleanupPreview(token(req),req.query['before'])));
  app.get('/api/admin/request-audits/cleanups',async(req,res)=>res.json({rows:await requestAudits.cleanups(token(req))}));
  app.post('/api/admin/request-audits/cleanup',async(req,res)=>res.json(await requestAudits.cleanup(token(req),body(req))));
  app.get('/api/admin/request-audits',async(req,res)=>res.json(await requestAudits.list(token(req),req.query)));
  app.get('/api/admin/request-audits/export',async(req,res)=>{
    const data=await requestAudits.list(token(req),req.query,true);
    res.set({'Content-Type':'application/x-ndjson; charset=utf-8','Content-Disposition':'attachment; filename="workpivot-request-audit.jsonl"','X-Content-Type-Options':'nosniff'});
    res.send(data.rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
  });
  app.get('/api/admin/automation-capacity',async(req,res)=>res.json(await adminOperations.capacity(token(req),str(req.query['userId']),req.query['before']===undefined?undefined:Number(req.query['before']))));
  app.get('/api/admin/captures',async(req,res)=>res.json(await adminOperations.captures(token(req),str(req.query['userId']),req.query['before']===undefined?undefined:str(req.query['before']))));
  app.get('/api/admin/automation-attempts',async(req,res)=>res.json(await adminOperations.attempts(token(req),str(req.query['userId']),req.query['category']===undefined?undefined:str(req.query['category']),req.query['at']===undefined?undefined:str(req.query['at']),req.query['id']===undefined?undefined:str(req.query['id']))));
  app.put('/api/admin/automation-capacity',async(req,res)=>{const value=body(req);res.json(await adminOperations.setCapacity(token(req),value.userId,value));});
  app.get('/api/admin/operations',async(req,res)=>{res.json(await adminOperations.overview(token(req),str(req.query['userId']),str(req.query['month'])));});
  const usage=new UsageRepository(appPool);
  app.get('/api/usage/alerts',async(_req,res)=>{res.json({alerts:await usage.alerts(actor(res).id)});});
  app.get('/api/usage',async(req,res)=>{res.json(await usage.overview(actor(res).id,str(req.query['month']),req.query['taskId']===undefined?undefined:str(req.query['taskId'])));});
  app.put('/api/usage/budget',async(req,res)=>{const b=body(req);await usage.budget(actor(res).id,b.currency,b.amount,b.revision);res.json({ok:true});});
  app.post('/api/usage/acknowledge',async(req,res)=>{const b=body(req);await usage.acknowledge(actor(res).id,b.currency,b.month);res.json({ok:true});});
  app.get('/api/trash',async(_req,res)=>res.json(await trash.list(actor(res).id)));
  app.post('/api/trash/:id/restore',async(req,res)=>res.json(await trash.restore(actor(res).id,str(req.params['id']),str(body(req).revision))));
  app.post('/api/trash/:id/purge',async(req,res)=>res.json(await trash.purge(actor(res).id,str(req.params['id']),str(body(req).revision),str(body(req).confirmation))));
  const knowledge = new KnowledgeRepository(appPool,embeddings);
  app.get('/api/tasks/:id/knowledge',async(req,res)=>{res.json(await knowledge.search(actor(res).id,str(req.params['id']),str(req.query['q'])));});
  app.get('/api/tasks/:id/knowledge/:chunkId',async(req,res)=>{res.json(await knowledge.read(actor(res).id,str(req.params['id']),str(req.params['chunkId'])));});
  const skills = new DatabaseSkills(appPool);
  app.use('/api/skill-builds', skillBuildRoutes(skillBuilds ?? new SkillBuilds(appPool,files)));
  app.use('/api/skill-packages', databaseSkillRoutes(skills));
  app.get('/api/skill-market', async (_req, res) => { res.json({ skills: await skills.market(actor(res).id) }); });
  app.put('/api/skill-market/:name', async (req, res) => { if (typeof body(req).loaded !== 'boolean') throw new RepositoryError(400, '加载状态无效'); await skills.select(actor(res).id, str(req.params['name']), body(req).loaded as boolean); res.json({ ok: true }); });
  expertRoutes(app,appPool);
  app.post('/api/auth/logout', async (req, res) => { await accounts.logout(token(req)); res.json({ ok: true }); });
  app.get('/api/auth/sessions', async (req, res) => { res.json({ sessions: await accounts.sessions(token(req)) }); });
  app.delete('/api/auth/sessions/:id', async (req, res) => { await accounts.revokeSession(token(req), req.params.id); res.json({ ok: true }); });
  app.post('/api/auth/password', async (req, res) => { const b = body(req); await accounts.changePassword(token(req), str(b.currentPassword), str(b.newPassword)); res.json({ ok: true }); });
  app.get('/api/users', async (req, res) => { res.json({ users: await accounts.listUsers(token(req)) }); });
  app.post('/api/users', async (req, res) => {
    const b = body(req), role = b.role;
    if (role !== 'member' && role !== 'admin') throw new RepositoryError(400, '角色无效');
    res.json({ user: await accounts.createUser(token(req), str(b.username), str(b.password), role) });
  });
  app.post('/api/users/:id/reset-password', async (req, res) => { res.json(await accounts.resetPassword(token(req), str(req.params['id']))); });
  app.get('/api/projects', async (_req, res) => { res.json({ projects: await workspace.listProjects(actor(res).id) }); });
  app.post('/api/projects', async (req, res) => { res.json({ project: await workspace.createProject(actor(res).id, str(body(req).name)) }); });
  app.patch('/api/projects/:id', async (req, res) => { const b = body(req); res.json({ project: await workspace.renameProject(actor(res).id, str(req.params['id']), str(b.name), num(b.revision)) }); });
  app.get('/api/tasks', async (_req, res) => { res.json({ tasks: await workspace.listTasks(actor(res).id) }); });
  const cleanup = async (owner: string): Promise<boolean> => { if (!files) return false; try { await files.collect(owner); return false; } catch { return true; } };
  if (files) {
    const processing = new DocumentProcessing(appPool,files,async()=>{throw Error('No parser in HTTP handler');});
    app.get('/api/tasks/:id/parsing',async(req,res)=>{res.json({files:await processing.list(actor(res).id,str(req.params['id']))});});
    app.post('/api/tasks/:id/parsing/:versionId/retry',async(req,res)=>{await processing.retry(actor(res).id,str(req.params['id']),str(req.params['versionId']));res.json({ok:true});});
    app.get('/api/tasks/:id/artifacts', async (req, res) => { res.json({ artifacts: await files.list(actor(res).id, str(req.params['id']), 'artifact') }); });
    app.get('/api/tasks/:id/files', async (req, res) => { res.json({ files: await files.list(actor(res).id, str(req.params['id'])) }); });
    app.post('/api/tasks/:id/files', express.raw({ type: 'application/octet-stream', limit: '10mb' }), async (req, res) => {
      if (!Buffer.isBuffer(req.body)) throw new RepositoryError(400, '上传内容必须使用application/octet-stream');
      const revision = req.query['revision'] === undefined ? undefined : Number(str(req.query['revision']));
      res.json({ file: await files.upload(actor(res).id, str(req.params['id']), str(req.query['name']), req.body, str(req.query['requestId']), req.query['documentId'] === undefined ? undefined : str(req.query['documentId']), revision) });
    });
    app.get('/api/tasks/:id/files/:documentId/versions', async (req, res) => { res.json({ versions: await files.versions(actor(res).id, str(req.params['id']), str(req.params['documentId'])) }); });
    app.get('/api/tasks/:id/file-versions/:versionId', async (req, res) => {
      const result = await files.download(actor(res).id, str(req.params['id']), str(req.params['versionId']));
      res.setHeader('X-Content-Type-Options', 'nosniff'); res.attachment(result.version.name); res.type('application/octet-stream').send(result.data);
    });
    app.delete('/api/tasks/:id/files/:documentId', async (req, res) => {
      await files.remove(actor(res).id, str(req.params['id']), str(req.params['documentId']), num(body(req).revision));
      res.json({ ok: true, cleanupPending: await cleanup(actor(res).id) });
    });
    app.post('/api/files/cleanup', async (_req, res) => { res.json({ removed: await files.collect(actor(res).id) }); });
  }
  if (mcp) {
    const input = (req: Request) => { const b = body(req); return { name: str(b.name), url: str(b.url), ...(b.token === undefined ? {} : { token: b.token === null ? null : str(b.token) }) }; };
    const enabled = (req: Request) => { const v = body(req).enabled; if (typeof v !== 'boolean') throw new RepositoryError(400, '启停状态无效'); return v; };
    app.get('/api/mcp', async (_req, res) => { res.json({ connections: await mcp.list(actor(res).id) }); });
    app.post('/api/mcp', async (req, res) => { res.json(await mcp.save(actor(res).id, input(req))); });
    app.put('/api/mcp/:id', async (req, res) => { res.json(await mcp.save(actor(res).id, input(req), str(req.params['id']), num(body(req).revision))); });
    app.post('/api/mcp/:id/test', async (req, res) => { res.json(await mcp.discover(actor(res).id, str(req.params['id']), num(body(req).revision))); });
    app.post('/api/mcp/:id/toggle', async (req, res) => { res.json(await mcp.toggle(actor(res).id, str(req.params['id']), num(body(req).revision), enabled(req))); });
    app.post('/api/mcp/:id/tools/toggle', async (req, res) => { res.json(await mcp.toggle(actor(res).id, str(req.params['id']), num(body(req).revision), enabled(req), str(body(req).name))); });
    app.delete('/api/mcp/:id', async (req, res) => { await mcp.remove(actor(res).id, str(req.params['id']), num(body(req).revision)); res.json({ ok: true }); });
  }
  app.use('/api/providers', (_req, res, next) => {
    if (actor(res).role !== 'admin') throw new RepositoryError(403, '仅管理员可访问模型配置');
    next();
  });
  if (providers) {
    app.get('/api/model-status', async (_req,res) => { res.json(await new DatabaseModelService(authPool,appPool,providers).status(actor(res).id)); });
    const input = (req: Request): ProviderInput => {
      const b = body(req);
      if (b.protocol !== 'openai' && b.protocol !== 'anthropic') throw new RepositoryError(400, '模型协议无效');
      return { name: str(b.name), baseUrl: str(b.baseUrl), modelId: str(b.modelId), protocol: b.protocol, ...(b.contextBudget===undefined?{}:{contextBudget:num(b.contextBudget)}), ...(b.inputPrice===undefined?{}:{inputPrice:b.inputPrice===null?null:str(b.inputPrice)}), ...(b.outputPrice===undefined?{}:{outputPrice:b.outputPrice===null?null:str(b.outputPrice)}), ...(b.currency===undefined?{}:{currency:str(b.currency)}), ...(b.apiKey === undefined ? {} : { apiKey: b.apiKey === null ? null : str(b.apiKey) }) };
    };
    app.get('/api/providers', async (_req, res) => { res.json({ providers: await providers.list(actor(res).id) }); });
    app.post('/api/providers', async (req, res) => { res.json({ provider: await providers.save(actor(res).id, input(req)) }); });
    app.post('/api/providers/:id/test',async(req,res)=>{res.json(await providers.diagnose(actor(res).id,str(req.params['id']),num(body(req).revision)));});
    app.put('/api/providers/:id', async (req, res) => { res.json({ provider: await providers.save(actor(res).id, input(req), str(req.params['id']), num(body(req).revision)) }); });
    app.post('/api/providers/active', async (req, res) => { await providers.activate(actor(res).id, str(body(req).id), num(body(req).revision), true); res.json({ ok: true }); });
    app.delete('/api/providers/:id', async (req, res) => { await providers.remove(actor(res).id, str(req.params['id']), num(body(req).revision)); res.json({ ok: true }); });
  }
  app.get('/api/tasks/:id/executions', async (req,res) => {
    const taskId = str(req.params['id']);
    res.json({ executions: await transaction(appPool, async c => {
      if (!(await c.query('SELECT id FROM workpivot.tasks WHERE id=$1 AND deleted_at IS NULL', [taskId])).rowCount) throw new RepositoryError(404, '任务不存在');
      return (await c.query('SELECT j.id,j.status,j.error,j.artifact_id AS "artifactId",j.created_at AS "createdAt",j.finished_at AS "finishedAt",v.name AS "artifactName",(SELECT COALESCE(jsonb_agg(jsonb_build_object(\'id\',a.version_id,\'name\',av.name) ORDER BY av.name,a.version_id),\'[]\'::jsonb) FROM workpivot.execution_artifacts a JOIN workpivot.document_versions av ON av.id=a.version_id WHERE a.execution_id=j.id) AS artifacts FROM workpivot.skill_executions j LEFT JOIN workpivot.document_versions v ON v.id=j.artifact_id WHERE j.task_id=$1 ORDER BY j.created_at DESC,j.id LIMIT 10', [taskId])).rows;
    },actor(res).id) });
  });
  if (execution) {
    app.get('/api/tasks/:id/resource-scope',async(req,res)=>{
      const user=actor(res).id,task=str(req.params.id),scope=await execution.runs.resources(user,task);
      const options=files?[...await files.candidates(user,task),...await files.list(user,task,'upload',scope.versionIds),...await files.list(user,task,'artifact',scope.versionIds)]:[];
      const schedules=await transaction(appPool,async c=>(await c.query("SELECT id,COALESCE(draft->>'name',config->>'name','未命名自动化') AS name FROM workpivot.automations WHERE state<>'deleted' ORDER BY created_at DESC LIMIT 100")).rows,user);
      res.json({scope,schedules,files:[...new Map(options.map(f=>[f.id,f])).values()]});
    });

    if(execution.compaction){
      const summaries=execution.compaction;
      app.get('/api/tasks/:id/summary',async(req,res)=>res.json({checkpoints:await summaries.list(actor(res).id,str(req.params['id']))}));
      app.get('/api/tasks/:id/summary/:summaryId/sources',async(req,res)=>res.json({sources:await summaries.original(actor(res).id,str(req.params['id']),str(req.params['summaryId']))}));
      app.post('/api/tasks/:id/summary',async(req,res)=>{await summaries.request(actor(res).id,str(req.params['id']));res.status(202).json({ok:true});});
      app.post('/api/tasks/:id/summary/:summaryId/decision',async(req,res)=>{const b=body(req);if(typeof b.accept!=='boolean')throw new RepositoryError(400,'需要明确确认或拒绝');res.json(await summaries.decide(actor(res).id,str(req.params['id']),str(req.params['summaryId']),num(b.revision),b.accept,b.content===undefined?undefined:str(b.content)));});
    }
    app.get('/api/tasks/:id/permissions', async (req, res) => { res.json({ pending: await execution.runs.pendingPermissions(actor(res).id, str(req.params['id'])) }); });
    app.post('/api/tasks/:id/permissions/:permissionId', async (req, res) => {
      const b = body(req);
      if ((b.decision !== 'allow' && b.decision !== 'deny') || (b.scope !== undefined && b.scope !== 'once')) throw new RepositoryError(400, '仅支持本次允许或拒绝');
      await execution.runs.decidePermission(actor(res).id, str(req.params['id']), str(req.params['permissionId']), b.decision); res.json({ ok: true });
    });
    app.post('/api/tasks/:id/messages', async (req, res) => {
      const b = body(req);
      if (b.attachments !== undefined && (!Array.isArray(b.attachments) || b.attachments.some(id => typeof id !== 'string'))) throw new RepositoryError(400, '附件列表无效');
      if (!files && Array.isArray(b.attachments) && b.attachments.length) throw new RepositoryError(400, '后台尚未启用文件上传');
      const started = await execution.begin(actor(res).id, str(req.params['id']), str(b.content), str(b.requestId), b.attachments as string[] | undefined,b.resourceScope);
      if (!started.execute) { res.status(202).json({ runId: started.run.id, duplicate: true }); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }); res.flushHeaders();
      const send = (value: unknown) => { if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(value)}\n\n`); };
      const timer = setInterval(() => { if (!res.destroyed && !res.writableEnded) res.write(': ping\n\n'); }, 15000);
      try { const stopReason = await started.execute(send); send({ type: 'done', stopReason, runId: started.run.id }); }
      finally { clearInterval(timer); res.end(); }
    });
    app.post('/api/tasks/:id/stop', async (req, res) => { await execution.stop(actor(res).id, str(req.params['id'])); res.status(202).json({ stopping: true }); });
  }
  app.get('/api/tasks/:id/stream', async (req,res) => {
    const user = actor(res), task = str(req.params['id']);
    await taskStream(req,res,{actor:user.id,task,after:str(req.query['after'] ?? req.headers['last-event-id'] ?? '0'),conversation,notifications,
      authorized:async()=>{const current=await accounts.resolve(token(req));return current?.id===user.id&&!current.mustChangePassword;},
      state:async()=>({tasks:await workspace.listTasks(user.id),pending:execution?await execution.runs.pendingPermissions(user.id,task):[],expertSuggestions:await new Experts(appPool).suggestions(user.id,task)})});
  });
  app.get('/api/tasks/:id/conversation', async (req, res) => {
    const limit = req.query['before'] === undefined ? '5' : '1';
    if (req.query['limit'] !== undefined && req.query['limit'] !== limit) throw new RepositoryError(400, '首次加载5组，向上滚动每次加载1组');
    res.json(await conversation.page(actor(res).id, str(req.params['id']), req.query['before'] === undefined ? undefined : str(req.query['before'])));
  });
  app.get('/api/tasks/:id/conversation/:turnId/events', async (req, res) => { res.json(await conversation.turnEvents(actor(res).id, str(req.params['id']), str(req.params['turnId']), str(req.query['after']), str(req.query['snapshot']))); });
  app.get('/api/tasks/:id/conversation-changes', async (req, res) => { res.json(await conversation.changes(actor(res).id, str(req.params['id']), str(req.query['after']), req.query['through'] === undefined ? undefined : str(req.query['through']))); });
  app.get('/api/tasks/:id/conversation-events/:eventId/content', async (req, res) => {
    const offset = req.query['offset'] === undefined ? '0' : str(req.query['offset']);
    if (!/^\d{1,6}$/.test(offset)) throw new RepositoryError(400, '内容位置无效');
    res.json(await conversation.eventContent(actor(res).id, str(req.params['id']), str(req.params['eventId']), Number(offset)));
  });
  app.delete('/api/projects/:id', async (req, res) => { await workspace.deleteProject(actor(res).id, str(req.params['id']), num(body(req).revision)); res.json({ ok: true, cleanupPending: await cleanup(actor(res).id) }); });
  app.delete('/api/tasks/:id', async (req, res) => { await workspace.deleteTask(actor(res).id, str(req.params['id']), num(body(req).revision)); res.json({ ok: true, cleanupPending: await cleanup(actor(res).id) }); });
  app.post('/api/tasks', async (req, res) => { const b = body(req); res.json({ task: await workspace.createTask(actor(res).id, str(b.name), b.projectId == null ? undefined : str(b.projectId)) }); });
  // 明确的仅持久化接口；不开放 /messages，避免把保存消息误认为执行智能体。
  app.post('/api/tasks/:id/notes', async (req, res) => { const b = body(req); res.json({ message: await workspace.appendMessage(actor(res).id, str(req.params['id']), 'user', str(b.content), str(b.requestId)) }); });
  app.get('/api/tasks/:id/notes', async (req, res) => { res.json({ messages: await workspace.messages(actor(res).id, str(req.params['id']), req.query['after'] === undefined ? '0' : str(req.query['after'])) }); });
  app.get('/api/preferences/:key', async (req, res) => { res.json({ setting: await workspace.setting(actor(res).id, str(req.params['key'])) }); });
  app.put('/api/preferences/:key', async (req, res) => { const b = body(req); res.json({ revision: await workspace.saveSetting(actor(res).id, str(req.params['key']), b.value, num(b.revision)) }); });
  const templates=new MemoryTemplates(appPool);
  app.get('/api/memory-templates',async(_req,res)=>{res.json({templates:await templates.list(actor(res).id)});});
  app.use('/api/admin/memory-templates',(_req,res,next)=>{if(actor(res).role!=='admin')throw new RepositoryError(403,'仅管理员可管理默认角色模板');next();});
  app.get('/api/admin/memory-templates',async(_req,res)=>{res.json({templates:await templates.list(actor(res).id,true)});});
  app.post('/api/admin/memory-templates',async(req,res)=>{res.json(await templates.save(actor(res).id,body(req) as unknown as Parameters<MemoryTemplates['save']>[1]));});
  app.put('/api/admin/memory-templates/:id',async(req,res)=>{res.json(await templates.save(actor(res).id,body(req) as unknown as Parameters<MemoryTemplates['save']>[1],str(req.params['id']),num(body(req).revision)));});
  app.delete('/api/admin/memory-templates/:id',async(req,res)=>{await templates.remove(actor(res).id,str(req.params['id']),num(body(req).revision));res.json({ok:true});});
  const controls=new MemoryControls(appPool);
  app.get('/api/memory-controls',async(_req,res)=>{res.json({layers:await controls.list(actor(res).id)});});
  app.put('/api/memory-controls/:scope',async(req,res)=>{const b=body(req);res.json(await controls.save(actor(res).id,str(req.params['scope']),b.load as boolean,b.update as boolean,num(b.revision)));});
  app.put('/api/memories/:id/lock',async(req,res)=>{const b=body(req);res.json(await controls.lock(actor(res).id,str(req.params['id']),b.locked as boolean,num(b.revision)));});
  const suggestions = new MemorySuggestions(appPool);
  app.get('/api/memory-jobs', async (_req, res) => { res.json({ jobs: await transaction(appPool, async c => (await c.query("SELECT j.run_id AS id,j.status,j.error,t.name AS task,(SELECT count(*)::int FROM workpivot.memory_suggestions s WHERE s.source_run_id=j.run_id) AS suggestions FROM workpivot.memory_jobs j JOIN workpivot.tasks t ON t.id=j.task_id JOIN workpivot.conversation_turns ct ON ct.id=(SELECT turn_id FROM workpivot.task_runs WHERE id=j.run_id) WHERE t.deleted_at IS NULL AND j.status IN ('pending','running','failed','completed') ORDER BY CASE WHEN j.status='completed' THEN 1 ELSE 0 END,ct.created_at DESC LIMIT 20")).rows, actor(res).id) }); });
  app.post('/api/memory-jobs/:id/retry', async (req, res) => { await transaction(appPool, async c => {
    const result = await c.query(`UPDATE workpivot.memory_jobs j SET status='pending',attempts=0,error=NULL,lease_until=NULL FROM workpivot.task_runs r JOIN workpivot.tasks t ON t.id=r.task_id WHERE j.run_id=r.id AND j.run_id::text=$1 AND j.status='failed' AND NOT r.context_revoked AND t.deleted_at IS NULL AND j.epoch=COALESCE((SELECT epoch FROM workpivot.knowledge_state WHERE owner_user_id=$2),0)`, [str(req.params['id']), actor(res).id]);
    if (!result.rowCount) throw new RepositoryError(409, '作业不可重试或来源已失效');
  }, actor(res).id); res.json({ ok: true }); });
  app.get('/api/memory-suggestions', async (_req, res) => { res.json({ suggestions: await suggestions.list(actor(res).id) }); });
  app.post('/api/memory-suggestions/:id/decision', async (req, res) => { const b = body(req); if (typeof b.accept !== 'boolean') throw new RepositoryError(400, '需要明确确认或拒绝'); res.json(await suggestions.decide(actor(res).id, str(req.params['id']), b.accept, b.content === undefined ? undefined : str(b.content))); });
  app.get('/api/memories', async (req, res) => {
    const scope = req.query['scope'];
    if (scope !== 'user' && scope !== 'project' && scope !== 'task') throw new RepositoryError(400, '记忆层级无效');
    res.json(await workspace.listMemories(actor(res).id, scope, req.query['scopeId'] === undefined ? undefined : str(req.query['scopeId']), req.query['after'] === undefined ? undefined : str(req.query['after'])));
  });
  app.post('/api/memories', async (req, res) => {
    const b = body(req), scope = b.scope;
    if (scope !== 'user' && scope !== 'project' && scope !== 'task') throw new RepositoryError(400, '记忆层级无效');
    res.json(await workspace.createMemory(actor(res).id, str(b.content), scope, b.scopeId == null ? undefined : str(b.scopeId)));
  });
  app.post('/api/memory-entries', async (req,res) => { const b=body(req); const replacement=b.replace as {id?:unknown;revision?:unknown}|undefined; res.json({memories:await workspace.saveMemoryEntries(actor(res).id,b.entries,str(b.scope) as 'user'|'project'|'task',b.scopeId===undefined?undefined:str(b.scopeId),replacement?{id:str(replacement.id),revision:num(replacement.revision)}:undefined)}); });
  app.get('/api/memories/:id', async (req, res) => { const memory = await workspace.readMemory(actor(res).id, str(req.params['id'])); if (!memory) throw new RepositoryError(404, '记忆不存在'); res.json(memory); });
  app.put('/api/memories/:id', async (req, res) => { const b = body(req); res.json({ revision: await workspace.editMemory(actor(res).id, str(req.params['id']), str(b.content), num(b.revision)) }); });
  app.delete('/api/memories/:id', async (req, res) => { await workspace.deleteMemory(actor(res).id, str(req.params['id']), num(body(req).revision)); res.json({ ok: true }); });
  app.use('/api', (_req, res) => { res.status(503).json({ error: '此功能尚未接入 PostgreSQL 验证服务', code: 'DATABASE_PORT_PENDING' }); });
  if (webDist) app.use(express.static(webDist));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    void _next; // Express 通过四参数签名识别错误处理器。
    if (error instanceof RepositoryError) { res.status(error.status).json({ error: error.message }); return; }
    const code = (error as { code?: string })?.code;
    if (code === '23505') { res.status(409).json({ error: '记录已存在或操作冲突' }); return; }
    if ((error as { type?: string })?.type === 'entity.parse.failed') { res.status(400).json({ error: '请求内容无效' }); return; }
    if ((error as { type?: string })?.type === 'entity.too.large') { res.status(413).json({ error: '上传内容超出大小限制' }); return; }
    res.status(503).json({ error: '数据库操作暂不可用，请稍后重试' });
  });
  return app;
}
import { UsageRepository } from './usage.js';
