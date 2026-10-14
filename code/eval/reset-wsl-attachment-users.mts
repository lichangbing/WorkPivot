/** Explicit reset for the named local attachment fixture only. */
import { pool } from '../packages/server/src/database/connection.js';
import { FileRepository } from '../packages/server/src/database/files.js';
if (process.env.WORKPIVOT_ATTACHMENT_FIXTURE !== '1' || new URL(process.env.WORKPIVOT_DATABASE_ADMIN_URL!).hostname !== 'workpivot-attachment-e2e-db') throw Error('Not the local attachment fixture');
const admin = pool(process.env.WORKPIVOT_DATABASE_ADMIN_URL!), db = pool(process.env.WORKPIVOT_DATABASE_URL!);
try {
  const users = (await admin.query('SELECT id FROM identity.users')).rows;
  const active = (await admin.query("SELECT count(*)::int AS n FROM workpivot.task_runs WHERE status IN ('running','stopping') AND lease_until>now()")).rows[0].n;
  if (active) throw Error('Active test run; stop it before clearing users');
  await admin.query('TRUNCATE identity.users CASCADE');
  const files = new FileRepository(db, '/data/workpivot/files');
  for (const user of users) await files.collect(user.id);
  const remaining = (await admin.query('SELECT count(*)::int AS n FROM identity.users')).rows[0].n;
  console.log(JSON.stringify({ removedUsers: users.length, remainingUsers: remaining }));
} finally { await Promise.all([admin.end(), db.end()]); }
