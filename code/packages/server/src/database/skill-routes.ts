import express, { Router } from 'express';
import { DatabaseSkills } from './skills.js';
import { RepositoryError } from './connection.js';
import { packageText } from '../skill-package-store.js';

export function databaseSkillRoutes(skills: DatabaseSkills): Router {
  const router = Router();
  router.use((_req, res, next) => { if (res.locals['user']?.role !== 'admin') throw new RepositoryError(403, '仅管理员可管理技能包'); next(); });
  const name = (v: unknown) => { if (typeof v !== 'string') throw new RepositoryError(400, '文本参数无效'); return v; };
  router.get('/', async (_req, res) => { res.json({ packages: await skills.list(res.locals['user'].id) }); });
  router.post('/', async (req, res) => { res.json(await skills.create(res.locals['user'].id, name(req.body?.name))); });
  router.post('/:name/open', async (req, res) => { res.json(await skills.open(res.locals['user'].id, name(req.params['name']))); });
  router.get('/:name', async (req, res) => { res.json(await skills.open(res.locals['user'].id, name(req.params['name']))); });
  router.get('/:name/file', async (req, res) => { const path = name(req.query['path']); const bytes = await skills.file(res.locals['user'].id, name(req.params['name']), path); res.json({ path, content: packageText(bytes), size: bytes.length }); });
  router.get('/:name/download', async (req, res) => { const path = name(req.query['path']); const bytes = await skills.file(res.locals['user'].id, name(req.params['name']), path, req.query['version'] === undefined ? undefined : name(req.query['version'])); res.setHeader('X-Content-Type-Options', 'nosniff'); res.attachment(path.split('/').at(-1)!).type('application/octet-stream').send(bytes); });
  router.put('/:name/file', async (req, res) => { const content = name(req.body?.content); if (Buffer.byteLength(content) > 256 * 1024) throw new RepositoryError(400, '文本最多256KiB'); res.json(await skills.save(res.locals['user'].id, name(req.params['name']), name(req.body?.path), Buffer.from(content), req.body?.revision)); });
  router.put('/:name/upload', express.raw({ type: 'application/octet-stream', limit: '8mb' }), async (req, res) => { if (!Buffer.isBuffer(req.body)) throw new RepositoryError(400, '请上传二进制文件'); res.json(await skills.save(res.locals['user'].id, name(req.params['name']), name(req.query['path']), req.body, req.query['revision'])); });
  router.delete('/:name/file', async (req, res) => { res.json(await skills.save(res.locals['user'].id, name(req.params['name']), name(req.query['path']), null, req.body?.revision)); });
  router.post('/:name/directory', async (req, res) => { res.json(await skills.directory(res.locals['user'].id, name(req.params['name']), name(req.body?.path), req.body?.revision, false)); });
  router.delete('/:name/directory', async (req, res) => { res.json(await skills.directory(res.locals['user'].id, name(req.params['name']), name(req.query['path']), req.body?.revision, true)); });
  router.post('/:name/import', express.raw({ type: 'application/octet-stream', limit: '16mb' }), async (req, res) => { if (!Buffer.isBuffer(req.body)) throw new RepositoryError(400, '请上传ZIP'); res.json(await skills.import(res.locals['user'].id, name(req.params['name']), req.body, req.query['revision'])); });
  router.get('/:name/export', async (req, res) => { const bytes = await skills.export(res.locals['user'].id, name(req.params['name']), req.query['version'] === undefined ? undefined : name(req.query['version'])); res.setHeader('X-Content-Type-Options', 'nosniff'); res.attachment('skill.zip').send(bytes); });
  router.post('/:name/validate', async (req, res) => { res.json(await skills.validate(res.locals['user'].id, name(req.params['name']))); });
  router.post('/:name/publish', async (req, res) => { res.json(await skills.publish(res.locals['user'].id, name(req.params['name']), req.body?.revision)); });
  router.post('/:name/rollback', async (req, res) => { res.json(await skills.rollback(res.locals['user'].id, name(req.params['name']), name(req.body?.version), req.body?.revision)); });
  router.post('/:name/discard', async (req, res) => { res.json(await skills.rollback(res.locals['user'].id, name(req.params['name']), '', req.body?.revision, true)); });
  router.post('/:name/toggle', async (req, res) => { if (typeof req.body?.disabled !== 'boolean') throw new RepositoryError(400, '启停状态无效'); await skills.toggle(res.locals['user'].id, name(req.params['name']), req.body.disabled); res.json({ ok: true }); });
  router.use((error: Error & { status?: number }, _req: express.Request, res: express.Response, next: express.NextFunction) => { if (error.status && [400, 403, 404, 409, 413].includes(error.status)) res.status(error.status).json({ error: error.message }); else next(error); });
  return router;
}
