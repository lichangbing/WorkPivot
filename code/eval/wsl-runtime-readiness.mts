import { pool, transaction } from '../packages/server/src/database/connection.js';
const auth = pool(process.env.WORKPIVOT_AUTH_DATABASE_URL!), db = pool(process.env.WORKPIVOT_DATABASE_URL!);
try {
  const users = (await auth.query('SELECT id FROM identity.users WHERE NOT disabled')).rows;
  const counts = [];
  for (const user of users) counts.push(await transaction(db, async c => ({
    activeModels: Number((await c.query('SELECT count(*) FROM workpivot.model_providers WHERE active')).rows[0].count),
    loadedSkills: Number((await c.query('SELECT count(*) FROM workpivot.skill_selections s JOIN workpivot.skill_catalog c ON c.name=s.name WHERE NOT c.disabled')).rows[0].count),
  }), user.id));
  console.log(JSON.stringify({ users: users.length, configuredUsers: counts.filter(c => c.activeModels > 0).length, readyUsers: counts.filter(c => c.activeModels > 0 && c.loadedSkills > 0).length }));
} finally { await Promise.all([auth.end(),db.end()]); }
