import { Router, type Request, type Response, type NextFunction } from 'express';
import { deleteMcp, listMcp, saveMcp, testMcp, toggleMcp, toggleMcpTool } from './mcp.js';
import { audit } from './audit.js';
export function mcpRoutes(): Router {
  const router = Router();
  router.use((req, res, next) => { if ((req as Request & { user?: { role: string } }).user?.role !== 'admin') { res.status(403).json({ error: '仅管理员可配置 MCP' }); return; } next(); });
  const log = (req: Request, event: string) => audit({ user: (req as Request & { user?: { username: string } }).user?.username, event, tool: String(req.params['id'] ?? '') });
  router.get('/', (_req, res) => res.json({ connections: listMcp() }));
  router.post('/', (req, res) => { const value = saveMcp({ name: req.body?.name, url: req.body?.url, token: req.body?.token }); log(req, 'mcp_created'); res.json(value); });
  router.put('/:id', (req, res) => { const value = saveMcp({ id: req.params['id']!, revision: req.body?.revision, name: req.body?.name, url: req.body?.url, token: req.body?.token, clearToken: req.body?.clearToken }); log(req, 'mcp_updated'); res.json(value); });
  router.post('/:id/test', async (req, res) => { const value = await testMcp(req.params['id']!, req.body?.revision); log(req, 'mcp_tested'); res.json(value); });
  router.post('/:id/toggle', (req, res) => { const value = toggleMcp(req.params['id']!, req.body?.enabled, req.body?.revision); log(req, 'mcp_toggled'); res.json(value); });
  router.post('/:id/tools/toggle', (req, res) => { const value = toggleMcpTool(req.params['id']!, req.body?.name, req.body?.enabled, req.body?.revision); log(req, 'mcp_tool_toggled'); res.json(value); });
  router.delete('/:id', (req, res) => { const value = deleteMcp(req.params['id']!, req.body?.revision); log(req, 'mcp_deleted'); res.json(value); });
  router.use((error: Error & { status?: number }, _req: Request, res: Response, next: NextFunction) => { if (!error.status) { next(error); return; } res.status(error.status).json({ error: error.message }); });
  return router;
}
