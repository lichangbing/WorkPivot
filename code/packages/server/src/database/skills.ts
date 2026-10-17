import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { Tool } from '@workpivot/core';
import AdmZip from 'adm-zip';
import { transaction, RepositoryError } from './connection.js';
import { validSkillName, validPackagePath, checkFiles, packageDirectories, packageText, instructionFields, validatePackageState, decodePackageZip, type Files } from '../skill-package-store.js';

interface Draft { name: string; revision: string; visibility?: string; files: Files; directories: string[]; published: string | null; disabled: boolean }
interface Release { id: string; files: Files; directories: string[]; label: string; createdAt: string }

export class DatabaseSkills {
  constructor(private readonly db: Pool) {}
  private async draft(c: PoolClient, name: string, lock = false): Promise<Draft> {
    validSkillName(name);
    const row = (await c.query<Draft>('SELECT name,revision,visibility,files,directories,published,disabled FROM workpivot.skill_drafts WHERE name=$1' + (lock ? ' FOR UPDATE' : ''), [name])).rows[0];
    if (!row) throw new RepositoryError(404, '技能草稿不存在或无权管理');
    row.files = Object.assign(Object.create(null) as Files, row.files); return row;
  }
  private async detail(c: PoolClient, draft: Draft) {
    const versions = (await c.query<Release>('SELECT id,files,directories,label,created_at AS "createdAt" FROM workpivot.skill_releases WHERE name=$1 ORDER BY created_at,id', [draft.name])).rows;
    const published = versions.find(v => v.id === draft.published);
    const equalFiles = published && Object.keys(published.files).length === Object.keys(draft.files).length && Object.entries(draft.files).every(([path, data]) => published.files[path] === data);
    return { name: draft.name, revision: draft.revision, published: draft.published, directories: draft.directories, dirty: !equalFiles || JSON.stringify(draft.directories) !== JSON.stringify(published?.directories),
      versions: versions.map(({ id, label, createdAt }) => ({ id, label, createdAt })), dependencies: null,
      files: Object.entries(draft.files).map(([path, data]) => ({ path, size: Buffer.from(data, 'base64').length, editable: packageText(Buffer.from(data, 'base64')) !== null })) };
  }
  async list(actor: string) {
    return transaction(this.db, async c => {
      const rows = (await c.query<Draft>('SELECT name,revision,visibility,files,directories,published,disabled FROM workpivot.skill_drafts ORDER BY name')).rows;
      return Promise.all(rows.map(async d => ({ name: d.name, description: '', source: 'global', managed: true, disabled: d.disabled, hasPublished: !!d.published, published: d.published, dirty: (await this.detail(c, d)).dirty })));
    }, actor);
  }
  async open(actor: string, name: string) { return transaction(this.db, async c => this.detail(c, await this.draft(c, name)), actor); }
  async create(actor: string, name: string) {
    validSkillName(name);
    return transaction(this.db, async c => {
      const files = { 'SKILL.md': Buffer.from(`---\nname: ${name}\ndescription: 请填写技能用途\n---\n\n# 工作流程\n请填写操作步骤、资源引用和检查要求。\n`).toString('base64') };
      await c.query('INSERT INTO workpivot.skill_drafts(name,owner_user_id,revision,files) VALUES($1,$2,$3,$4)', [name, actor, randomUUID(), JSON.stringify(files)]);
      return this.detail(c, await this.draft(c, name));
    }, actor);
  }
  async mutate(actor: string, name: string, revision: unknown, action: (draft: Draft, c: PoolClient) => Promise<void> | void) {
    return transaction(this.db, async c => {
      const d = await this.draft(c, name, true);
      if (d.visibility === 'private') throw new RepositoryError(403, '私人技能请使用草稿确认流程');
      if (revision !== d.revision) throw new RepositoryError(409, '草稿或发布版本已改变，请重新打开技能包');
      await action(d, c); checkFiles(d.files); d.directories = packageDirectories(d.files, d.directories); d.revision = randomUUID();
      await c.query('UPDATE workpivot.skill_drafts SET revision=$2,files=$3,directories=$4,published=$5,disabled=$6 WHERE name=$1', [name, d.revision, JSON.stringify(d.files), JSON.stringify(d.directories), d.published, d.disabled]);
      return this.detail(c, d);
    }, actor);
  }
  async file(actor: string, name: string, path: string, version?: string) {
    validPackagePath(path);
    return transaction(this.db, async c => {
      const d = await this.draft(c, name); let files = d.files;
      if (version) { const r = (await c.query<Release>('SELECT files FROM workpivot.skill_releases WHERE id::text=$1 AND name=$2', [version, name])).rows[0]; if (!r) throw new RepositoryError(404, '版本不存在'); files = r.files; }
      if (!Object.hasOwn(files, path)) throw new RepositoryError(404, '文件不存在');
      return Buffer.from(files[path]!, 'base64');
    }, actor);
  }
  async save(actor: string, name: string, path: string, bytes: Buffer | null, rev: unknown) {
    validPackagePath(path);
    return this.mutate(actor, name, rev, d => {
      if (bytes === null) { if (path === 'SKILL.md') throw new RepositoryError(400, '不能删除 SKILL.md'); if (!Object.hasOwn(d.files, path)) throw new RepositoryError(404, '文件不存在'); delete d.files[path]; }
      else d.files[path] = bytes.toString('base64');
    });
  }
  async directory(actor: string, name: string, path: string, rev: unknown, remove: boolean) {
    validPackagePath(path);
    return this.mutate(actor, name, rev, d => {
      if (remove) { if (!d.directories.includes(path)) throw new RepositoryError(404, '目录不存在'); for (const file of Object.keys(d.files)) if (file.startsWith(path + '/')) delete d.files[file]; d.directories = d.directories.filter(p => p !== path && !p.startsWith(path + '/')); }
      else { if (d.directories.some(p => p.toLowerCase() === path.toLowerCase())) throw new RepositoryError(409, '目录已存在'); d.directories.push(path); }
    });
  }
  async import(actor: string, name: string, bytes: Buffer, rev: unknown) { const decoded = decodePackageZip(name, bytes); return this.mutate(actor, name, rev, d => { d.files = decoded.files; d.directories = decoded.directories; }); }
  async validate(actor: string, name: string) { return transaction(this.db, async c => { const d = await this.draft(c, name); return validatePackageState(name, { draft: d.files, revision: d.revision }, (await c.query('SELECT name FROM workpivot.skill_catalog WHERE NOT disabled')).rows.map(r => r.name)); }, actor); }
  async publish(actor: string, name: string, rev: unknown) {
    return this.mutate(actor, name, rev, async (d, c) => {
      if (d.visibility === 'private') throw new RepositoryError(403, '私人技能必须通过草稿确认窗口发布');
      const validation = validatePackageState(name, { draft: d.files, revision: d.revision }, (await c.query('SELECT name FROM workpivot.skill_catalog WHERE NOT disabled')).rows.map(r => r.name));
      if (!validation.valid) throw new RepositoryError(400, validation.errors.join('\n'));
      const detail = await this.detail(c, d); if (!detail.dirty) throw new RepositoryError(409, '草稿与已发布版本一致');
      if (detail.versions.length >= 32) throw new RepositoryError(400, '当前技能最多保留32个发布版本');
      const id = randomUUID(); d.published = id;
      const { description } = instructionFields(name, Buffer.from(d.files['SKILL.md']!, 'base64').toString('utf8'));
      await c.query('INSERT INTO workpivot.skill_releases(id,name,owner_user_id,files,directories,label,description) VALUES($1,$2,$3,$4,$5,$6,$7)', [id, name, actor, JSON.stringify(d.files), JSON.stringify(d.directories), `版本 ${detail.versions.length + 1}`, description]);
      await c.query('INSERT INTO workpivot.skill_catalog(name,owner_user_id,release_id,disabled) VALUES($1,$2,$3,$4) ON CONFLICT(name) DO UPDATE SET release_id=EXCLUDED.release_id,disabled=EXCLUDED.disabled', [name, actor, id, d.disabled]);
    });
  }
  async rollback(actor: string, name: string, version: string, rev: unknown, discard = false) {
    return this.mutate(actor, name, rev, async (d, c) => {
      const r = (await c.query<Release>('SELECT id,files,directories FROM workpivot.skill_releases WHERE id::text=$1 AND name=$2', [discard ? d.published : version, name])).rows[0];
      if (!r) throw new RepositoryError(404, '版本不存在');
      if (discard) { d.files = r.files; d.directories = r.directories; } else { d.published = r.id; await c.query('UPDATE workpivot.skill_catalog SET release_id=$2 WHERE name=$1', [name, r.id]); }
    });
  }
  async toggle(actor: string, name: string, disabled: boolean) {
    return transaction(this.db, async c => { const d = await this.draft(c, name, true); if (d.visibility === 'private') throw new RepositoryError(403, '私人技能请使用我的技能入口'); await c.query('UPDATE workpivot.skill_drafts SET disabled=$2,revision=$3 WHERE name=$1', [name, disabled, randomUUID()]); await c.query('UPDATE workpivot.skill_catalog SET disabled=$2 WHERE name=$1', [name, disabled]); }, actor);
  }
  async export(actor: string, name: string, version?: string) {
    return transaction(this.db, async c => { const d = await this.draft(c, name); const r = version ? (await c.query<Release>('SELECT files,directories FROM workpivot.skill_releases WHERE id::text=$1 AND name=$2', [version, name])).rows[0] : d; if (!r) throw new RepositoryError(404, '版本不存在'); const zip = new AdmZip(); for (const p of r.directories) zip.addFile(p + '/', Buffer.alloc(0)); for (const [p, v] of Object.entries(r.files)) zip.addFile(p, Buffer.from(v, 'base64')); return zip.toBuffer(); }, actor);
  }
  async market(actor: string) {
    return transaction(this.db, async c => (await c.query<{ name: string; displayName: string; visibility: string; description: string; version: string; loaded: boolean }>(`SELECT c.name,c.display_name AS "displayName",c.visibility,r.description,c.release_id AS version,s.name IS NOT NULL AS loaded FROM workpivot.skill_catalog c JOIN workpivot.skill_releases r ON r.id=c.release_id LEFT JOIN workpivot.skill_selections s ON s.name=c.name AND s.owner_user_id=$1 WHERE NOT c.disabled ORDER BY c.name`, [actor])).rows, actor);
  }
  async select(actor: string, name: string, loaded: boolean) {
    validSkillName(name);
    return transaction(this.db, async c => { if (!loaded) { await c.query('DELETE FROM workpivot.skill_selections WHERE name=$1', [name]); return; } const selected = (await c.query('SELECT name,visibility FROM workpivot.skill_catalog WHERE name=$1 AND NOT disabled', [name])).rows[0]; if (selected?.visibility === 'private') throw new RepositoryError(403, '私人技能启用需要在我的技能中确认'); if (!selected) throw new RepositoryError(404, '技能未发布或已禁用'); await c.query('INSERT INTO workpivot.skill_selections(owner_user_id,name) VALUES($1,$2) ON CONFLICT DO NOTHING', [actor, name]); }, actor);
  }
  async executionResources(actor: string, name: string, version: string) {
    validSkillName(name);
    return transaction(this.db, async c => {
      const r = (await c.query<{ files: Files }>('SELECT r.files FROM workpivot.skill_catalog c JOIN workpivot.skill_releases r ON r.id=$2 AND r.name=c.name JOIN workpivot.skill_selections s ON s.name=c.name WHERE c.name=$1 AND NOT c.disabled', [name, version])).rows[0];
      if (!r) throw new RepositoryError(404, '技能未加载或已禁用');
      return Object.entries(r.files).map(([path, data]) => { validPackagePath(path); return [`${name}/${path}`, data] as [string,string]; });
    }, actor);
  }
  tools(actor: string, versions?: ReadonlyMap<string, string>): Tool[] { return [{ name: 'load_skill', kind: 'read', description: '按名称读取用户已加载技能的SKILL.md或包内文本资源；不会执行脚本。', parameters: { type: 'object', properties: { name: { type: 'string' }, file: { type: 'string' } }, required: ['name'], additionalProperties: false }, run: async (args, ctx) => {
    ctx.signal?.throwIfAborted(); const name = args['name']; if (typeof name !== 'string') throw new RepositoryError(400, '技能名称无效'); if (versions && !versions.has(name)) throw new RepositoryError(404, '此轮任务未加载该技能'); const path = args['file'] ?? 'SKILL.md'; if (typeof path !== 'string') throw new RepositoryError(400, '路径无效'); validPackagePath(path);
    return transaction(this.db, async c => { const r = (await c.query<{ files: Files; version: string }>(`SELECT r.files,r.id AS version FROM workpivot.skill_catalog c JOIN workpivot.skill_releases r ON r.id=COALESCE($2::uuid,c.release_id) AND r.name=c.name JOIN workpivot.skill_selections s ON s.name=c.name WHERE c.name=$1 AND NOT c.disabled`, [name, versions?.get(name) ?? null])).rows[0]; if (!r || !Object.hasOwn(r.files, path)) throw new RepositoryError(404, '技能未加载、已禁用或文件不存在'); const content = packageText(Buffer.from(r.files[path]!, 'base64')); if (content === null) throw new RepositoryError(400, '仅可读取256KiB以内文本资源'); return JSON.stringify({ name, version: r.version, file: path, content, resources: path === 'SKILL.md' ? Object.keys(r.files) : undefined }); }, actor);
  } }]; }
}
