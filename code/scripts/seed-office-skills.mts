import { readFile } from 'node:fs/promises';
import { pool } from '../packages/server/src/database/connection.js';
import { DatabaseSkills } from '../packages/server/src/database/skills.js';

// Explicit deployment step: preserve existing drafts, releases and user selections.
const db = pool(process.env.WORKPIVOT_DATABASE_URL!);
const auth = pool(process.env.WORKPIVOT_AUTH_DATABASE_URL!);
try {
  const admins = (await auth.query("SELECT id,username FROM identity.users WHERE role='admin' AND NOT disabled ORDER BY username")).rows;
  const admin = process.env.WORKPIVOT_SKILL_ADMIN ? admins.find(a => a.username === process.env.WORKPIVOT_SKILL_ADMIN) : admins.length === 1 ? admins[0] : admins.find(a => a.username === 'admin');
  if (!admin) throw Error('请明确指定技能管理员 WORKPIVOT_SKILL_ADMIN');
  const skills = new DatabaseSkills(db);
  const existing = await skills.list(admin.id);
  for (const name of ['docx-report', 'xlsx-report', 'pptx-report']) {
    if (existing.some(s => s.name === name)) { console.log(`${name}: preserved`); continue; }
    const source = await readFile(new URL(`../packages/server/skills/${name}/SKILL.md`, import.meta.url));
    let draft = await skills.create(admin.id, name);
    draft = await skills.save(admin.id, name, 'SKILL.md', source, draft.revision);
    await skills.publish(admin.id, name, draft.revision);
    console.log(`${name}: published`);
  }
  console.log(JSON.stringify((await skills.market(admin.id)).map(s => ({ name: s.name, loaded: s.loaded }))));
} finally { await db.end(); await auth.end(); }
