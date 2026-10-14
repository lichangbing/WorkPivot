/** WSL integration entry with real configured models and durable encrypted configuration. */
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../packages/server/src/database/connection.js';
import { createDatabaseRuntime } from '../packages/server/src/database/runtime.js';
if (process.env.WORKPIVOT_ATTACHMENT_FIXTURE !== '1') throw Error('WSL integration only');
// The protected key lives in the existing persistent service volume and is never printed.
const keyPath = '/data/workpivot/database-secret.key';
try { await writeFile(keyPath, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
const secretKey = (await readFile(keyPath, 'utf8')).trim();
const db = pool(process.env.WORKPIVOT_DATABASE_URL!), auth = pool(process.env.WORKPIVOT_AUTH_DATABASE_URL!);
let worker: { url: string; token: string } | undefined;
try { worker = JSON.parse(await readFile('/data/workpivot/worker.json','utf8')); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
const app = await createDatabaseRuntime(auth, db, { initToken: 'workpivot-local-attachment-integration-only', secretKey, filesRoot: '/data/workpivot/files', webDist: '/app/apps/web/dist', worker });
const server = app.listen(39800, '0.0.0.0', () => console.log('WSL PostgreSQL runtime ready; real model configuration required'));
process.on('SIGTERM', () => { app.locals['stopMemoryWorker']?.(); server.closeAllConnections(); server.close(() => { void Promise.all([db.end(), auth.end()]); }); });
