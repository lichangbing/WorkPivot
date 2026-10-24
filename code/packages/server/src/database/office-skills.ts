import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { copyPackageFiles, decodePackageZip } from '../skill-package-store.js';
import { DatabaseSkills } from './skills.js';

export const officeSkillNames = ['office-routing', 'docx-report', 'xlsx-report', 'pptx-report'] as const;
/** 非 Office 的内置技能（R001 多空辩论）：与 Office 技能同一套打包/发布流程。 */
export const builtinSkillNames = [...officeSkillNames, 'bull-bear-debate'] as const;
export type BuiltinSkillName = typeof builtinSkillNames[number];

/** 每个技能独立打包全部资源，避免只发布入口却缺失参考资料或脚本。 */
export function officeSkillArchive(name: BuiltinSkillName, directory = fileURLToPath(new URL('../../skills/', import.meta.url))) {
  const files = copyPackageFiles(join(directory, name));
  const archive = new AdmZip();
  for (const [path, bytes] of Object.entries(files)) archive.addFile(path, Buffer.from(bytes, 'base64'));
  return archive.toBuffer();
}

/** 显式安装缺失项；已有技能仅在指定时暂存更新，绝不隐式发布或加载新版。 */
export async function seedOfficeSkills(skills: DatabaseSkills, actor: string, stageUpdates = false) {
  return seedBuiltinSkills(skills, actor, stageUpdates);
}

/** 发布全部内置技能（Office + 其他），幂等且保留已有草稿/版本。 */
export async function seedBuiltinSkills(skills: DatabaseSkills, actor: string, stageUpdates = false) {
  const existing = await skills.list(actor);
  const results: { name: string; status: string }[] = [];
  for (const name of builtinSkillNames) {
    const found = existing.find(s => s.name === name);
    if (found && (!stageUpdates || found.dirty)) {
      results.push({ name, status: found.dirty ? '保留已有草稿' : '保留已有发布版本' }); continue;
    }
    const archive = officeSkillArchive(name);
    const draft = found ? await skills.open(actor, name) : await skills.create(actor, name);
    // 列表读取后可能有人编辑；重新检查当前草稿，后续导入仍受revision保护。
    if (found && draft.dirty) { results.push({ name, status: '保留已有草稿' }); continue; }
    if (found) {
      const before = decodePackageZip(name, await skills.export(actor, name)).files;
      const after = decodePackageZip(name, archive).files;
      if (Object.keys(before).length === Object.keys(after).length && Object.keys(after).every(path => before[path] === after[path])) {
        results.push({ name, status: '资源已是当前版本' }); continue;
      }
    }
    const staged = await skills.import(actor, name, archive, draft.revision);
    if (!found) {
      await skills.publish(actor, name, staged.revision);
      results.push({ name, status: '已发布新技能，未自动加载' });
    } else results.push({ name, status: '已暂存更新，请在技能管理中审阅并发布' });
  }
  return results;
}
