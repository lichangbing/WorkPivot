import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Router, type Request, type Response, type NextFunction } from 'express';
import type { PublicUser } from './auth.js';
import { ensureWorkpivotDir, readJsonSafe, writeAtomicWithBackup } from './store.js';
import { tenantId, withTenant } from './tenants.js';
import { getTask } from './tasks.js';
import { getProject, projectMemoryEditableBy } from './projects.js';
import { memoryEnabled, setMemoryEnabled, readHandbook, writeHandbook, readProjectMemory, writeProjectMemory, listEntries } from './memory.js';
import { cancelMemoryRequests } from './memory-tools.js';
import { audit } from './audit.js';

interface RoleMemory { id: string; name: string; content: string; enabled: boolean }
interface Catalog { revision: string; defaultId: string | null; templates: RoleMemory[] }
const seeds: Catalog = { revision: 'initial', defaultId: null, templates: [
  { id: 'researcher', name: '研究员', enabled: true, content: '区分事实、推断和观点。标注资料来源与日期，交叉核对关键结论。先说明研究问题，再展示证据、结论和不确定性。' },
  { id: 'project-owner', name: '项目负责人', enabled: true, content: '明确项目目标、范围、里程碑和验收标准。跟踪任务负责人、依赖和风险，说明当前进度、阻塞与下一步。不把未经确认的安排当成既定事实。' },
  { id: 'finance', name: '财务', enabled: true, content: '核对币种、单位、会计期间和统计口径。区分实际、预算与预测，保持计算可追溯。缺失数据明确标注，不编造金额或凭证。' },
] };
const revision = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (message: string, status = 400): never => { throw Object.assign(Error(message), { status }); };
// Only deliberately public role templates live at tenant level, never personal memories.
export function memoryCatalog(): Catalog { return withTenant(tenantId(), () => readJsonSafe<Catalog>(join(ensureWorkpivotDir('config'), 'memory-roles.json'), seeds).value); }
function saveCatalog(input: Catalog) {
  if (!input || typeof input !== 'object') fail('模板格式无效');
  const old = memoryCatalog();
  if (input.revision !== old.revision) fail('模板已改变，请刷新后编辑', 409);
  if (!Array.isArray(input.templates) || input.templates.length > 50) fail('最多50个模板');
  const ids = new Set<string>();
  for (const t of input.templates) {
    if (!t || typeof t.id !== 'string' || t.id === 'default' || !/^[a-zA-Z0-9-]{1,64}$/.test(t.id) || ids.has(t.id) || typeof t.name !== 'string' || !t.name.trim() || t.name.length > 80 || typeof t.content !== 'string' || t.content.length > 20000 || typeof t.enabled !== 'boolean') fail('模板格式无效');
    ids.add(t.id);
  }
  if (input.defaultId !== null && !input.templates.some(t => t.id === input.defaultId && t.enabled)) fail('默认模板必须存在且启用');
  const value = { revision: randomUUID(), defaultId: input.defaultId, templates: input.templates.map(t => ({ id: t.id, name: t.name.trim(), content: t.content, enabled: t.enabled })) };
  withTenant(tenantId(), () => writeAtomicWithBackup(join(ensureWorkpivotDir('config'), 'memory-roles.json'), JSON.stringify(value)));
  return value;
}
function preferences() { return readJsonSafe<{ roleId?: string | null }>(join(ensureWorkpivotDir('config'), 'memory-selection.json'), {}).value; }
export function memorySelection() {
  const prefs = preferences(), catalog = memoryCatalog();
  return { autoLoad: memoryEnabled(), roleId: prefs.roleId === undefined ? 'default' : prefs.roleId ?? '', effectiveRole: catalog.templates.find(t => t.enabled && t.id === (prefs.roleId === undefined ? catalog.defaultId : prefs.roleId)) ?? null, revision: revision([prefs, memoryEnabled()]) };
}
function taskMemory(taskId: string): string { if (!getTask(taskId)) fail('任务不存在', 404); return readJsonSafe<{ content: string }>(join(ensureWorkpivotDir('data', 'tasks', taskId), 'memory.json'), { content: '' }).value.content; }
export function renderAdditionalMemory(taskId: string): string {
  if (!memoryEnabled()) return '';
  const task = taskMemory(taskId), role = memorySelection().effectiveRole;
  return [role ? `\n# 角色参考记忆：${role.name}\n${role.content}` : '', task.trim() ? `\n# 当前任务记忆\n${task}` : ''].join('');
}
export function memoryLayerRoutes(): Router {
  const router = Router();
  const user = (req: Request) => (req as Request & { user: PublicUser }).user;
  const context = (req: Request) => {
    const id = req.query['taskId'];
    if (id !== undefined && typeof id !== 'string') fail('任务标识无效');
    const task = typeof id === 'string' && id ? getTask(id) : null;
    if (id && (!task || task.ownerUserId !== user(req).id)) fail('任务不存在', 404);
    const project = task?.projectId && !task.temp ? getProject(task.projectId) : null;
    return { task, project };
  };
  const view = (req: Request) => {
    const { task, project } = context(req);
    const contents = { task: task ? taskMemory(task.id) : '', project: project ? readProjectMemory(project.directory) : '', personal: readHandbook(user(req).id) };
    return { layers: Object.entries(contents).map(([id, content]) => ({ id, content, revision: revision(content), editable: id === 'personal' || (id === 'task' ? Boolean(task) : Boolean(project && projectMemoryEditableBy(user(req), project))) })), entries: listEntries(user(req).id), selection: memorySelection(), catalog: memoryCatalog() };
  };
  router.get('/', (req, res) => res.json(view(req)));
  router.put('/:layer', (req, res) => {
    const layer = req.params['layer']; const current = view(req).layers.find(l => l.id === layer);
    if (!current || !current.editable) fail('当前记忆不可编辑', 403);
    if (req.body?.revision !== current!.revision) fail('记忆已改变，请刷新后编辑', 409);
    const content = req.body?.content; if (typeof content !== 'string' || content.length > 20000) fail('记忆最多20000字符');
    const { task, project } = context(req);
    if (layer === 'personal') writeHandbook(user(req).id, content);
    else if (layer === 'project') writeProjectMemory(project!.directory, content);
    else writeAtomicWithBackup(join(ensureWorkpivotDir('data', 'tasks', task!.id), 'memory.json'), JSON.stringify({ content }));
    audit({ user: user(req).username, event: 'memory_layer_updated', taskId: task?.id, detail: String(layer) });
    res.json(view(req));
  });
  router.post('/selection', (req, res) => {
    const current = memorySelection(); if (req.body?.revision !== current.revision) fail('加载设置已改变，请刷新', 409);
    const { roleId, autoLoad } = req.body;
    if (typeof autoLoad !== 'boolean' || typeof roleId !== 'string' || (roleId !== current.roleId && roleId !== '' && roleId !== 'default' && !memoryCatalog().templates.some(t => t.id === roleId && t.enabled))) fail('加载设置无效');
    writeAtomicWithBackup(join(ensureWorkpivotDir('config'), 'memory-selection.json'), JSON.stringify(roleId === 'default' ? {} : { roleId: roleId || null }));
    setMemoryEnabled(autoLoad); if (!autoLoad) cancelMemoryRequests();
    audit({ user: user(req).username, event: 'memory_selection_updated' }); res.json(memorySelection());
  });
  router.get('/templates', (req, res) => { if (user(req).role !== 'admin') fail('仅管理员可管理默认记忆', 403); res.json(memoryCatalog()); });
  router.post('/templates', (req, res) => { if (user(req).role !== 'admin') fail('仅管理员可管理默认记忆', 403); const value = saveCatalog(req.body); audit({ user: user(req).username, event: 'memory_templates_updated' }); res.json(value); });
  router.use((error: Error & { status?: number }, _req: Request, res: Response, next: NextFunction) => {
    if (error.status && error.status >= 400 && error.status < 500) { res.status(error.status).json({ error: error.message }); return; }
    next(error);
  });
  return router;
}
