/**
 * M1-07/H01：企业 Word 模板注册表。
 * 模板=含 {{占位符}}（如 {{标题}}/{{日期}}/{{正文}}）的普通 .docx，管理员上传；
 * 文件落 config/templates/files/<id>.docx，元数据 config/templates/templates.json；
 * 生成链：模型经 read 拿模板路径 → gen 脚本用 adm-zip 替换 word/document.xml 占位符 → 产出。
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureWorkpivotDir, readJsonSafe, writeAtomic } from './store.js';
import { moveToTrash } from './trash.js';

export interface WordTemplate {
  id: string;
  name: string;
  /** 模板类型（如 report/minutes/proposal，用于按类型关联；default=通用默认） */
  kind: string;
  fileName: string;
  isDefault: boolean;
  uploadedAt: string;
}

interface TemplateRegistry {
  version: 1;
  templates: WordTemplate[];
}

const EMPTY: TemplateRegistry = { version: 1, templates: [] };

function registryPath(): string {
  return join(ensureWorkpivotDir('config', 'templates'), 'templates.json');
}
function filesDir(): string {
  return ensureWorkpivotDir('config', 'templates', 'files');
}

function load(): TemplateRegistry {
  return readJsonSafe<TemplateRegistry>(registryPath(), EMPTY).value;
}
function save(registry: TemplateRegistry): void {
  writeAtomic(registryPath(), JSON.stringify(registry, null, 2));
}

export function templateFilePath(id: string): string {
  return join(filesDir(), `${id}.docx`);
}

export function listTemplates(): WordTemplate[] {
  return load().templates;
}

/** 上传模板（body=docx 二进制）。首个模板自动成为默认。 */
export function addTemplate(name: string, kind: string, body: Buffer): WordTemplate {
  if (body.length < 1000) throw new Error('文件过小，不是有效的 .docx');
  if (body[0] !== 0x50 || body[1] !== 0x4b) throw new Error('必须是 .docx 文件（zip 格式）');
  const registry = load();
  const tpl: WordTemplate = {
    id: randomUUID(),
    name,
    kind: kind === '' ? 'general' : kind,
    fileName: `${name.replace(/[\\/:*?"<>|]/g, '_')}.docx`,
    isDefault: registry.templates.length === 0,
    uploadedAt: new Date().toISOString(),
  };
  writeFileSync(templateFilePath(tpl.id), body);
  registry.templates.push(tpl);
  save(registry);
  return tpl;
}

export function setDefaultTemplate(id: string): WordTemplate {
  const registry = load();
  const tpl = registry.templates.find((t) => t.id === id);
  if (!tpl) throw new Error(`模板不存在：${id}`);
  for (const t of registry.templates) t.isDefault = t.id === id;
  save(registry);
  return tpl;
}

export function deleteTemplate(id: string): void {
  const registry = load();
  const tpl = registry.templates.find((t) => t.id === id);
  if (!tpl) throw new Error(`模板不存在：${id}`);
  registry.templates = registry.templates.filter((t) => t.id !== id);
  if (tpl.isDefault && registry.templates[0]) registry.templates[0].isDefault = true;
  save(registry);
  const file = templateFilePath(id);
  if (existsSync(file)) moveToTrash(file, `template-${id}`);
}

/** system 注入：模板清单 + 使用纪律（无模板时返回空串）。 */
export function renderTemplateInjection(): string {
  const templates = listTemplates();
  if (templates.length === 0) return '';
  const lines = templates.map((t) => `- ${t.name}（类型 ${t.kind}${t.isDefault ? '，默认' : ''}）：${templateFilePath(t.id)}`);
  return [
    '',
    '# 企业 Word 模板（H01）',
    '生成 Word 交付物时必须优先使用企业模板（adm-zip 读取模板,替换 word/document.xml 中的 {{占位符}} 后另存）,禁止无模板裸排。用户未指定时用默认模板。',
    ...lines,
  ].join('\n');
}
