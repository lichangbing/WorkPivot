import express, { Router, type Request } from 'express';
import { audit } from './audit.js';
import { disabledSkills, listSkills, setSkillDisabled } from './skills.js';
import { workspaceRoot } from './tasks.js';
import { createPackageDirectory, deletePackageDirectory } from './skill-package-store.js';
import { createPackage, discardPackageDraft, exportPackageZip, importPackageZip, managedPackageNames, openPackage, packageDetail, packageError, packageFile, packageText, publishPackage, rollbackPackage, savePackageFile, validatePackage } from './skill-package-store.js';

export function skillPackageRoutes(): Router {
  const router = Router();
  router.use((req, res, next) => {
    if ((req as Request & { user?: { role: string } }).user?.role !== 'admin') { res.status(403).json({ error: '仅管理员可管理技能包' }); return; }
    next();
  });
  const known = () => listSkills(workspaceRoot(), { includeDisabled: true });
  const available = () => listSkills(workspaceRoot()).map(skill => skill.name);
  const log = (req: Request, event: string) => audit({ user: (req as Request & { user?: { username: string } }).user?.username, event, tool: String(req.params['name'] ?? '') });
  router.get('/', (_req, res) => {
    const skills = known(); const managed = managedPackageNames();
    res.json({ packages: [...new Set([...skills.map(s => s.name), ...managed])].map(name => {
      const skill = skills.find(s => s.name === name); const detail = managed.includes(name) ? packageDetail(name) : null;
      return { name, description: skill?.description ?? '尚未发布', source: skill?.source ?? 'global', disabled: disabledSkills().includes(name), managed: Boolean(detail), dirty: detail?.dirty ?? false, published: detail?.published ?? null, hasPublished: detail ? Boolean(detail.published) : true };
    }) });
  });
  router.post('/', (req, res) => {
    const name = req.body?.name as string;
    if (known().some(s => s.name === name)) throw packageError('同名技能已存在', 409);
    const result = createPackage(name); log(req, 'skill_package_created'); res.json(result);
  });
  router.post('/:name/open', (req, res) => {
    const name = req.params['name']!; const skill = known().find(s => s.name === name);
    if (skill?.source === 'project') throw packageError('请先将项目技能作为独立技能包导入，避免覆盖项目文件');
    res.json(openPackage(name, skill));
  });
  router.get('/:name', (req, res) => res.json(packageDetail(req.params['name']!)));
  router.post('/:name/directory', (req, res) => {
    const result = createPackageDirectory(req.params['name']!, req.body?.path, req.body?.revision); log(req, 'skill_directory_created'); res.json(result);
  });
  router.delete('/:name/directory', (req, res) => {
    const result = deletePackageDirectory(req.params['name']!, String(req.query['path'] ?? ''), req.body?.revision); log(req, 'skill_directory_deleted'); res.json(result);
  });
  router.get('/:name/file', (req, res) => {
    const path = String(req.query['path'] ?? ''); const bytes = packageFile(req.params['name']!, path);
    res.json({ path, content: packageText(bytes), size: bytes.length });
  });
  router.get('/:name/download', (req, res) => {
    const path = String(req.query['path'] ?? ''); const version = typeof req.query['version'] === 'string' ? req.query['version'] : undefined;
    const bytes = packageFile(req.params['name']!, path, version);
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.attachment(path.split('/').at(-1)!); res.type('application/octet-stream').send(bytes);
  });
  router.put('/:name/file', (req, res) => {
    const { path, content, revision } = req.body as { path: string; content: unknown; revision: unknown };
    if (typeof content !== 'string' || Buffer.byteLength(content) > 256 * 1024) throw packageError('文本最多256KiB');
    const result = savePackageFile(req.params['name']!, path, Buffer.from(content), revision); log(req, 'skill_draft_saved'); res.json(result);
  });
  router.put('/:name/upload', express.raw({ type: 'application/octet-stream', limit: '8mb' }), (req, res) => {
    if (!Buffer.isBuffer(req.body)) throw packageError('请上传二进制文件');
    const result = savePackageFile(req.params['name']!, String(req.query['path'] ?? ''), req.body, req.query['revision']); log(req, 'skill_resource_uploaded'); res.json(result);
  });
  router.delete('/:name/file', (req, res) => {
    const result = savePackageFile(req.params['name']!, String(req.query['path'] ?? ''), null, req.body?.revision); log(req, 'skill_draft_file_deleted'); res.json(result);
  });
  router.post('/:name/import', express.raw({ type: 'application/octet-stream', limit: '16mb' }), (req, res) => {
    if (!Buffer.isBuffer(req.body)) throw packageError('请上传 ZIP 文件');
    const result = importPackageZip(req.params['name']!, req.body, req.query['revision']); log(req, 'skill_package_imported'); res.json(result);
  });
  router.get('/:name/export', (req, res) => {
    const version = typeof req.query['version'] === 'string' ? req.query['version'] : undefined;
    res.attachment(`${req.params['name']}-${version ? 'version' : 'draft'}.zip`).send(exportPackageZip(req.params['name']!, version));
  });
  router.post('/:name/validate', (req, res) => res.json(validatePackage(req.params['name']!, available())));
  router.post('/:name/publish', (req, res) => {
    const result = publishPackage(req.params['name']!, req.body?.revision, available()); log(req, 'skill_package_published'); res.json(result);
  });
  router.post('/:name/rollback', (req, res) => {
    if (typeof req.body?.version !== 'string') throw packageError('请选择版本');
    const result = rollbackPackage(req.params['name']!, req.body.version, req.body.revision); log(req, 'skill_package_rolled_back'); res.json(result);
  });
  router.post('/:name/discard', (req, res) => {
    const result = discardPackageDraft(req.params['name']!, req.body?.revision); log(req, 'skill_draft_restored'); res.json(result);
  });
  router.post('/:name/toggle', (req, res) => {
    if (!known().some(s => s.name === req.params['name']) && !managedPackageNames().includes(req.params['name']!)) throw packageError('技能不存在', 404);
    if (typeof req.body?.disabled !== 'boolean') throw packageError('启停状态无效');
    setSkillDisabled(req.params['name']!, req.body.disabled); log(req, 'skill_toggled'); res.json({ ok: true });
  });
  router.use((error: Error & { status?: number }, _req: Request, res: express.Response, next: express.NextFunction) => {
    if (!error.status) { next(error); return; }
    res.status(error.status).json({ error: error.status === 413 ? '上传内容超过大小限制' : error.message });
  });
  return router;
}
