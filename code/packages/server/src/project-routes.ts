/** RL1-08：项目成员治理与项目记忆接口。全员认证由 app 的 /api 中间件保证。 */
import { Router, type Request } from 'express';
import type { PublicUser } from './auth.js';
import { getProject, projectVisibleTo, projectMemoryEditableBy } from './projects.js';
import { readProjectMemory, writeProjectMemory } from './memory.js';
import { audit } from './audit.js';
import { taskFilePolicy } from './file-policy.js';
import { join } from 'node:path';

type AuthRequest = Request<{ id: string }> & { user?: PublicUser };

export function projectRoutes(onAccessChanged?: (projectId: string) => void): Router {
  const router = Router();
  // 个人工作区模型中项目归属不可变。
  void onAccessChanged;
  router.put('/:id/access', (_req, res) => { res.status(403).json({ error: '个人项目不能分配给其他账号' }); });
  router.get('/:id/memory', (req: AuthRequest, res) => {
    const project = getProject(req.params['id'] ?? '');
    if (!project || !projectVisibleTo(req.user, project)) return res.status(404).json({ error: '项目不存在或不可访问' });
    if (!taskFilePolicy({ id: project.id, projectId: project.id, directory: project.directory }, req.user!.id)(join(project.directory, '.workpivot/memory/MEMORY.md'), 'read')) return res.status(403).json({ error: '记忆文件路径不可访问' });
    res.json({ projectId: project.id, content: readProjectMemory(project.directory), canEdit: projectMemoryEditableBy(req.user, project) });
  });
  for (const method of ['put', 'delete'] as const) {
    router[method]('/:id/memory', (req: AuthRequest, res) => {
      const project = getProject(req.params['id'] ?? '');
      if (!project || !projectVisibleTo(req.user, project)) return res.status(404).json({ error: '项目不存在或不可访问' });
      if (!projectMemoryEditableBy(req.user, project)) return res.status(403).json({ error: '仅本人可修改项目记忆' });
      if (!taskFilePolicy({ id: project.id, projectId: project.id, directory: project.directory }, req.user!.id)(join(project.directory, '.workpivot/memory/MEMORY.md'), 'write')) return res.status(403).json({ error: '记忆文件路径不可修改' });
      const content: unknown = method === 'delete' ? '' : req.body?.content;
      if (typeof content !== 'string' || content.length > 20_000) return res.status(400).json({ error: '项目记忆必须为不超过 20000 字符的文本' });
      // 清空也保留一代备份，不删除用户项目文件目录。
      writeProjectMemory(project.directory, content);
      audit({ user: req.user?.username, event: method === 'delete' ? 'project_memory_cleared' : 'project_memory_edited', detail: JSON.stringify({ projectId: project.id, length: content.length }) });
      res.json({ ok: true });
    });
  }
  return router;
}
