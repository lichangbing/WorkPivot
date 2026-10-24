import { inRunSlot } from './run-queue.js';
import { listMcp, mcpTools } from './mcp.js';
import { mcpRoutes } from './mcp-routes.js';
import { skillPackageRoutes } from './skill-package-routes.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { beginArtifacts, listArtifacts, finishArtifacts, artifactVersionPath } from './artifacts.js';
import { listDeliverables, selectDeliverable, deliveryTool, beginDeliverables, finishDeliverables } from './deliverables.js';
import { TenantMap } from './tenant-map.js';
import { withTenant, withAccount, tenantId, tenantPathAllowed } from './tenants.js';
import { resolveClientDirectory } from './client-directories.js';
/**
 * Express 应用与全部路由。
 * W1：供应商/任务/SSE 对话；W2：登录门/权限档位/授权卡/审计/@引用/并行上限。
 */
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { SERVICE_VERSION, API_PROTOCOL } from '@workpivot/shared';
import { DataIntegrityError } from './store.js';
import { authThrottle } from './auth-throttle.js';
import { taskFilePolicy } from './file-policy.js';
import { sandboxCommand } from './command-sandbox.js';
import { availableTools, executionGuidance, executionMode } from './execution-policy.js';
import { buildSkillTools } from './skill-tools.js';
import { runCodeTool } from './code-tools.js';
import { WebTools, browserConfiguration } from './web/tools.js';
import { workerCommand } from './worker-command.js';
import { withDirectoryLock } from './directory-lock.js';
import { transcriptArgs } from './transcript-args.js';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { canonicalPath, pathWithin, requireWithin } from '@workpivot/shared/node';
import {
  BUILTIN_TOOLS,
  MAX_STEPS_DEFAULT,
  createAnthropicClient,
  createOpenAICompatibleClient,
  executeShell,
  runAgentLoop,
  verifyAnthropicProvider,
  verifyProvider,
  type ChatMessage,
  type ModelClient,
  type ToolAccessRequest,
} from '@workpivot/core';
import { verifyClaimedFiles } from './chat-gate.js';
import { continuationPrompt } from './continuation.js';
import { disabledSkills, editSkill, skillRevision, findSkillBySlash, listSkills, pinPublishedSkills, renderSkillDirectory, setSkillDisabled } from './skills.js';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  needsSetup,
  registerFirstAdmin,
  setupTokenRequired,
  loginAccount as authLogin,
  resolveToken,
  revokeToken,
  revokeUserSessions,
  createUser,
  deleteUser,
  changePassword,
  resetUserPassword,
  updateUserRole,
  updateUserProfile,
  listUsers,
  setUserTier,
  type PublicUser,
  type Role,
} from './auth.js';
import { evaluateAccess, pendingRequests, getTier, resolvePendingRequest, setTier, TIER_LABELS, type Tier } from './permissions.js';
import { clearSessionGrants, listPathGrants, revokePathGrant } from './permission-grants.js';
import { projectRoutes } from './project-routes.js';
import { appendTranscript, createTask, getTask, listTasks, readHistory, readTranscript, updateTaskStatus } from './tasks.js';
import { audit, argsHash, readAllAudit } from './audit.js';
import { deleteProvider, listProviders, resolveActiveProvider, saveProvider, setActiveProvider, updateProvider } from './providers.js';
import { listTrash } from './trash.js';
import { addTemplate, deleteTemplate, listTemplates, renderTemplateInjection, setDefaultTemplate } from './templates.js';
import { addSchedule, cronIsValid, deleteSchedule, listNotifications, listSchedules, runScheduleNow, updateSchedule } from './schedules.js';
import { analyzeRisk } from './risk-analysis.js';
import {
  DEFAULT_PROJECT_ID,
  createProject,
  ensureDefaultProject,
  getProject,
  listProjects,
  renameProject,
  projectVisibleTo,
  projectMemoryEditableBy,
} from './projects.js';
import { workspaceRoot } from './tasks.js';
import { deleteTaskData, recordTaskUpload } from './task-deletion.js';
import { deleteProjectData } from './project-deletion.js';
import { buildMemoryTools, resolveMemoryConfirm, pendingMemory, cancelMemoryRequests } from './memory-tools.js';
import { memoryLayerRoutes, renderAdditionalMemory } from './memory-layers.js';
import { buildPlanTool, readPlan } from './plan.js';
import { initProjectMemory, memoryView, removeEntryById, renderMemoryInjection, setMemoryEnabled, writeHandbook } from './memory.js';

export interface AppOptions {
  /** 前端构建产物目录（apps/web/dist）。存在则托管静态资源并提供 SPA 回退。 */
  webDistDir?: string;
}

interface AuthedRequest extends Request {
  user?: PublicUser;
}

/** J02 批次4a：任务所有权——所有角色只可访问本人任务；未明确归属的旧任务不可见 */function taskVisibleTo(user: PublicUser | null | undefined, t: { ownerUserId?: string; projectId?: string }): boolean {
  if (!user) return false;
  if ((user.tenantId ?? 'default') !== tenantId()) return false;
  if (t.ownerUserId !== user.id) return false;
  const project = t.projectId ? getProject(t.projectId) : null;
  return !t.projectId || Boolean(project && projectVisibleTo(user, project));
}

/** 运行中的 agent 会话（taskId → 中止控制器）。 */
const running = new TenantMap<string, AbortController>();
export function abortRunningTasks(): void { for (const controller of running.allValues()) controller.abort(); }

// J02：企业服务端多用户并行，可经 WORKPIVOT_MAX_PARALLEL 调整
const PARALLEL_LIMIT = Number(process.env['WORKPIVOT_MAX_PARALLEL']) || 8;
// 联网工具在启动时构建：配置不完整直接启动失败，避免每个对话都报错。
const web = new WebTools(browserConfiguration());

// app.use('/api') 下 req.path 为相对路径（如 '/auth/login'）
const PUBLIC_PATHS = new Set(['/health', '/auth/state', '/auth/login', '/auth/register']);

export function createApp(opts: AppOptions = {}): Express {
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  // T4-02：bash 子进程的 NODE_PATH——让技能脚本 require 应用内置依赖（如 docx）。
  // 桌面打包态 import.meta 不可用：由 Electron 主进程注入 WORKPIVOT_NODE_PATH；其余走模块位置/工作目录回退。
  let bashNodePath = process.env['WORKPIVOT_NODE_PATH'] ?? '';
  if (bashNodePath === '') {
    try {
      const serverModuleDir = dirname(fileURLToPath(import.meta.url));
      const nodePathCandidates = [
        join(serverModuleDir, 'node_modules'),
        join(serverModuleDir, '..', 'node_modules'),
        join(serverModuleDir, '..', '..', 'node_modules'),
      ].filter(existsSync);
      bashNodePath = nodePathCandidates.join(delimiter);
    } catch {
      bashNodePath = '';
    }
  }

  // ---- 认证（T2-01）：除公开路径外全部要求 Bearer 令牌 ----
  app.use('/api', (req, res, next) => {
    try {
      if (req.path.split('/').some((part) => { const value = decodeURIComponent(part); return value === '..' || value.includes('\\') || value.includes('/') || value.includes('\0'); })) return res.status(400).json({ error: '请求路径无效' });
    } catch { return res.status(400).json({ error: '请求路径无效' }); }
    if (PUBLIC_PATHS.has(req.path)) return withTenant('default', next);
    const header = req.headers.authorization;
    const user = resolveToken(header?.startsWith('Bearer ') ? header.slice(7) : undefined);
    if (!user) return res.status(401).json({ error: '未登录或会话已过期' });
    if (user.mustChangePassword && !['/auth/password', '/auth/logout'].includes(req.path)) return res.status(403).json({ error: '请先修改临时密码', code: 'PASSWORD_CHANGE_REQUIRED' });
    (req as AuthedRequest).user = user;
    withAccount(user, () => { ensureDefaultProject(); next(); });
  });

  function requireAdmin(req: AuthedRequest): PublicUser | null {
    return req.user?.role === 'admin' ? req.user : null;
  }

  app.all('/api/tenants', (_req, res) => { res.status(410).json({ error: '已改为账号独立空间，无需创建租户' }); });

  app.get('/api/health', (_req, res) => {
    res.setHeader('cache-control', 'no-store');
    res.json({ ok: true, name: 'workpivot', version: SERVICE_VERSION, apiProtocol: API_PROTOCOL, ts: Date.now() });
  });

  // ---- 认证路由 ----
  app.get('/api/auth/state', (req, res) => {
    const header = req.headers.authorization;
    const user = resolveToken(header?.startsWith('Bearer ') ? header.slice(7) : undefined);
    res.json({ needsSetup: needsSetup(), setupTokenRequired: setupTokenRequired(), authenticated: Boolean(user), user: user ?? null });
  });

  const throttle = authThrottle();
  app.post('/api/auth/register', throttle, (req, res) => {
    const { username, password, initToken } = req.body as { username?: string; password?: string; initToken?: string };
    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) return res.status(400).json({ error: 'username/password 必填' });
    try {
      res.json(registerFirstAdmin(username, password, initToken));
    } catch (err) {
      res.status(403).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/auth/login', throttle, (req, res) => {
    const { username, password } = req.body as { username?: string; password?: string };
    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) return res.status(400).json({ error: 'username/password 必填' });
    try {
      res.json(authLogin(username, password));
    } catch {
      res.status(401).json({ error: '用户名或密码错误' });
    }
  });

  app.post('/api/auth/logout', (req, res) => {
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) revokeToken(header.slice(7));
    res.json({ ok: true });
  });

  app.post('/api/auth/password', (req, res) => {
    const user = (req as AuthedRequest).user;
    if (!user) return res.status(401).json({ error: '未登录或会话已过期' });
    const { currentPassword, newPassword } = req.body as { currentPassword?: string; newPassword?: string };
    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string' || !currentPassword || !newPassword) return res.status(400).json({ error: 'currentPassword/newPassword 必填' });
    const result = changePassword(user.id, currentPassword, newPassword);
    if (result.ok) res.json({ ok: true });
    else res.status(400).json({ error: result.error });
  });

  // ---- 用户管理（仅管理员）----
  app.post('/api/users/:id/reset-password', (req, res) => {
    const admin = requireAdmin(req as AuthedRequest);
    if (!admin) return res.status(403).json({ error: '仅管理员可重置密码' });
    const target = listUsers().find((u) => u.id === req.params['id']);
    if (!target) return res.status(404).json({ error: '用户不存在' });
    try {
      const result = resetUserPassword(target.id, admin);
      withAccount(target, () => { for (const [taskId, controller] of running) { controller.abort(); clearSessionGrants(taskId); } });
      res.setHeader('Cache-Control', 'no-store');
      res.json(result);
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.delete('/api/users/:id/sessions', (req, res) => {
    const admin = requireAdmin(req as AuthedRequest);
    if (!admin) return res.status(403).json({ error: '仅管理员可撤销会话' });
    const userId = req.params['id'] ?? '';
    const target = listUsers().find((u) => u.id === userId);
    if (!target) return res.status(404).json({ error: '用户不存在' });
    revokeUserSessions(userId);
    withAccount(target, () => { for (const [taskId, controller] of running) { controller.abort(); clearSessionGrants(taskId); } });
    audit({ user: admin.username, event: 'user_sessions_revoked', detail: userId });
    res.json({ ok: true });
  });
  app.get('/api/users', (req, res) => {
    if (!requireAdmin(req as AuthedRequest)) return res.status(403).json({ error: '仅管理员可查看用户' });
    res.json({ users: listUsers().map((u) => ({ ...u, createdAt: u.createdAt, lastLoginTime: u.lastLoginTime })) });
  });

  app.delete('/api/users/:id', (req, res) => {
    const admin = requireAdmin(req as AuthedRequest);
    if (!admin) return res.status(403).json({ error: '仅管理员可删除用户' });
    const target = listUsers().find((u) => u.id === req.params['id']);
    const result = deleteUser(req.params['id'] ?? '', admin.id);
    if (result.ok) {
      if (target) withAccount(target, () => { for (const [taskId, controller] of running) { controller.abort(); clearSessionGrants(taskId); } });
      audit({ user: admin.username, event: 'user_deleted', detail: req.params['id'] });
      res.json({ ok: true });
    } else {
      res.status(400).json({ error: result.error });
    }
  });

  app.put('/api/users/:id/role', (req, res) => {
    const admin = requireAdmin(req as AuthedRequest);
    if (!admin) return res.status(403).json({ error: '仅管理员可修改角色' });
    const { role } = req.body as { role?: Role };
    if (!role || (role !== 'admin' && role !== 'member')) return res.status(400).json({ error: 'role 必填' });
    const result = updateUserRole(req.params['id'] ?? '', role);
    if (result.ok) {
      audit({ user: admin.username, event: 'user_role_changed', detail: `${req.params['id']} → ${role}` });
      res.json({ ok: true });
    } else {
      res.status(400).json({ error: result.error });
    }
  });

  app.patch('/api/users/:id', (req, res) => {
    const admin = requireAdmin(req as AuthedRequest);
    if (!admin) return res.status(403).json({ error: '仅管理员可修改用户' });
    const { email } = req.body as { email?: string | null };
    if (email === undefined) return res.status(400).json({ error: 'email 必填' });
    const result = updateUserProfile(req.params['id'] ?? '', email);
    if (result.ok) res.json({ ok: true });
    else res.status(400).json({ error: result.error });
  });

  app.post('/api/users', (req, res) => {
    const admin = requireAdmin(req as AuthedRequest);
    if (!admin) return res.status(403).json({ error: '仅管理员可创建用户' });
    const { username, password, role, email } = req.body as { username?: string; password?: string; role?: Role; email?: string };
    if (!username || !password || !role) return res.status(400).json({ error: 'username/password/role 必填' });
    try {
      const user = createUser(username, password, role === 'admin' ? 'admin' : 'member', email);
      audit({ user: admin.username, event: 'user_created', detail: `${user.username}(${user.role})` });
      res.json({ user });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ---- 设置：权限档位 ----
  app.get('/api/settings', (_req, res) => {
    res.json({ permissionTier: getTier(), tierLabels: TIER_LABELS, allowDirs: [] });
  });

  app.get('/api/permissions/allowdirs', (req, res) => {
    if (!requireAdmin(req as AuthedRequest)) return res.status(403).json({ error: '仅管理员可查看永久授权' });
    res.json({ grants: listPathGrants() });
  });
  app.delete('/api/permissions/allowdirs/:id', (req, res) => {
    const admin = requireAdmin(req as AuthedRequest);
    if (!admin) return res.status(403).json({ error: '仅管理员可撤销永久授权' });
    if (!revokePathGrant(req.params['id'] ?? '')) return res.status(404).json({ error: '授权不存在' });
    audit({ user: admin.username, event: 'permission_revoked', detail: req.params['id'] });
    res.json({ ok: true });
  });

  // RL1-02：全局默认档=策略雏形（对未自选个人档位的用户生效），仅 admin 可改；个人档位走 /api/me/tier
  app.put('/api/settings/tier', (req, res) => {
    const admin = requireAdmin(req as AuthedRequest);
    if (admin === null) return res.status(403).json({ error: '仅管理员可修改全局默认档位' });
    const { tier } = req.body as { tier?: Tier };
    if (typeof tier !== 'string' || !Object.hasOwn(TIER_LABELS, tier)) return res.status(400).json({ error: `tier 必须是：${Object.keys(TIER_LABELS).join('/')}` });
    setTier(tier);
    audit({ user: admin.username, event: 'tier_changed', decision: tier });
    res.json({ permissionTier: getTier() });
  });

  // RL1-02：个人档位——成员自选，改的是自己（tier=null 清除自选、回落全局默认档）
  app.get('/api/me/tier', (req, res) => {
    const user = (req as AuthedRequest).user;
    if (!user) return res.status(401).json({ error: '未登录' });
    res.json({ tier: getTier(user.id), defaultTier: getTier(), tierLabels: TIER_LABELS });
  });

  app.put('/api/me/tier', (req, res) => {
    const user = (req as AuthedRequest).user;
    if (!user) return res.status(401).json({ error: '未登录' });
    const { tier } = req.body as { tier?: Tier | null };
    if (tier === undefined) return res.status(400).json({ error: 'tier 必填（null=清除自选、回落全局默认档）' });
    if (tier !== null && !(typeof tier === 'string' && Object.hasOwn(TIER_LABELS, tier))) {
      return res.status(400).json({ error: `tier 必须是：${Object.keys(TIER_LABELS).join('/')} 或 null` });
    }
    const result = setUserTier(user.id, tier ?? null);
    if (!result.ok) return res.status(400).json({ error: result.error });
    audit({ user: user.username, event: 'my_tier_changed', decision: tier ?? '(回落全局默认)' });
    res.json({ tier: getTier(user.id), defaultTier: getTier() });
  });

  // ---- 供应商（C02/C03：管理员=本机用户；key 密文落盘，接口永远打码）----
  app.get('/api/providers', (_req, res) => {
    res.json(listProviders());
  });

  // ---- F3 Skill 管理（仅管理员；停用技能不注入目录）----
  app.use('/api/skill-packages', skillPackageRoutes());
  app.use('/api/mcp', mcpRoutes());
  app.use('/api/memory-layers', memoryLayerRoutes());
  app.get('/api/skill-market', (_req, res) => {
    const skills = listSkills(workspaceRoot(), { projectFileAllowed: () => false })
      .filter(skill => skill.source === 'builtin' || Boolean(skill.packageVersion));
    res.json({ skills: skills.map(skill => ({ name: skill.name, description: skill.description, source: skill.source, version: skill.packageVersion })) });
  });
  app.get('/api/skills', (req, res) => {
    if (requireAdmin(req as AuthedRequest) === null) return res.status(403).json({ error: '仅管理员可查看技能' });
    const skills = listSkills(workspaceRoot(), { includeDisabled: true });
    res.json({
      skills: skills.map((s) => ({ name: s.name, description: s.description, source: s.source, disabled: disabledSkills().includes(s.name) })),
    });
  });
  app.post('/api/skills/toggle', (req, res) => {
    if (requireAdmin(req as AuthedRequest) === null) return res.status(403).json({ error: '仅管理员可启停技能' });
    const { name, disabled } = req.body as { name?: string; disabled?: boolean };
    if (typeof name !== 'string' || typeof disabled !== 'boolean') return res.status(400).json({ error: 'name/disabled 格式错误' });
    if (!listSkills(workspaceRoot(), { includeDisabled: true }).some((s) => s.name === name)) return res.status(404).json({ error: '技能不存在' });
    setSkillDisabled(name, disabled);
    audit({ user: (req as AuthedRequest).user?.username, event: 'skill_toggled', tool: name, decision: disabled ? 'disabled' : 'enabled' });
    res.json({ ok: true });
  });

  app.get('/api/skills/:name', (req, res) => {
    if (requireAdmin(req as AuthedRequest) === null) return res.status(403).json({ error: '仅管理员可编辑技能' });
    const skill = listSkills(workspaceRoot(), { includeDisabled: true }).find((s) => s.name === req.params['name']);
    if (!skill) return res.status(404).json({ error: '技能不存在' });
    return res.json({ name: skill.name, content: skill.content, revision: skillRevision(skill) });
  });
  app.put('/api/skills/:name', (req, res) => {
    if (requireAdmin(req as AuthedRequest) === null) return res.status(403).json({ error: '仅管理员可编辑技能' });
    const { content, revision } = req.body as { content?: unknown; revision?: unknown };
    if (typeof content !== 'string' || typeof revision !== 'string') return res.status(400).json({ error: '内容与版本必填' });
    try {
      editSkill(workspaceRoot(), req.params['name']!, content, revision);
      audit({ user: (req as AuthedRequest).user?.username, event: 'skill_edited', tool: req.params['name'] });
      return res.json({ ok: true });
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status) return res.status(status).json({ error: (error as Error).message });
      throw error;
    }
  });

  app.post('/api/providers/verify', async (req, res) => {
    // RL1-03（A-17）：验活=服务端向任意 URL 发请求并回告结果——仅管理员（防 member 借道探测内网）
    if (requireAdmin(req as AuthedRequest) === null) return res.status(403).json({ error: '仅管理员可验活模型供应商' });
    const { baseUrl, apiKey, protocol } = req.body as { baseUrl?: string; apiKey?: string; protocol?: string };
    if (!baseUrl) return res.status(400).json({ error: 'baseUrl 必填' });
    // M1-06：按协议分流验活
    const result = protocol === 'anthropic' ? await verifyAnthropicProvider(baseUrl, apiKey) : await verifyProvider(baseUrl, apiKey);
    res.json(result);
  });

  app.post('/api/providers', async (req, res) => {
    // F3：模型配置收敛到管理后台——仅管理员（桌面成员 403）
    if (requireAdmin(req as AuthedRequest) === null) return res.status(403).json({ error: '仅管理员可配置模型' });
    const { name, baseUrl, modelId, apiKey, verify, protocol } = req.body as {
      name?: string; baseUrl?: string; modelId?: string; apiKey?: string; verify?: boolean; protocol?: string;
    };
    if (!name || !baseUrl || !modelId) return res.status(400).json({ error: 'name/baseUrl/modelId 必填' });
    try {
      const result = await saveProvider({ name, baseUrl, modelId, apiKey, verify, protocol });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.put('/api/providers/:id', async (req, res) => {
    // F3：编辑供应商（仅管理员；apiKey 留空 = 保留原 key）
    if (requireAdmin(req as AuthedRequest) === null) return res.status(403).json({ error: '仅管理员可配置模型' });
    const { name, baseUrl, modelId, apiKey, verify, protocol } = req.body as {
      name?: string; baseUrl?: string; modelId?: string; apiKey?: string; verify?: boolean; protocol?: string;
    };
    if (!name || !baseUrl || !modelId) return res.status(400).json({ error: 'name/baseUrl/modelId 必填' });
    try {
      const result = await updateProvider(req.params['id'] ?? '', { name, baseUrl, modelId, apiKey, verify, protocol });
      audit({ user: (req as AuthedRequest).user?.username, event: 'provider_updated', detail: name });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete('/api/providers/:id', (req, res) => {
    // F3：删除供应商（仅管理员；删激活项自动顺延）
    if (requireAdmin(req as AuthedRequest) === null) return res.status(403).json({ error: '仅管理员可配置模型' });
    try {
      deleteProvider(req.params['id'] ?? '');
      audit({ user: (req as AuthedRequest).user?.username, event: 'provider_deleted', detail: req.params['id'] });
      res.json({ ok: true });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/providers/active', (req, res) => {
    if (requireAdmin(req as AuthedRequest) === null) return res.status(403).json({ error: '仅管理员可切换模型' });
    const { id } = req.body as { id?: string };
    if (!id) return res.status(400).json({ error: 'id 必填' });
    try {
      res.json({ provider: setActiveProvider(id) });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ---- 任务（B01：任务=对话+真实目录）----
  app.get('/api/tasks', (req, res) => {
    // 所有角色只见自己的任务。
    const u = (req as AuthedRequest).user;
    const all = listTasks();
    const tasks = all.filter((t) => taskVisibleTo(u, t));
    res.json({ tasks });
  });

  app.get('/api/sidebar', (req, res) => {
    const user = (req as AuthedRequest).user!;
    const selected = typeof req.query['taskId'] === 'string' ? getTask(req.query['taskId']) : null;
    if (req.query['taskId'] && (!selected || !taskVisibleTo(user, selected))) return res.status(404).json({ error: '任务不存在' });
    const tasks = listTasks().filter((t) => taskVisibleTo(user, t)).map((task) => ({ ...task, steps: readPlan(task.id) }));
    const skills = selected ? listSkills(selected.directory, { projectFileAllowed: (path) => taskFilePolicy(selected, user.id)(path, 'read') })
      : listSkills(workspaceRoot(), { projectFileAllowed: (path) => tenantPathAllowed(path) && pathWithin(path, workspaceRoot()) });
    res.json({ tasks, artifacts: selected ? listDeliverables(selected).map(f => ({ name: f.name, size: f.version.size, updatedAt: f.version.createdAt, state: 'ready', versions: [f.version] })) : [], skills: skills.map((s) => ({ name: s.name, description: s.description, source: s.source })), mcp: listMcp().map(m => ({ name: m.name, enabled: m.enabled, status: m.status, toolCount: m.tools.filter(t => !m.disabledTools?.includes(t.name)).length, tools: m.tools.map(t => ({ name: t.name, description: t.description, enabled: m.enabled && !m.disabledTools?.includes(t.name) })) })) });
  });

  app.get('/api/deliverables', (req, res) => {
    const user = (req as AuthedRequest).user!;
    res.json({ accountId: user.id, files: listTasks().filter(t => taskVisibleTo(user, t)).flatMap(t => listDeliverables(t).map(f => ({ taskId: t.id, taskName: t.name, projectId: t.projectId, name: f.name, version: f.version.id, hash: f.version.hash, size: f.version.size }))) });
  });
  app.get('/api/tasks/:id/deliverables', (req, res) => {
    const task = getTask(req.params['id'] ?? '');
    if (!task || !taskVisibleTo((req as AuthedRequest).user, task)) return res.status(404).json({ error: '任务不存在' });
    res.json({ files: listArtifacts(task), deliverables: listDeliverables(task) });
  });
  app.post('/api/tasks/:id/deliverables', (req, res) => {
    const task = getTask(req.params['id'] ?? '');
    if (!task || !taskVisibleTo((req as AuthedRequest).user, task)) return res.status(404).json({ error: '任务不存在' });
    if (typeof req.body?.name !== 'string' || typeof req.body?.selected !== 'boolean') return res.status(400).json({ error: '成果设置无效' });
    try { selectDeliverable(task, req.body.name, req.body.selected); res.json({ ok: true }); }
    catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : '设置失败' }); }
  });

  app.get('/api/tasks/:id/artifact', (req, res) => {
    const user = (req as AuthedRequest).user!;
    const task = getTask(req.params['id'] ?? '');
    if (!task || !taskVisibleTo(user, task)) return res.status(404).json({ error: '任务不存在' });
    const name = req.query['name'];
    if (typeof name !== 'string') return res.status(404).json({ error: '产物不存在' });
    try {
      const version = req.query['version'];
      const snapshot = typeof version === 'string' ? artifactVersionPath(task, name, version) : null;
      if (version !== undefined && !snapshot) return res.status(404).json({ error: '版本不存在' });
      if (!snapshot && !listArtifacts(task).some((file) => file.name === name)) return res.status(404).json({ error: '产物不存在' });
      const file = snapshot ?? requireWithin(name, task.directory);
      if ((!snapshot && !taskFilePolicy(task, user.id)(file, 'read')) || !statSync(file).isFile()) return res.status(403).json({ error: '产物不可访问' });
      res.setHeader('cache-control', 'no-store');
      res.setHeader('x-content-type-options', 'nosniff');
      // 已校验的个人工作区位于内部 .accounts 目录下。
      res.download(file, name.split('/').pop()!, { dotfiles: 'allow' });
    } catch { res.status(404).json({ error: '产物不可访问' }); }
  });

  app.post('/api/tasks', (req, res) => {
    const user = (req as AuthedRequest).user;
    if (!user) return res.status(401).json({ error: '未登录' });
    const { name, directory, projectId, temp } = req.body as {
      name?: string; directory?: string; projectId?: string; temp?: boolean;
    };
    if (typeof name !== 'string' || name.trim() === '') return res.status(400).json({ error: 'name 必填' });
    if ((directory !== undefined && (typeof directory !== 'string' || !directory.trim())) ||
      (projectId !== undefined && typeof projectId !== 'string') || (temp !== undefined && typeof temp !== 'boolean')) {
      return res.status(400).json({ error: '任务目录、项目或临时任务参数无效' });
    }
    if (temp && directory && user.role !== 'admin') return res.status(400).json({ error: '临时任务由系统分配独立目录' });

    // F1/F2：工作目录解析——临时任务落 _temp；项目任务共享项目目录；显式 directory 优先（兼容旧客户端）
    let resolvedDir = directory ?? '';
    let resolvedProjectId: string | null = projectId ?? null;
    if (temp) {
      resolvedProjectId = null;
      resolvedDir = directory ?? join(workspaceRoot(), '_temp', `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    } else if (projectId) {
      const project = getProject(projectId);
      if (!project || !projectVisibleTo(user, project)) return res.status(404).json({ error: '项目不存在或不可访问' });
      resolvedDir = project.directory;
    } else {
      if (!projectVisibleTo(user, ensureDefaultProject())) return res.status(403).json({ error: '无权访问默认项目，请选择可访问项目' });
      resolvedProjectId = ensureDefaultProject().id;
      resolvedDir = directory ?? ensureDefaultProject().directory;
    }

    try {
      resolvedDir = canonicalPath(resolvedDir, workspaceRoot());
      if (!pathWithin(resolvedDir, workspaceRoot()) && !(user.role === 'admin' && process.env['WORKPIVOT_ALLOW_EXTERNAL_DIRECTORIES'] === '1')) {
        return res.status(400).json({ error: '任务目录必须位于工作区内' });
      }
      if (user.role !== 'admin' && directory && resolvedDir !== canonicalPath(getProject(resolvedProjectId ?? '')?.directory ?? workspaceRoot())) {
        return res.status(400).json({ error: '请选择所属项目，成员不能自定义项目工作目录' });
      }
    } catch { return res.status(400).json({ error: '任务目录无法安全解析' }); }
    if (!tenantPathAllowed(resolvedDir)) return res.status(400).json({ error: '目录不属于当前账号工作区' });
    const task = createTask({ name, directory: resolvedDir, projectId: resolvedProjectId, temp: temp === true, ownerUserId: user?.id });
    if (!temp && taskFilePolicy(task, user.id)(join(task.directory, '.workpivot/memory/MEMORY.md'), 'write')) initProjectMemory(task.directory);
    audit({ user: user?.username, event: 'task_created', taskId: task.id, detail: task.directory, decision: temp ? 'temp' : 'project' });
    res.json({ task });
  });


  app.delete('/api/tasks/:id', (req, res) => {
    const task = getTask(req.params['id'] ?? '');
    if (!task) return res.status(404).json({ error: '任务不存在' });
    // RL1-03（A-13）：删除与其他任务路由同守卫——member 仅可删自己的任务（先于 temp 校验）
    if (!taskVisibleTo((req as AuthedRequest).user, task)) return res.status(403).json({ error: '无权删除该任务' });
    if (running.has(task.id)) return res.status(409).json({ error: '请先停止任务，等待执行结束后再删除' });
    try {
      deleteTaskData(task.id);
      clearSessionGrants(task.id);
      audit({ user: (req as AuthedRequest).user?.username, taskId: req.params['id'], event: 'task_deleted' });
      res.json({ ok: true });
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : '删除失败，请重试' });
    }
  });

  app.get('/api/tasks/:id', (req, res) => {
    const task = getTask(req.params['id'] ?? '');
    if (!task) return res.status(404).json({ error: '任务不存在' });
    if (!taskVisibleTo((req as AuthedRequest).user, task)) return res.status(403).json({ error: '无权访问该任务' });
    res.json({ task, history: readHistory(task.id), pending: pendingRequests(task.id, (req as AuthedRequest).user!.id), pendingMemory: pendingMemory(task.id, (req as AuthedRequest).user!.id) });
  });

  // 右栏（W1）：任务目录的文件清单（含 attachments/ 子目录内的文件，前缀显示）
  app.get('/api/tasks/:id/files', (req, res) => {
    const task = getTask(req.params['id'] ?? '');
    if (!task) return res.status(404).json({ error: '任务不存在' });
    if (!taskVisibleTo((req as AuthedRequest).user, task)) return res.status(403).json({ error: '无权访问该任务' });
    const files: string[] = [];
    const permitted = taskFilePolicy(task, (req as AuthedRequest).user!.id);
    if (existsSync(task.directory)) {
      files.push(...readdirSync(task.directory).filter((name) => permitted(join(task.directory, name), 'read')).slice(0, 200));
      const attDir = join(task.directory, 'attachments');
      if (existsSync(attDir) && permitted(attDir, 'read') && pathWithin(attDir, task.directory)) {
        for (const f of readdirSync(attDir)) if (permitted(join(attDir, f), 'read')) files.push(`attachments/${f}`);
      }
    }
    res.json({ directory: task.directory, files });
  });

  // U5/附件上传：裸体流，?name= 指定文件名；basename 消毒防穿越；写入 attachments/ 子目录（重名加序号）
  app.post(
    '/api/tasks/:id/attachments',
    express.raw({ type: '*/*', limit: '50mb' }),
    (req, res) => {
      const user = (req as AuthedRequest).user;
      const task = getTask(req.params['id'] ?? '');
    if (!task) return res.status(404).json({ error: '任务不存在' });
      if (!taskVisibleTo((req as AuthedRequest).user, task)) return res.status(403).json({ error: '无权访问该任务' });
      const rawName = String(req.query['name'] ?? '');
      const safe = rawName.replace(/^.*[\/]/, '').replace(/[\/:*?"<>|]/g, '_').trim();
      if (safe === '') return res.status(400).json({ error: 'name 必填' });
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: '空文件' });

      let dir: string;
      try { dir = requireWithin('attachments', task.directory); }
      catch { return res.status(400).json({ error: '附件目录越界或无法安全访问' }); }
      mkdirSync(dir, { recursive: true });
      const dot = safe.lastIndexOf('.');
      const stem = dot > 0 ? safe.slice(0, dot) : safe;
      const ext = dot > 0 ? safe.slice(dot) : '';
      // 重名自动加序号
      let final = safe;
      let n = 1;
      while (existsSync(join(dir, final))) {
        final = dot > 0 ? `${stem}-${n}${ext}` : `${stem}-${n}`;
        n += 1;
      }
      if (!taskFilePolicy(task, user!.id)(join(dir, final), 'write')) return res.status(403).json({ error: '无权写入附件目录' });
      writeFileSync(join(dir, final), req.body);
      recordTaskUpload(task, final);
      audit({ user: user?.username, taskId: task.id, event: 'attachment_uploaded', tool: 'upload', detail: `${final}（${req.body.length}B）` });
      res.json({ name: final, size: req.body.length });
    },
  );

  // ---- 对话（SSE 流式）----
  app.post('/api/tasks/:id/messages', (req, res) => {
    const user = (req as AuthedRequest).user;
    if (!user) return res.status(401).json({ error: '未登录' });
    const task = getTask(req.params['id'] ?? '');
    if (!task) return res.status(404).json({ error: '任务不存在' });
    if (!taskVisibleTo((req as AuthedRequest).user, task)) return res.status(403).json({ error: '无权访问该任务' });
    const { content } = req.body as { content?: string };
    if (!content || content.trim() === '') return res.status(400).json({ error: 'content 必填' });
    if (running.has(task.id)) return res.status(409).json({ error: '该任务正在运行中' });
    if (running.size >= 64) return res.status(429).json({ error: '待处理任务过多，请稍后重试' });

    let client: ModelClient;
    try {
      // M1-06：按供应商协议选客户端（openai 兼容 / anthropic Messages）
      const cfg = resolveActiveProvider();
      client = cfg.protocol === 'anthropic' ? createAnthropicClient(cfg) : createOpenAICompatibleClient(cfg);
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.flushHeaders();
    const send = (payload: unknown): void => {
      if (payload && typeof payload === 'object' && 'type' in payload) {
        if (payload.type === 'memory_confirm') updateTaskStatus(task.id, 'waiting');
        if (payload.type === 'memory_resolved' && !controller.signal.aborted) updateTaskStatus(task.id, 'running');
      }
      if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    // T4-01：技能热加载（每任务重读磁盘）+ 斜杠激活
    const skillFileAllowed = (path: string): boolean => taskFilePolicy(task, user.id)(path, 'read') && pathWithin(path, task.directory);
    const discoverSkills = pinPublishedSkills(() => listSkills(task.directory, { projectFileAllowed: skillFileAllowed }));
    const skills = discoverSkills();
    const loadedSkills = new Set<string>();
    const skillTools = buildSkillTools(discoverSkills, skillFileAllowed, (name) => loadedSkills.add(name));
    let effectiveContent = content;
    const activeSkill = findSkillBySlash(skills, content);
    if (activeSkill) {
      loadedSkills.add(activeSkill.name);
      effectiveContent = `【技能 ${activeSkill.name} 已激活——严格按以下技能说明执行】
${activeSkill.content}

【用户消息】
${content}`;
    }

    // @文件引用（T2-02）：把引用文件内容展开进消息
    const filePolicy = taskFilePolicy(task, user.id);
    let expanded = expandFileRefs(effectiveContent, task.directory, filePolicy);
    // U5 附件注入：发送时携带的附件名单（attachments/ 下已上传文件）内容自动进上下文
    const attachNames = (req.body as { attachments?: string[] }).attachments;
    const acceptedAttachments: string[] = [];
    if (Array.isArray(attachNames) && attachNames.length > 0) {
      for (const name of attachNames) {
        const safeName = String(name).replace(/^.*[\/]/, '');
        let p: string;
        try { p = requireWithin(join('attachments', safeName), task.directory); } catch { continue; }
        if (filePolicy(p, 'read') && existsSync(p)) {
          acceptedAttachments.push(safeName);
          const text = readFileSync(p, 'utf8');
          const capped = text.length > 64_000 ? `${text.slice(0, 64_000)}…（截断）` : text;
          expanded += `

--- 上传附件 ${safeName} ---
${capped}
--- 附件结束 ---`;
        }
      }
    }

    const history: ChatMessage[] = readHistory(task.id, true).map((m) => ({ role: m.role, content: m.content }));
    history.push({ role: 'user', content: expanded });
    appendTranscript(task.id, 'user_message', { content: expanded, displayContent: content, attachments: acceptedAttachments });

    const controller = new AbortController();
    running.set(task.id, controller);
    updateTaskStatus(task.id, 'queued');
    // 注意：req 的 'close' 在请求体读完即触发（Node 16+），不能作为客户端断开信号
    res.on('close', AsyncLocalStorage.bind(() => {
      stopHeartbeat();
      if (!res.writableEnded) {
        controller.abort();
        clearSessionGrants(task.id);
      }
    }));
    // SSE 心跳：长工具执行期无事件流，TCP 缓冲不满时服务端察觉不到客户端断开——
    // 每 15s 写一行注释帧迫使缓冲滚动，socket 死亡即刻触发 res 'close' → abort
    const heartbeat = setInterval(() => {
      if (!res.destroyed && !res.writableEnded) res.write(': ping\n\n');
    }, 15_000);
    const stopHeartbeat = (): void => clearInterval(heartbeat);

    let system = buildSystemPrompt(task.directory, getTier(task.ownerUserId ?? user.id)) + renderSkillDirectory(skills) + '\n生成最终成果后，必须调用 deliver_files 登记交付文件。只交付用户需要的最终成果，脚本、缓存、草稿和过程材料不要交付。';
    const memoryProject = task.projectId ? getProject(task.projectId) : null;
    system += renderMemoryInjection(task.ownerUserId ?? user.id, memoryProject && projectVisibleTo(user, memoryProject) && filePolicy(join(memoryProject.directory, '.workpivot/memory/MEMORY.md'), 'read') ? memoryProject.directory : null);
    system += renderAdditionalMemory(task.id);
    const commandMode = executionMode();
    system += executionGuidance(commandMode);
    system += renderTemplateInjection();
    system += [
      '',
      '# 记忆纪律',
      '用户明确要求记住信息时,用 remember 工具保存(条目区,静默生效)。',
      '把信息写入长期记忆(手写区)用 promote_memory 工具,调用后会弹出确认卡,用户可拒绝。',
      '用户要求忘掉某事时用 forget 工具。',
      '项目的长期信息由负责人在设置中的记忆管理面板维护。需要更新时，请整理建议内容交给负责人保存。',
      '# 访问纪律（I02）',
      '访问被拒绝后，不要用其他工具绕过这次拒绝去访问同一路径；但可以改用允许范围内的其他路径或其他方法完成任务。确实无解时，说明原因并停止。',
      '# 计划纪律（A03）',
      '多步任务（预计 ≥3 步）开工前先用 update_plan 建立阶段计划；每完成一个阶段或计划调整时全量更新；阶段全部完成后收尾。',
    ].join('\n');

    const requestAccess: (req: ToolAccessRequest) => Promise<boolean> = async (access) => {
      if (access.paths.some((p) => !filePolicy(p.path, p.mode))) {
        audit({ user: user.username, taskId: task.id, event: 'file_policy_denied', tool: access.tool, decision: 'deny' });
        return false;
      }
      const result = await evaluateAccess(
        // RL1-02：档位按任务所有者取（admin 代跑/定时执行不提权）；旧任务无 owner 回落操作者
        { tool: access.tool, kind: access.kind, paths: access.paths, command: access.command, external: access.external, taskDir: task.directory, taskId: task.id, userId: task.ownerUserId ?? user.id,
          signal: controller.signal,
          onSettled: (id, decision, reason) => {
            if (!controller.signal.aborted) updateTaskStatus(task.id, 'running');
            send({ type: 'permission_resolved', id, decision, reason });
            if (reason !== 'decision') audit({ user: user.username, taskId: task.id, event: 'permission_expired', decision: 'deny', detail: reason });
          },
        },
        (request) => {
          updateTaskStatus(task.id, 'waiting');
          send({ type: 'permission_request', ...request });
          // R002：高危/界外授权卡异步附加 AI 风险解读（不阻塞确认；失败静默无解读）
          const risky = /高危|任务目录之外/.test(request.reason ?? '');
          if (risky) {
            void analyzeRisk({
              id: request.id,
              tool: request.tool,
              kind: request.kind,
              command: request.command,
              paths: request.paths,
              reason: request.reason,
              userContext: expanded,
            }).then((analysis) => {
              if (analysis !== '') send({ type: 'risk_analysis', id: request.id, analysis });
            });
          }
        },
      );
      audit({
        user: user?.username,
        taskId: task.id,
        event: 'tool_access',
        tool: access.tool,
        decision: result.allowed ? 'allow' : 'deny',
        detail: result.auditedReason,
        argsHash: argsHash({ paths: access.paths, command: access.command }),
      });
      return result.allowed;
    };

    // T3-06/K04：大结果落盘到任务目录 .workpivot/results/，模型只拿预览+路径
    const stashResult = async (content: string): Promise<string> => {
      const dir = requireWithin(join('.workpivot', 'results'), task.directory);
      if (!filePolicy(dir, 'write')) throw new Error('无权保存工具结果到该目录');
      mkdirSync(dir, { recursive: true });
      const file = requireWithin(join(dir, `result-${Date.now()}.txt`), task.directory);
      if (!filePolicy(file, 'write')) throw new Error('无权保存工具结果');
      writeFileSync(file, content, 'utf8');
      appendTranscript(task.id, 'meta', { event: 'result_stashed', path: file, size: content.length });
      return `（工具结果过大已落盘:${file}。可用 read 工具读取完整内容。）\n前 2000 字符预览:\n${content.slice(0, 2000)}`;
    };

    const maxSteps = Number(process.env['WORKPIVOT_MAX_STEPS']) || MAX_STEPS_DEFAULT;
    const maxDurationMs = (Number(process.env['WORKPIVOT_MAX_MINUTES']) || 30) * 60_000;

    // 文件链路原本没有联网工具；这里补上 web_fetch/web_search（配了浏览器服务再出现 browser_visit）。
    const webTools = web.tools(async (name, data) => {
      const relative = join('web-artifacts', String(name).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80));
      const target = requireWithin(relative, task.directory);
      if (!filePolicy(target, 'write')) throw new Error('无权写入网页截图');
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, data);
      return relative;
    });

    // O-02：bash 与 run_code 共用同一把目录锁，避免挂载模式下同项目并发执行互相覆盖。
    const rawExecuteCommand = commandMode === 'trusted-local' ? undefined
      : commandMode === 'worker' ? workerCommand(task, filePolicy, controller.signal, () => discoverSkills().filter((skill) => loadedSkills.has(skill.name)))
      : commandMode === 'docker' ? sandboxCommand(task, filePolicy, controller.signal)
      : async () => { throw new Error('后台未启用命令执行'); };
    const executeCommand = rawExecuteCommand === undefined
      ? undefined
      : (command: string) => withDirectoryLock(task.directory, () => rawExecuteCommand(command));

    // T3-03/F02：带核验闸门的执行——声称产出但文件缺失 → 打回重做（≤2 次）
    const runWithGate = async (attempt: number, baseMessages: ChatMessage[]): Promise<{ stopReason: string; steps: number }> => {
      const result = await runAgentLoop({
        client,
        tools: availableTools([...BUILTIN_TOOLS, runCodeTool({ container: commandMode === 'worker' || commandMode === 'docker', execute: executeShell }), ...webTools, ...skillTools, ...memoryTools, deliveryTool(task), planTool, ...mcpTools()], commandMode),
        system,
        messages: baseMessages,
        taskDir: task.directory,
        requestAccess,
        maxSteps,
        maxDurationMs,
        stashResult,
        // 早停兜底：产出型任务只表态没动手时，追问一轮（最多 1 次）。
        idleLimit: 1,
        onIdle: ({ text }: { text: string }) => {
          const lastUser = [...baseMessages].reverse().find((m) => m.role === 'user')?.content;
          const nudge = continuationPrompt(typeof lastUser === 'string' ? lastUser : '', text);
          if (nudge) audit({ user: user?.username, taskId: task.id, event: 'idle_nudge', decision: 'continue' });
          return nudge;
        },
        // 长任务压缩早期工具结果；0 或负数表示关闭。
        contextBudget: Number(process.env['WORKPIVOT_CONTEXT_CHARS']) || undefined,
        extraEnv: bashNodePath ? { NODE_PATH: bashNodePath } : undefined,
        filePolicy,
        executeCommand,
        signal: controller.signal,
        onEvent: (event) => {
          send(event);
          if (event.type === 'tool_use') {
            appendTranscript(task.id, 'tool_use', { toolName: event.toolName, displayName: event.displayName, callId: event.callId, args: transcriptArgs(event.args) });
            audit({ user: user?.username, taskId: task.id, event: 'tool_use', tool: event.toolName, argsHash: argsHash(event.args) });
          }
          if (event.type === 'tool_result') {
            appendTranscript(task.id, 'tool_result', { toolName: event.toolName, displayName: event.displayName, callId: event.callId, durationMs: event.durationMs, status: event.status, ok: event.ok, summary: event.message });
          }
          // O-05：用量落转写，便于事后核算成本；不进入对话内容。
          if (event.type === 'usage') {
            appendTranscript(task.id, 'meta', { event: 'usage', inputTokens: event.inputTokens ?? 0, outputTokens: event.outputTokens ?? 0 });
          }
        },
      });

      const finalText = [...result.messages]
        .reverse()
        .find((m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.length > 0)?.content;
      if (typeof finalText === 'string' && finalText.length > 0) {
        appendTranscript(task.id, 'assistant_message', { content: finalText });
      }

      if (result.stopReason === 'completed' && typeof finalText === 'string' && finalText.length > 0) {
        const { missing } = verifyClaimedFiles(finalText, task.directory);
        if (missing.length > 0 && attempt < 2) {
          audit({ user: user?.username, taskId: task.id, event: 'gate_reject', decision: 'retry', detail: missing.join('、') });
          send({ type: 'gate_reject', missing });
          const note = `核验失败:以下声称产出的文件在任务目录中不存在或为空:${missing.join('、')}。请用 write 工具实际生成这些文件,然后重新给出总结。`;
          appendTranscript(task.id, 'user_message', { content: note });
          baseMessages.push({ role: 'user', content: note });
          return runWithGate(attempt + 1, baseMessages);
        }
        if (missing.length > 0) {
          send({ type: 'gate_reject', missing, final: true });
        }
      }
      return { stopReason: result.stopReason, steps: result.steps };
    }

    const memoryTools = buildMemoryTools(task.ownerUserId ?? user.id, task.id, send);
    const planTool = buildPlanTool(task.id, send);

    let started = false;
    void inRunSlot(PARALLEL_LIMIT, controller.signal, () => {
      started = true;
      beginArtifacts(task);
      beginDeliverables(task);
      updateTaskStatus(task.id, 'running');
      return runWithGate(0, history);
    })
      .then((result) => {
        finishArtifacts(task, result.stopReason);
        finishDeliverables(task, result.stopReason);
        updateTaskStatus(task.id, result.stopReason === 'completed' ? 'idle' : result.stopReason === 'aborted' ? 'stopped' : 'failed', result.stopReason);
        audit({ user: user?.username, taskId: task.id, event: 'task_done', decision: result.stopReason, detail: `${result.steps} 步` });
        send({ type: 'done', stopReason: result.stopReason, steps: result.steps });
      })
      .catch((err: unknown) => {
        try { if (started) finishArtifacts(task, controller.signal.aborted ? 'aborted' : 'error'); } catch { /* 保留原始失败原因。 */ }
        updateTaskStatus(task.id, controller.signal.aborted ? 'stopped' : 'failed', controller.signal.aborted ? 'aborted' : 'error');
        send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => {
        stopHeartbeat();
        if (running.get(task.id) === controller) running.delete(task.id);
        res.end();
      });
  });

  // W2/彩排修复：运行中可停止——中止 agent 循环（模型流/工具随即中断，任务转 interrupted）
  app.post('/api/tasks/:id/stop', (req, res) => {
    const task = getTask(req.params['id'] ?? '');
    if (!task) return res.status(404).json({ error: '任务不存在' });
    if (!taskVisibleTo((req as AuthedRequest).user, task)) return res.status(403).json({ error: '无权访问该任务' });
    const controller = running.get(task.id);
    if (!controller) return res.status(409).json({ error: '该任务未在运行中' });
    controller.abort();
    clearSessionGrants(task.id);
    audit({ user: (req as AuthedRequest).user?.username, taskId: task.id, event: 'task_stopped', decision: 'stopped' });
    res.json({ ok: true });
  });

  // M1/E01：记忆确认卡回填 + 查看/开关
  app.post('/api/tasks/:id/memory/confirm', (req, res) => {
    const { id: confirmId, approve } = req.body as { id?: string; approve?: boolean };
    const memTask = getTask(req.params['id'] ?? '');
    if (!memTask) return res.status(404).json({ error: '任务不存在' });
    if (!taskVisibleTo((req as AuthedRequest).user, memTask)) return res.status(404).json({ error: '任务不存在' });
    if (typeof confirmId !== 'string' || typeof approve !== 'boolean') return res.status(400).json({ error: 'id/approve 格式无效' });
    const actor = (req as AuthedRequest).user!;
    const ok = resolveMemoryConfirm(confirmId, approve, { taskId: memTask.id, userId: actor.id, role: actor.role });
    if (ok) audit({ user: (req as AuthedRequest).user?.username, taskId: req.params['id'], event: 'memory_confirm', decision: approve ? 'allow' : 'deny', detail: confirmId });
    if (ok) res.json({ ok: true });
    else res.status(404).json({ error: '确认请求不存在或已处理' });
  });

  app.get('/api/memory', (req, res) => {
    const user = (req as AuthedRequest).user;
    if (!user) return res.status(401).json({ error: '未登录' });
    const taskId = req.query['taskId'] as string | undefined;
    const memTask = taskId ? getTask(taskId) : null;
    if (taskId && !memTask) return res.status(404).json({ error: '任务不存在' });
    if (memTask && !taskVisibleTo(user, memTask)) return res.status(404).json({ error: '任务不存在' });
    const project = memTask?.projectId && !memTask.temp ? getProject(memTask.projectId) : null;
    const visible = project && projectVisibleTo(user, project) && memTask && taskFilePolicy(memTask, user.id)(join(project.directory, '.workpivot/memory/MEMORY.md'), 'read');
    res.json({ ...memoryView(user.id, visible ? project.directory : null),
      projectId: visible ? project.id : null, canEditProject: Boolean(visible && projectMemoryEditableBy(user, project)) });
  });

  app.post('/api/memory/toggle', (req, res) => {
    const { enabled } = req.body as { enabled?: boolean };
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled 必须为布尔值' });
    setMemoryEnabled(enabled);
    if (!enabled) cancelMemoryRequests();
    audit({ user: (req as AuthedRequest).user?.username, event: 'memory_toggled', decision: enabled ? 'on' : 'off' });
    res.json({ enabled });
  });

  // M1-11：设置页记忆面板——手写区编辑（MEMORY.md 全量替换，长度封顶防滥用）
  app.put('/api/memory/handbook', (req, res) => {
    const user = (req as AuthedRequest).user;
    if (!user) return res.status(401).json({ error: '未登录' });
    const { content } = req.body as { content?: string };
    if (typeof content !== 'string') return res.status(400).json({ error: 'content 必填（字符串）' });
    if (content.length > 20_000) return res.status(400).json({ error: '手写区超过 20000 字符上限' });
    writeHandbook(user.id, content);
    audit({ user: user.username, event: 'memory_handbook_edited', detail: `${content.length} 字符` });
    res.json({ ok: true });
  });

  // M1-11：设置页记忆面板——按 id 删除单条条目
  app.delete('/api/memory/entries/:id', (req, res) => {
    const user = (req as AuthedRequest).user;
    if (!user) return res.status(401).json({ error: '未登录' });
    const ok = removeEntryById(user.id, req.params['id'] ?? '');
    if (!ok) return res.status(404).json({ error: '条目不存在' });
    audit({ user: user.username, event: 'memory_entry_deleted', detail: req.params['id'] });
    res.json({ ok: true });
  });

  // ---- M1-10：审计查看/导出（I03）+ 回收站清单（B03），仅管理员 ----
  app.get('/api/audit', (req, res) => {
    if (requireAdmin(req as AuthedRequest) === null) return res.status(403).json({ error: '仅管理员可查看审计' });
    const rows = readAllAudit().slice(-500).map((line) => JSON.parse(line) as Record<string, unknown>);
    res.json({ rows });
  });

  app.get('/api/audit/export', (req, res) => {
    if (requireAdmin(req as AuthedRequest) === null) return res.status(403).json({ error: '仅管理员可导出审计' });
    const rows = readAllAudit();
    audit({ user: (req as AuthedRequest).user?.username, event: 'audit_exported', detail: `${rows.length} 行` });
    res.setHeader('content-type', 'application/jsonl; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="workpivot-audit-${new Date().toISOString().slice(0, 10)}.jsonl"`);
    res.send(rows.join('\n'));
  });

  app.get('/api/trash', (req, res) => {
    if (requireAdmin(req as AuthedRequest) === null) return res.status(403).json({ error: '仅管理员可查看回收站' });
    res.json({ items: listTrash() });
  });

  // ---- M1-07/H01：企业 Word 模板（上传/设默认/删除；清单全员可读——生成链要拿路径） ----
  app.get('/api/templates', (req, res) => {
    void req;
    res.json({ templates: listTemplates() });
  });

  app.post(
    '/api/templates',
    express.raw({ type: () => true, limit: '20mb' }),
    (req, res) => {
      const admin = requireAdmin(req as AuthedRequest);
      if (!admin) return res.status(403).json({ error: '仅管理员可上传模板' });
      const name = String(req.query['name'] ?? '');
      const kind = String(req.query['kind'] ?? 'general');
      if (name.trim() === '') return res.status(400).json({ error: 'name 必填' });
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: '请求体必须是 .docx 二进制' });
      try {
        const tpl = addTemplate(name.trim(), kind, req.body);
        audit({ user: admin.username, event: 'template_uploaded', detail: `${tpl.name}(${tpl.kind})` });
        res.json({ template: tpl });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.put('/api/templates/:id/default', (req, res) => {
    const admin = requireAdmin(req as AuthedRequest);
    if (!admin) return res.status(403).json({ error: '仅管理员可设置默认模板' });
    try {
      const tpl = setDefaultTemplate(req.params['id'] ?? '');
      audit({ user: admin.username, event: 'template_default_set', detail: tpl.name });
      res.json({ template: tpl });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete('/api/templates/:id', (req, res) => {
    const admin = requireAdmin(req as AuthedRequest);
    if (!admin) return res.status(403).json({ error: '仅管理员可删除模板' });
    try {
      deleteTemplate(req.params['id'] ?? '');
      audit({ user: admin.username, event: 'template_deleted', detail: req.params['id'] });
      res.json({ ok: true });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ---- M1-09/F06：定时任务（管理=仅管理员；清单/通知全员可读） ----
  app.get('/api/schedules', (req, res) => {
    void req;
    res.json({ schedules: listSchedules() });
  });

  app.post('/api/schedules', (req, res) => {
    const admin = requireAdmin(req as AuthedRequest);
    if (!admin) return res.status(403).json({ error: '仅管理员可创建定时任务' });
    const { name, cron, content, taskName, catchup } = req.body as {
      name?: string; cron?: string; content?: string; taskName?: string; catchup?: boolean;
    };
    if (!name || !cron || !content || !taskName) return res.status(400).json({ error: 'name/cron/content/taskName 必填' });
    if (!cronIsValid(cron)) return res.status(400).json({ error: `cron 表达式非法：${cron}（5 字段：分 时 日 月 周）` });
    try {
      const schedule = addSchedule({ name, cron, content, taskName, catchup: catchup === true, ownerUserId: admin.id });
      audit({ user: admin.username, event: 'schedule_created', detail: `${name} ${cron}` });
      res.json({ schedule });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.put('/api/schedules/:id', (req, res) => {
    const admin = requireAdmin(req as AuthedRequest);
    if (!admin) return res.status(403).json({ error: '仅管理员可修改定时任务' });
    const patch = req.body as { name?: string; cron?: string; content?: string; enabled?: boolean; catchup?: boolean };
    try {
      const schedule = updateSchedule(req.params['id'] ?? '', patch);
      audit({ user: admin.username, event: 'schedule_updated', detail: `${schedule.name} ${JSON.stringify(patch)}`.slice(0, 200) });
      res.json({ schedule });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete('/api/schedules/:id', (req, res) => {
    const admin = requireAdmin(req as AuthedRequest);
    if (!admin) return res.status(403).json({ error: '仅管理员可删除定时任务' });
    try {
      deleteSchedule(req.params['id'] ?? '');
      audit({ user: admin.username, event: 'schedule_deleted', detail: req.params['id'] });
      res.json({ ok: true });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/schedules/:id/run', (req, res) => {
    const admin = requireAdmin(req as AuthedRequest);
    if (!admin) return res.status(403).json({ error: '仅管理员可手动运行' });
    const port = Number(req.app.get('port') ?? process.env['WORKPIVOT_PORT'] ?? 0);
    if (!port) return res.status(500).json({ error: '无法确定服务端口' });
    void runScheduleNow(req.params['id'] ?? '', port)
      .then(() => res.json({ ok: true }))
      .catch((err: unknown) => res.status(400).json({ error: err instanceof Error ? err.message : String(err) }));
  });

  app.get('/api/schedules/notifications', (req, res) => {
    void req;
    res.json({ notifications: listNotifications() });
  });

  // ---- F1 项目（两级结构）----
  app.use('/api/projects', projectRoutes((projectId) => {
    // 成员或负责人调整后停止旧上下文，下一轮重新校验成员身份与项目记忆。
    for (const [taskId, controller] of running) {
      if (getTask(taskId)?.projectId === projectId) {
        controller.abort();
        clearSessionGrants(taskId);
      }
    }
  }));
  app.get('/api/projects', (req, res) => {
    // RL1-03（A-14）：成员端路径脱敏——不下发服务器绝对路径（管理员后台照常；深度可见性收敛随 E06 项目负责人）
    ensureDefaultProject();
    const projects = listProjects().filter((p) => projectVisibleTo((req as AuthedRequest).user, p));
    if ((req as AuthedRequest).user?.role === 'admin') {
      res.json({ projects, defaultProjectId: DEFAULT_PROJECT_ID });
    } else {
      res.json({ projects: projects.map((p) => ({ id: p.id, name: p.name, createdAt: p.createdAt, ownerUserId: p.ownerUserId })), defaultProjectId: DEFAULT_PROJECT_ID });
    }
  });
  app.post('/api/projects', (req, res) => {
    const admin = (req as AuthedRequest).user;
    if (!admin) return res.status(403).json({ error: '未登录' });
    const { name, directory, directorySource } = req.body as { name?: string; directory?: string; directorySource?: string };
    if (typeof name !== 'string' || name.trim() === '') return res.status(400).json({ error: 'name 必填' });
    if (directory !== undefined && (typeof directory !== 'string' || !directory.trim())) return res.status(400).json({ error: '项目目录无效' });
    try {
      if (directorySource !== undefined && directorySource !== 'client' && directorySource !== 'server') return res.status(400).json({ error: '项目目录来源无效' });
      let resolved: string | undefined;
      if (directorySource === 'client' && directory) {
        try { resolved = resolveClientDirectory(directory, workspaceRoot()); }
        catch (error) { return res.status(400).json({ error: error instanceof Error && !('code' in error) && !(error instanceof SyntaxError) ? error.message : '本机目录映射不可用，请联系部署管理员。' }); }
      } else {
        if (process.platform !== 'win32' && directory && /^[a-zA-Z]:[\\/]/.test(directory)) return res.status(400).json({ error: '请选择已连接到后台的本机文件夹。' });
        resolved = directory ? canonicalPath(directory, workspaceRoot()) : undefined;
      }
      if (resolved && !tenantPathAllowed(resolved)) return res.status(400).json({ error: '目录不属于当前账号工作区' });
      if (resolved && !pathWithin(resolved, workspaceRoot()) && process.env['WORKPIVOT_ALLOW_EXTERNAL_DIRECTORIES'] !== '1') return res.status(400).json({ error: '项目目录必须位于工作区内' });
      res.json({ project: createProject(name, resolved, admin.id) });
    } catch { res.status(400).json({ error: '项目目录无法安全解析' }); }
  });
  app.put('/api/projects/:id', (req, res) => {
    const admin = (req as AuthedRequest).user;
    if (!admin) return res.status(403).json({ error: '未登录' });
    const { name } = req.body as { name?: string };
    if (!name || name.trim() === '') return res.status(400).json({ error: 'name 必填' });
    const project = renameProject(req.params['id'] ?? '', name);
    if (!project) return res.status(404).json({ error: '项目不存在' });
    res.json({ project });
  });
  app.delete('/api/projects/:id', (req, res) => {
    const admin = (req as AuthedRequest).user;
    if (!admin) return res.status(403).json({ error: '未登录' });
    if (!getProject(req.params['id'] ?? '')) return res.status(404).json({ error: '项目不存在' });
    const id = req.params['id'] ?? '';
    if (listTasks().some(task => task.projectId === id && running.has(task.id))) return res.status(409).json({ error: '请先停止项目内任务，等待执行结束后再删除' });
    try {
      const taskIds = deleteProjectData(id);
      audit({ user: admin.username, event: 'project_deleted', detail: id });
      res.json({ ok: true, taskIds });
    } catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : '项目删除失败，请重试' }); }
  });

  // T3-01：转写查看器数据源
  app.get('/api/tasks/:id/transcript', (req, res) => {
    const task = getTask(req.params['id'] ?? '');
    if (!task) return res.status(404).json({ error: '任务不存在' });
    if (!taskVisibleTo((req as AuthedRequest).user, task)) return res.status(403).json({ error: '无权访问该任务' });
    res.json({ rows: readTranscript(task.id) });
  });

  // M1-12/A03：任务计划（update_plan 工具落盘，前端打开任务时回显）
  app.get('/api/tasks/:id/plan', (req, res) => {
    const task = getTask(req.params['id'] ?? '');
    if (!task) return res.status(404).json({ error: '任务不存在' });
    if (!taskVisibleTo((req as AuthedRequest).user, task)) return res.status(403).json({ error: '无权访问该任务' });
    res.json({ steps: readPlan(task.id) });
  });

  // 授权卡决策（T2-05）：渲染层回填，唤醒等待中的工具调用
  app.post('/api/tasks/:id/permission', (req, res) => {
    const user = (req as AuthedRequest).user;
    if (!user) return res.status(401).json({ error: '未登录' });
    const task = getTask(req.params['id'] ?? '');
    if (!task) return res.status(404).json({ error: '任务不存在' });
    if (!taskVisibleTo(user, task)) return res.status(403).json({ error: '无权访问该任务' });
    const { id: requestId, decision } = (req.body ?? {}) as { id?: unknown; decision?: unknown };
    if (typeof requestId !== 'string' || requestId.trim() === '') return res.status(400).json({ error: 'id 必须为非空字符串' });
    const result = resolvePendingRequest(requestId, decision, { taskId: task.id, userId: user.id, role: user.role });
    if (result === 'invalid-decision') return res.status(400).json({ error: '决策无效或超出本授权请求允许的范围' });
    if (result === 'forbidden') return res.status(403).json({ error: '授权请求不属于该用户或任务' });
    if (result === 'not-found') return res.status(404).json({ error: '授权请求不存在或已处理' });
    audit({ user: user.username, taskId: task.id, event: 'permission_decision', decision: String(decision), detail: requestId });
    res.json({ ok: true });
  });

  if (opts.webDistDir && existsSync(join(opts.webDistDir, 'index.html'))) {
    app.use(express.static(opts.webDistDir));
    // F3 管理后台页面（静态多页入口）
    const adminHtml = join(opts.webDistDir, 'admin.html');
    app.get('/admin', (_req, res) => {
      if (existsSync(adminHtml)) res.sendFile(adminHtml);
      else res.status(404).send('admin.html 不存在（请重新构建前端）');
    });
    // SPA 回退：非 /api 的 GET 一律回 index.html（Express 5 不再支持 '*' 通配路由）
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api/') || req.path.startsWith('/admin')) return next();
      res.sendFile(join(opts.webDistDir as string, 'index.html'));
    });
  }

  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof DataIntegrityError) {
      audit({ event: 'data_integrity_error', detail: err.message });
      res.status(503).json({ error: err.message });
    } else next(err);
  });
  return app;
}

/** @文件引用（T2-02）：消息中的 @路径 展开为文件内容（上限 32KB/个）。 */
function expandFileRefs(content: string, dir: string, allowed: (path: string, mode: 'read') => boolean): string {
  return content.replace(/(^|\s)@([^\s@]+)/g, (match, prefix: string, rel: string) => {
    try {
      const abs = requireWithin(rel, dir);
      if (!allowed(abs, 'read')) return `${prefix}[文件引用被拒绝：无权访问]`;
      if (!existsSync(abs) || !statSync(abs).isFile()) return match;
      const text = readFileSync(abs, 'utf8');
      const capped = text.length > 32_000 ? `${text.slice(0, 32_000)}…（截断）` : text;
      return `${prefix}\n\n--- 引用文件 ${rel} ---\n${capped}\n--- 引用结束 ---`;
    } catch {
      return `${prefix}[文件引用被拒绝：路径越界或无法安全读取]`;
    }
  });
}

function buildSystemPrompt(taskDirectory: string, tier: Tier): string {
  return [
    `你是 WorkPivot，一个通过后台服务处理用户任务的智能助手。文件操作针对后台任务目录。`,
    ``,
    `# 工作目录`,
    `当前任务绑定的工作目录：${taskDirectory}`,
    `文件操作只能在该目录内进行；访问界外路径会向用户发起授权请求，被拒绝时不要重试同一路径。`,
    `当前权限档位：${TIER_LABELS[tier]}。`,
    ``,
    `# 工具使用纪律`,
    `- 先读后改：修改文件前必须先用 read 工具阅读原文件。`,
    `- 仅使用本次提供的工具。专用工具优先：读文件用 read，写文件用 write，列目录用 ls，搜内容用 grep，找文件用 find；仅当提供 bash 工具时才能运行命令。`,
    `- 交付文件命名遵循"{标题} v{X.Y} {日期}.{格式}"，不覆盖旧版本。`,
    `- 同一次回复里相互独立的工具调用应尽量并行发起。`,
    ``,
    `# 输出纪律`,
    `- 用中文回复；结论先行，简明扼要。`,
    `- 引用文件时给出相对路径。`,
  ].join('\n');
}
