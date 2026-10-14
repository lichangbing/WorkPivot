/** Local WSL integration fixture: real PostgreSQL/auth/files, deterministic model, no external tools. */
import { pool, installSchema } from '../packages/server/src/database/connection.js';
import { FileRepository } from '../packages/server/src/database/files.js';
import { DatabaseExecution } from '../packages/server/src/database/execution.js';
import { createDatabaseApp } from '../packages/server/src/database/app.js';
if (process.env.WORKPIVOT_ATTACHMENT_FIXTURE !== '1') throw Error('Fixture only');
const admin = pool(process.env.WORKPIVOT_DATABASE_ADMIN_URL!);
await installSchema(admin, 'workpivot_app', 'workpivot_auth'); await admin.end();
const db = pool(process.env.WORKPIVOT_DATABASE_URL!), auth = pool(process.env.WORKPIVOT_AUTH_DATABASE_URL!);
const init = 'workpivot-local-attachment-integration-only';
const execution = new DatabaseExecution(db, async () => ({ taskDir: '.', tools: [], system: '本机附件联调，不能读取附件。', client: { providerId: 'local-fixture', model: 'fixture', async *streamChat() {
  yield { type: 'delta' as const, text: '联调回复：消息已持久化。附件原件已保存，内容解析尚未接入。' };
} } }));
const app = await createDatabaseApp(auth, db, init, execution, undefined, undefined, '/app/apps/web/dist', new FileRepository(db, '/data/workpivot/files'));
const server = app.listen(39800, '0.0.0.0', () => console.log('WSL attachment fixture ready; deterministic model; no external model calls'));
process.on('SIGTERM', () => { server.closeAllConnections(); server.close(() => { void Promise.all([db.end(), auth.end()]); }); });
