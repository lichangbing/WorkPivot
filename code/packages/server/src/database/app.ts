import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import type { Pool } from 'pg';
import { AccountRepository, type DatabaseUser } from './accounts.js';
import { WorkspaceRepository } from './workspace.js';
import { RepositoryError, assertRestrictedRole } from './connection.js';
import { authThrottle } from '../auth-throttle.js';

/** Integration surface for K01. Not wired to the production UI until all services are ported. */
export async function createDatabaseApp(authPool: Pool, appPool: Pool, initToken: string): Promise<Express> {
  await assertRestrictedRole(authPool, 'identity'); await assertRestrictedRole(appPool, 'workpivot');
  const accounts = new AccountRepository(authPool), workspace = new WorkspaceRepository(appPool);
  const app = express(); app.disable('x-powered-by'); app.use(express.json({ limit: '1mb' }));
  app.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  const token = (req: Request): string => req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '';
  const actor = (res: Response): DatabaseUser => res.locals['user'] as DatabaseUser;
  const body = (req: Request): Record<string, unknown> => req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
  const str = (value: unknown): string => { if (typeof value !== 'string') throw new RepositoryError(400, '缺少文本参数'); return value; };
  const num = (value: unknown): number => { if (typeof value !== 'number') throw new RepositoryError(400, '缺少版本参数'); return value; };
  app.get('/api/health', async (_req, res) => {
    await appPool.query('SELECT 1'); await authPool.query('SELECT 1');
    res.json({ ok: true, name: 'workpivot-database-preview', storage: 'postgresql', productionReady: false });
  });
  app.get('/api/auth/state', async (req, res) => { const user = await accounts.resolve(token(req)); res.json({ needsSetup: await accounts.needsSetup(), setupTokenRequired: true, authenticated: !!user, user }); });
  const throttle = authThrottle(() => { /* Database preview must never persist a legacy file audit. */ });
  app.post('/api/auth/register', throttle, async (req, res) => { const b = body(req); res.json(await accounts.registerFirst(str(b.username), str(b.password), str(b.initToken), initToken)); });
  app.post('/api/auth/login', throttle, async (req, res) => { const b = body(req); res.json(await accounts.login(str(b.username), str(b.password))); });
  app.use('/api', async (req, res, next) => {
    const user = await accounts.resolve(token(req));
    if (!user) throw new RepositoryError(401, '未登录或会话失效');
    if (user.mustChangePassword && !['/auth/password', '/auth/logout'].includes(req.path)) throw new RepositoryError(403, '请先修改临时密码');
    res.locals['user'] = user; next();
  });
  app.post('/api/auth/logout', async (req, res) => { await accounts.logout(token(req)); res.json({ ok: true }); });
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
  app.post('/api/tasks', async (req, res) => { const b = body(req); res.json({ task: await workspace.createTask(actor(res).id, str(b.name), b.projectId == null ? undefined : str(b.projectId)) }); });
  // Explicit persistence-only endpoint. /messages remains unavailable so callers cannot mistake a saved message for an agent run.
  app.post('/api/tasks/:id/notes', async (req, res) => { const b = body(req); res.json({ message: await workspace.appendMessage(actor(res).id, str(req.params['id']), 'user', str(b.content), str(b.requestId)) }); });
  app.get('/api/tasks/:id/notes', async (req, res) => { res.json({ messages: await workspace.messages(actor(res).id, str(req.params['id']), req.query['after'] === undefined ? '0' : str(req.query['after'])) }); });
  app.get('/api/preferences/:key', async (req, res) => { res.json({ setting: await workspace.setting(actor(res).id, str(req.params['key'])) }); });
  app.put('/api/preferences/:key', async (req, res) => { const b = body(req); res.json({ revision: await workspace.saveSetting(actor(res).id, str(req.params['key']), b.value, num(b.revision)) }); });
  app.post('/api/memories', async (req, res) => {
    const b = body(req), scope = b.scope;
    if (scope !== 'user' && scope !== 'project' && scope !== 'task') throw new RepositoryError(400, '记忆层级无效');
    res.json(await workspace.createMemory(actor(res).id, str(b.content), scope, b.scopeId == null ? undefined : str(b.scopeId)));
  });
  app.get('/api/memories/:id', async (req, res) => { const memory = await workspace.readMemory(actor(res).id, str(req.params['id'])); if (!memory) throw new RepositoryError(404, '记忆不存在'); res.json(memory); });
  app.put('/api/memories/:id', async (req, res) => { const b = body(req); res.json({ revision: await workspace.editMemory(actor(res).id, str(req.params['id']), str(b.content), num(b.revision)) }); });
  app.delete('/api/memories/:id', async (req, res) => { await workspace.deleteMemory(actor(res).id, str(req.params['id']), num(body(req).revision)); res.json({ ok: true }); });
  app.use('/api', (_req, res) => { res.status(503).json({ error: '此功能尚未接入 PostgreSQL 验证服务', code: 'DATABASE_PORT_PENDING' }); });
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    void _next; // Express identifies error handlers by their four-argument signature.
    if (error instanceof RepositoryError) { res.status(error.status).json({ error: error.message }); return; }
    const code = (error as { code?: string })?.code;
    if (code === '23505') { res.status(409).json({ error: '记录已存在或操作冲突' }); return; }
    if ((error as { type?: string })?.type === 'entity.parse.failed') { res.status(400).json({ error: '请求内容无效' }); return; }
    res.status(503).json({ error: '数据库操作暂不可用，请稍后重试' });
  });
  return app;
}
