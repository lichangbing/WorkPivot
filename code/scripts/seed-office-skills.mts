import { pool } from '../packages/server/src/database/connection.js';
import { DatabaseSkills } from '../packages/server/src/database/skills.js';
import { seedBuiltinSkills } from '../packages/server/src/database/office-skills.js';

// 显式部署步骤：保留已有草稿、发布版本及用户选择；含 Office 技能与多空辩论。
const db = pool(process.env.WORKPIVOT_DATABASE_URL!);
const auth = pool(process.env.WORKPIVOT_AUTH_DATABASE_URL!);
try {
  const admins = (await auth.query("SELECT id,username FROM identity.users WHERE role='admin' AND NOT disabled ORDER BY username")).rows;
  const admin = process.env.WORKPIVOT_SKILL_ADMIN ? admins.find(a => a.username === process.env.WORKPIVOT_SKILL_ADMIN) : admins.length === 1 ? admins[0] : admins.find(a => a.username === 'admin');
  if (!admin) throw Error('请明确指定技能管理员 WORKPIVOT_SKILL_ADMIN');
  const skills = new DatabaseSkills(db);
  for (const result of await seedBuiltinSkills(skills, admin.id, process.argv.includes('--stage-updates'))) console.log(`${result.name}: ${result.status}`);
  console.log(JSON.stringify((await skills.market(admin.id)).map(s => ({ name: s.name, loaded: s.loaded }))));
} finally { await db.end(); await auth.end(); }
