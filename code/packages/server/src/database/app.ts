import { MemoryAnalysis } from './memory-analysis.js';
import { mobileCors } from './mobile-cors.js';
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
import { workspaceStream } from './workspace-stream.js';
import { businessFactRoutes } from './business-fact-routes.js';
import { MemoryControls } from './memory-controls.js';
import { KnowledgeRepository } from './knowledge.js';
import { KnowledgeIngestionRepository } from './knowledge-ingestion.js';
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
import { RepositoryError, assertRestrictedRole, uuid } from './connection.js';
import { authThrottle } from '../auth-throttle.js';
import { ConversationRepository } from './conversation.js';
import type { DatabaseExecution } from './execution.js';
import type { ProviderRepository, ProviderInput } from './providers.js';
import type { McpRepository } from './mcp.js';
import { API_PROTOCOL } from '@workpivot/shared';
import type { FileRepository } from './files.js';
import { DailyLimits } from './daily-limits.js';
import { IamRepository, oidcBindingCookie } from './iam.js';

/** K01 联调接口；各服务适配完成后接入生产界面。 */
export async function createDatabaseApp(authPool: Pool, appPool: Pool, initToken: string, execution?: DatabaseExecution, providers?: ProviderRepository, mcp?: McpRepository, webDist?: string, files?: FileRepository, skillBuilds?: SkillBuilds, automations?: Automations, embeddings?: Embeddings, browserWorkspace?: BrowserWorkspace,browserProfiles?:BrowserProfiles): Promise<Express> {
  await assertRestrictedRole(authPool, 'identity'); await assertRestrictedRole(appPool, 'workpivot');
  const accounts = new AccountRepository(authPool), workspace = new WorkspaceRepository(appPool);
  const iam = new IamRepository(authPool);
  const dailyLimits = new DailyLimits(authPool, appPool);
  const conversation = new ConversationRepository(appPool);
  const notifications = new TaskNotifications(appPool);
  const app = express();
  app.disable('x-powered-by');
  // 仅在受控反向代理后读取真实客户端地址，用于登录限流与访问审计。
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    if (req.secure || req.headers['x-forwarded-proto'] === 'https') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });
  app.use('/api', mobileCors(process.env['WORKPIVOT_MOBILE_ORIGINS']));
  app.use(requestAudit(authPool));
  app.use(express.json({ limit: '1mb' }));
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
  app.get('/api/auth/state', async (req, res) => {
    const user = await accounts.resolve(token(req));
    const policy = await accounts.publicAccessPolicy();
    res.json({
      needsSetup: await accounts.needsSetup(),
      setupTokenRequired: false,
      registrationEnabled: policy.registrationEnabled,
      defaultMessageQuota: policy.defaultMessageQuota,
      defaultTokenQuota: policy.defaultTokenQuota,
      defaultUploadQuotaBytes: policy.defaultUploadQuotaBytes,
      defaultConcurrentTaskLimit: policy.defaultConcurrentTaskLimit,
      oidcProviders: await iam.publicProviders(),
      authenticated: !!user,
      user,
      quota: user ? await accounts.quota(user.id) : null,
    });
  });
  const throttle = authThrottle(() => {
    void authPool.query("INSERT INTO identity.audit_events(actor_id,target_id,action) VALUES(NULL,NULL,'auth_throttled')").catch(() => undefined);
  });
  app.post('/api/auth/register', throttle, async (req, res) => { const b = body(req); res.json(await accounts.register(str(b.username), str(b.password))); });
  app.post('/api/auth/login', throttle, async (req, res) => { const b = body(req); res.json(await accounts.login(str(b.username), str(b.password))); });
  const bindingCookie = (req: Request, value: string, maxAge: number) =>
    `wp_oidc_binding=${value}; Path=/api/auth/oidc; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${req.secure || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}`;
  app.post('/api/auth/oidc/:providerId/start', throttle, async (req, res) => {
    const existing = oidcBindingCookie(req.headers.cookie, 'wp_oidc_binding');
    const result = await iam.start(str(req.params['providerId']), body(req).returnTo, existing);
    res.setHeader('Set-Cookie', bindingCookie(req, result.binding, result.maxAge));
    res.json({ authorizationUrl: result.authorizationUrl });
  });
  app.get('/api/auth/oidc/callback', async (req, res) => {
    try {
      if (typeof req.query['state'] !== 'string' || typeof req.query['code'] !== 'string') throw new RepositoryError(400, 'OIDC 回调参数不完整');
      const binding = oidcBindingCookie(req.headers.cookie, 'wp_oidc_binding');
      const result = await iam.callback(req.query['state'], req.query['code'], binding);
      const target = new URL(result.returnTo, 'http://workpivot.local');
      if (result.status === 'authorized') target.searchParams.set('oidc_ticket', result.ticket);
      else if (result.status === 'pending') target.searchParams.set('oidc_pending', '1');
      else target.searchParams.set('oidc_error', '1');
      res.redirect(303, target.pathname + target.search);
    } catch {
      res.redirect(303, '/?oidc_error=1');
    }
  });
  app.post('/api/auth/oidc/complete', throttle, async (req, res) => {
    const binding = oidcBindingCookie(req.headers.cookie, 'wp_oidc_binding');
    const result = await iam.complete(str(body(req).ticket), binding);
    res.json(await accounts.issueExternalSession(result.userId, 'oidc'));
  });
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
  // 旧客户端仍可读取空提醒，预算写入明确停用；历史数据留存用于备份兼容。
  app.get('/api/usage/alerts',async(_req,res)=>{res.json({alerts:[]});});
  app.get('/api/usage',async(req,res)=>{res.json(await usage.overview(actor(res).id,str(req.query['month']),req.query['taskId']===undefined?undefined:str(req.query['taskId'])));});
  app.put('/api/usage/budget',(_req,res)=>{res.status(410).json({error:'预算功能已停用，请使用按日用量统计'});});
  app.post('/api/usage/acknowledge',(_req,res)=>{res.status(410).json({error:'预算提醒已停用'});});
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
  app.get('/api/admin/limits', async (req, res) => { res.json(await dailyLimits.overview(token(req))); });
  app.put('/api/admin/limits/:id', async (req, res) => { res.json(await dailyLimits.updateUser(token(req), str(req.params['id']), body(req))); });
  app.get('/api/admin/access-policy', async (req, res) => { res.json({ policy: await accounts.adminAccessPolicy(token(req)) }); });
  app.put('/api/admin/access-policy', async (req, res) => {
    const b = body(req);
    res.json({ policy: await accounts.updateAccessPolicy(token(req), {
      registrationMode: b.registrationMode,
      defaultMessageQuota: b.defaultMessageQuota,
      defaultTokenQuota: b.defaultTokenQuota,
      defaultUploadQuotaBytes: b.defaultUploadQuotaBytes,
      defaultConcurrentTaskLimit: b.defaultConcurrentTaskLimit,
      revision: b.revision,
    }) });
  });
  app.use('/api/admin/identity', (_req, res, next) => {
    if (actor(res).role !== 'admin') throw new RepositoryError(403, '仅管理员可管理企业身份');
    next();
  });
  app.get('/api/admin/identity', async (_req, res) => { res.json(await iam.adminOverview(actor(res).id)); });
  app.post('/api/admin/identity/organizations', async (req, res) => { res.json({ organization: await iam.createOrganization(actor(res).id, str(body(req).name)) }); });
  app.post('/api/admin/identity/providers', async (req, res) => {
    const b = body(req);
    res.json({ provider: await iam.createProvider(actor(res).id, {
      organizationId: str(b.organizationId), name: str(b.name), issuer: str(b.issuer), clientId: str(b.clientId),
      ...(b.clientSecret === undefined ? {} : { clientSecret: str(b.clientSecret) }),
      redirectUri: str(b.redirectUri), ...(b.enabled === undefined ? {} : { enabled: b.enabled === true }),
    }) });
  });
  app.patch('/api/admin/identity/providers/:id', async (req, res) => {
    const b = body(req);
    res.json({ provider: await iam.updateProvider(actor(res).id, str(req.params['id']), {
      revision: num(b.revision),
      ...(b.enabled === undefined ? {} : { enabled: b.enabled === true }),
      ...(b.clientSecret === undefined ? {} : { clientSecret: str(b.clientSecret) }),
    }) });
  });
  app.post('/api/admin/identity/pending/:id/approve', async (req, res) => {
    const b = body(req);
    res.json(await iam.approvePending(actor(res).id, str(req.params['id']), str(b.userId), num(b.revision)));
  });
  app.post('/api/admin/identity/pending/:id/reject', async (req, res) => {
    res.json(await iam.rejectPending(actor(res).id, str(req.params['id']), num(body(req).revision)));
  });
  app.post('/api/users', async (req, res) => {
    const b = body(req), role = b.role;
    if (role !== 'member' && role !== 'admin') throw new RepositoryError(400, '角色无效');
    res.json({ user: await accounts.createUser(token(req), str(b.username), str(b.password), role, b.email) });
  });
  app.patch('/api/users/:id', async (req, res) => { res.json({ user: await accounts.updateUser(token(req), str(req.params['id']), body(req)) }); });
  app.delete('/api/users/:id/sessions', async (req, res) => { await accounts.revokeUserSessions(token(req), str(req.params['id'])); res.json({ ok: true }); });
  app.post('/api/users/:id/quota/reset', async (req, res) => { await accounts.resetUserQuota(token(req), str(req.params['id'])); res.json({ ok: true }); });
  app.post('/api/users/:id/reset-password', async (req, res) => { res.json(await accounts.resetPassword(token(req), str(req.params['id']))); });
  app.get('/api/projects', async (_req, res) => { res.json({ projects: await workspace.listProjects(actor(res).id) }); });
  app.use('/api', businessFactRoutes(appPool));
  app.get('/api/workspace/stream', async (req, res) => {
    const user = actor(res).id;
    await workspaceStream(req, res, {
      user,
      after: str(req.query['after'] ?? req.headers['last-event-id'] ?? '0'),
      workspace,
      notifications,
      authorized: async () => (await accounts.resolve(token(req)))?.id === user,
    });
  });
  app.post('/api/projects', async (req, res) => { res.json({ project: await workspace.createProject(actor(res).id, str(body(req).name)) }); });
  app.patch('/api/projects/:id', async (req, res) => { const b = body(req); res.json({ project: await workspace.renameProject(actor(res).id, str(req.params['id']), str(b.name), num(b.revision)) }); });
  app.get('/api/projects/:id/members', async (req, res) => {
    const projectId = str(req.params['id']);
    const project = (await appPool.query('SELECT owner_user_id AS "owner" FROM workpivot.projects WHERE id=$1 AND deleted_at IS NULL', [projectId])).rows[0];
    if (!project) throw new RepositoryError(404, '项目不存在');
    const members = await workspace.projectMembers(actor(res).id, projectId);
    const ids = members.map((member: { userId: string }) => member.userId);
    const users = ids.length ? (await authPool.query('SELECT id,username,email FROM identity.users WHERE id=ANY($1::uuid[])', [ids])).rows : [];
    const byId = new Map(users.map(user => [user.id, user]));
    res.json({ canManage: project.owner === actor(res).id, members: members.map((member: { userId: string }) => ({ ...member, ...byId.get(member.userId) })) });
  });
  app.get('/api/projects/:id/member-candidates', async (req, res) => {
    const projectId = str(req.params['id']);
    const owner = (await appPool.query('SELECT owner_user_id AS "owner" FROM workpivot.projects WHERE id=$1 AND deleted_at IS NULL', [projectId])).rows[0];
    if (!owner || owner.owner !== actor(res).id) throw new RepositoryError(403, '只有项目所有者可以添加成员');
    const current = await workspace.projectMembers(actor(res).id, projectId);
    const excluded = current.filter((member: { revokedAt: string | null }) => !member.revokedAt).map((member: { userId: string }) => member.userId);
    res.json({ users: (await authPool.query(`SELECT id,username,email FROM identity.users
      WHERE NOT disabled AND NOT (id=ANY($1::uuid[])) ORDER BY username LIMIT 200`, [excluded])).rows });
  });
  app.post('/api/projects/:id/members', async (req, res) => {
    const b = body(req);
    const role = b.role === 'reader' ? 'reader' : 'editor';
    const projectId = str(req.params['id']), userId = str(b.userId);
    const user = await authPool.query('SELECT 1 FROM identity.users WHERE id=$1 AND NOT disabled', [userId]);
    if (!user.rowCount) throw new RepositoryError(404, '账号不存在或已停用');
    res.json(await workspace.addProjectMember(actor(res).id, projectId, userId, role));
  });
  app.delete('/api/projects/:id/members/:userId', async (req, res) => {
    res.json(await workspace.removeProjectMember(actor(res).id, str(req.params['id']), str(req.params['userId'])));
  });
  app.get('/api/tasks', async (_req, res) => { res.json({ tasks: await workspace.listTasks(actor(res).id) }); });
  const cleanup = async (owner: string): Promise<boolean> => { if (!files) return false; try { await files.collect(owner); return false; } catch { return true; } };
  if (files) {
    const processing = new DocumentProcessing(appPool,files,async()=>{throw Error('No parser in HTTP handler');});
    const knowledgeIngestion = new KnowledgeIngestionRepository(appPool);
    app.get('/api/tasks/:id/parsing',async(req,res)=>{res.json({files:await processing.list(actor(res).id,str(req.params['id']))});});
    app.post('/api/tasks/:id/parsing/:versionId/retry',async(req,res)=>{await processing.retry(actor(res).id,str(req.params['id']),str(req.params['versionId']));res.json({ok:true});});
    app.get('/api/tasks/:id/knowledge-ingestions/:versionId',async(req,res)=>{
      res.json(await knowledgeIngestion.candidates(
        actor(res).id,
        str(req.params['id']),
        str(req.params['versionId']),
        req.query['offset']===undefined?0:Number(str(req.query['offset'])),
        req.query['limit']===undefined?50:Number(str(req.query['limit'])),
      ));
    });
    app.post('/api/tasks/:id/knowledge-ingestions/:versionId/confirm',async(req,res)=>{
      const b=body(req);
      res.json(await knowledgeIngestion.confirm(
        actor(res).id,
        str(req.params['id']),
        str(req.params['versionId']),
        num(b.revision),
        b.selected as number[],
      ));
    });
    app.post('/api/tasks/:id/knowledge-ingestions/:versionId/reject',async(req,res)=>{
      const b=body(req);
      res.json(await knowledgeIngestion.reject(
        actor(res).id,
        str(req.params['id']),
        str(req.params['versionId']),
        num(b.revision),
        b.reason===undefined||b.reason===null?undefined:str(b.reason),
      ));
    });
    app.post('/api/tasks/:id/knowledge-ingestions/:versionId/reopen',async(req,res)=>{
      res.json(await knowledgeIngestion.reopen(
        actor(res).id,
        str(req.params['id']),
        str(req.params['versionId']),
        num(body(req).revision),
      ));
    });
    app.get('/api/tasks/:id/artifacts', async (req, res) => { res.json({ artifacts: await files.list(actor(res).id, str(req.params['id']), 'artifact') }); });
    app.get('/api/tasks/:id/files', async (req, res) => { res.json({ files: await files.list(actor(res).id, str(req.params['id'])) }); });
    app.post('/api/tasks/:id/files', express.raw({ type: 'application/octet-stream', limit: '10mb' }), async (req, res) => {
      if (!Buffer.isBuffer(req.body)) throw new RepositoryError(400, '上传内容必须使用application/octet-stream');
      const revision = req.query['revision'] === undefined ? undefined : Number(str(req.query['revision']));
      res.json({ file: await files.upload(actor(res).id, str(req.params['id']), str(req.query['name']), req.body, str(req.query['requestId']), req.query['documentId'] === undefined ? undefined : str(req.query['documentId']), revision) });
    });
    app.get('/api/tasks/:id/files/:documentId/versions', async (req, res) => { res.json({ versions: await files.versions(actor(res).id, str(req.params['id']), str(req.params['documentId'])) }); });
    app.delete('/api/tasks/:id/files/:documentId/versions/:versionId', async (req, res) => {
      const b=body(req);
      res.json(await files.removeVersion(actor(res).id,str(req.params['id']),str(req.params['documentId']),str(req.params['versionId']),str(b.confirmation)));
    });
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
    app.post('/api/providers/:id/capacity/sync',async(req,res)=>{res.json({provider:await providers.syncCapacity(actor(res).id,str(req.params['id']),num(body(req).revision))});});
    app.get('/api/providers/:id/capacity/audit',async(req,res)=>{res.json({entries:await providers.capacityAudit(actor(res).id,str(req.params['id']))});});
    app.post('/api/providers/:id/test',async(req,res)=>{res.json(await providers.diagnose(actor(res).id,str(req.params['id']),num(body(req).revision)));});
    app.put('/api/providers/:id', async (req, res) => { res.json({ provider: await providers.save(actor(res).id, input(req), str(req.params['id']), num(body(req).revision)) }); });
    app.post('/api/providers/active', async (req, res) => { await providers.activate(actor(res).id, str(body(req).id), num(body(req).revision), true); res.json({ ok: true }); });
    app.delete('/api/providers/:id', async (req, res) => { await providers.remove(actor(res).id, str(req.params['id']), num(body(req).revision)); res.json({ ok: true }); });
  }
  app.get('/api/tasks/:id/executions', async (req,res) => {
    const taskId = str(req.params['id']);
    res.json({ executions: await transaction(appPool, async c => {
      if (!(await c.query('SELECT id FROM workpivot.tasks WHERE id=$1 AND deleted_at IS NULL', [taskId])).rowCount) throw new RepositoryError(404, '任务不存在');
      return (await c.query('SELECT j.id,j.status,j.error,j.artifact_id AS "artifactId",j.created_at AS "createdAt",j.finished_at AS "finishedAt",v.name AS "artifactName",(SELECT COALESCE(jsonb_agg(jsonb_build_object(\'id\',a.version_id,\'name\',av.name) ORDER BY av.name,a.version_id),\'[]\'::jsonb) FROM workpivot.execution_artifacts a JOIN workpivot.document_versions av ON av.id=a.version_id WHERE a.execution_id=j.id) AS artifacts FROM workpivot.skill_executions j LEFT JOIN workpivot.document_versions v ON v.id=j.artifact_id WHERE j.task_id=$1 AND j.kind=\'skill\' ORDER BY j.created_at DESC,j.id LIMIT 10', [taskId])).rows;
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
      // 演示额度：先做一次预检，超额用户即使模型不可用也能得到明确的 429；真正计数在 runs.start 事务里。
      const quota = await accounts.quota(actor(res).id);
      if (quota.remaining !== null && quota.remaining <= 0) throw new RepositoryError(429, `演示额度已用完（${quota.limit} 次提问），如需继续请联系管理员开通`);
      const started = await execution.begin(actor(res).id, str(req.params['id']), str(b.content), str(b.requestId), b.attachments as string[] | undefined,b.resourceScope);
      if (!started.execute) { res.status(202).json({ runId: started.run.id, duplicate: true }); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }); res.flushHeaders();
      const send = (value: unknown) => { if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(value)}\n\n`); };
      const timer = setInterval(() => { if (!res.destroyed && !res.writableEnded) res.write(': ping\n\n'); }, 15000);
      try { const stopReason = await started.execute(send); send({ type: 'done', stopReason, runId: started.run.id }); }
      finally { clearInterval(timer); res.end(); }
    });
    app.post('/api/tasks/:id/stop', async (req, res) => { await execution.stop(actor(res).id, str(req.params['id'])); res.status(202).json({ stopping: true }); });
    // R006 P2：一键续跑——继承上一轮检查点与剩余步数；已派发的工具调用不会重放。
    app.post('/api/tasks/:id/resume', async (req, res) => {
      const b = body(req);
      const started = await execution.begin(actor(res).id, str(req.params['id']), '继续上一次中断的任务', str(b.requestId));
      if (!started.execute) { res.status(202).json({ runId: started.run.id, duplicate: true }); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }); res.flushHeaders();
      const send = (value: unknown) => { if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(value)}\n\n`); };
      const timer = setInterval(() => { if (!res.destroyed && !res.writableEnded) res.write(': ping\n\n'); }, 15000);
      try { const stopReason = await started.execute(send); send({ type: 'done', stopReason, runId: started.run.id }); }
      finally { clearInterval(timer); res.end(); }
    });
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
  const memoryAnalysis=new MemoryAnalysis(appPool);
  app.get('/api/memory-analysis',async(_req,res)=>res.json(await memoryAnalysis.status(actor(res).id)));
  app.post('/api/memory-analysis/:id/retry',async(req,res)=>{await memoryAnalysis.retry(actor(res).id,str(req.params['id']));res.json({ok:true});});
  app.post('/api/memories/:id/assign-project',async(req,res)=>{const b=body(req);if(b.projectId!==null&&typeof b.projectId!=='string')throw new RepositoryError(400,'请选择项目或临时任务范围');res.json(await workspace.assignPersonalMemory(actor(res).id,str(req.params['id']),num(b.revision),b.projectId as string|null));});
  app.get('/api/memory-management',async(req,res)=>{
    const scope=str(req.query['scope']);if(!['user','project','task'].includes(scope))throw new RepositoryError(400,'记忆层级无效');
    const after=req.query['after']===undefined?null:str(req.query['after']);if(after)uuid(after);
    const project=req.query['project']===undefined?'all':str(req.query['project']);if(!['all','temporary','legacy'].includes(project))uuid(project);
    res.json(await transaction(appPool,async c=>{
      const rows=(await c.query(`SELECT m.id,m.scope,m.revision,m.locked,m.needs_review AS "needsReview",m.legacy_personal AS "legacyPersonal",m.project_id AS "projectId",m.task_id AS "taskId",r.content,p.name AS "projectName",t.name AS "taskName"
        FROM workpivot.memories m JOIN workpivot.memory_revisions r ON r.memory_id=m.id AND r.revision=m.revision
        LEFT JOIN workpivot.projects p ON p.id=m.project_id AND p.deleted_at IS NULL LEFT JOIN workpivot.tasks t ON t.id=m.task_id AND t.deleted_at IS NULL
        WHERE m.deleted_at IS NULL AND m.scope=$1 AND ($2::uuid IS NULL OR m.id>$2) AND (m.scope='user' AND (m.project_id IS NULL OR p.id IS NOT NULL) OR(m.scope='project' AND p.id IS NOT NULL) OR(m.scope='task' AND t.id IS NOT NULL)) AND ($3='all' OR ($3='legacy' AND m.legacy_personal) OR ($3='temporary' AND m.project_id IS NULL AND NOT m.legacy_personal) OR m.project_id::text=$3) ORDER BY m.id LIMIT 51`,[scope,after,project])).rows;
      return {memories:rows.slice(0,50),nextCursor:rows.length>50?rows[49].id:null};
    },actor(res).id));
  });
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
    // 未归类的异常必须落到日志，否则线上只能看到笼统的 503。
    console.error('[request]', _req.method, _req.originalUrl, error);
    res.status(503).json({ error: '数据库操作暂不可用，请稍后重试' });
  });
  return app;
}
import { UsageRepository } from './usage.js';
