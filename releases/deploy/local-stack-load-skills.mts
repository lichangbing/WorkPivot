import { pool } from '/app/packages/server/src/database/connection.js';
import { DatabaseSkills } from '/app/packages/server/src/database/skills.js';

/** 为第一个管理员加载内置 Office 技能；由 install-local-stack.sh 注入容器执行。 */
export const officeSkillNames = ['office-routing', 'docx-report', 'xlsx-report', 'pptx-report', 'bull-bear-debate'];

const db = pool(process.env.WORKPIVOT_DATABASE_URL ?? '');
const auth = pool(process.env.WORKPIVOT_AUTH_DATABASE_URL ?? '');
try {
  const admin = (await auth.query("SELECT id,username FROM identity.users WHERE role='admin' AND NOT disabled ORDER BY username LIMIT 1")).rows[0];
  if (!admin) {
    console.log('SKIP 没有管理员账号，登录后重新运行安装器即可加载技能');
  } else {
    const skills = new DatabaseSkills(db);
    for (const name of officeSkillNames) {
      try { await skills.select(admin.id, name, true); } catch { /* 技能未发布时跳过，不影响安装 */ }
    }
    const market = await skills.market(admin.id);
    console.log('管理员:', admin.username);
    for (const s of market) console.log(`  ${s.name}  已加载=${s.loaded}`);
  }
} finally {
  await db.end();
  await auth.end();
}
