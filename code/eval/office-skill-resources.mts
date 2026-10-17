import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { officeSkillArchive, officeSkillNames } from '../packages/server/src/database/office-skills.js';
import { decodePackageZip, validatePackageState } from '../packages/server/src/skill-package-store.js';

const require = createRequire(new URL('../packages/server/package.json', import.meta.url));
const { Document, Packer, Paragraph } = require('docx'), Excel = require('exceljs'), Pptx = require('pptxgenjs'), Zip = require('adm-zip');
const root = await mkdtemp(join(tmpdir(), 'wp-office-skill-'));
let count = 0;
const check = (ok: unknown, label: string) => { assert.ok(ok, label); count++; console.log('通过：' + label); };
try {
  const word = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('办公验收正文')] }] }));
  const book = new Excel.Workbook(); book.addWorksheet('数据').getCell('A1').value = '办公验收正文';
  const ppt = new Pptx(); ppt.addSlide().addText('办公验收正文', { x: 1, y: 1, w: 6, h: 1 });
  const outputs = [word, Buffer.from(await book.xlsx.writeBuffer()), Buffer.from(await ppt.write({ outputType: 'nodebuffer' }))];
  for (const name of officeSkillNames) {
    const { files } = decodePackageZip(name, officeSkillArchive(name));
    check(validatePackageState(name, { draft: files, revision: 'test' }, [...officeSkillNames]).valid, name + '完整包校验');
    if (name === 'office-routing') continue;
    if (name !== 'pptx-report') check(!!files['scripts/generate.cjs'] && !!files['scripts/template.py'] && (name !== 'docx-report' || !!files['scripts/check-generation.py']) && !Object.keys(files).some(p=>p.includes('__pycache__')), name + '生成与模板脚本齐全且不含运行缓存');
    check(!!files['references/create.md'] && !!files['references/read-edit.md'] && !!files['scripts/verify.py'], name + '独立资源齐全');
    const script = join(root, name + '.py'), output = join(root, 'sample.' + name.split('-')[0]);
    await writeFile(script, Buffer.from(files['scripts/verify.py']!, 'base64'));
    await writeFile(output, outputs[['docx-report', 'xlsx-report', 'pptx-report'].indexOf(name)]!);
    const result = JSON.parse(execFileSync('python3', [script, output, '--expect-text', '办公验收正文'], { encoding: 'utf8' }));
    check(result.structure === 'passed' && result.expectedText === 'passed' && result.visual === 'not-performed' && result.recalculation === 'not-performed', name + '真实生成文件结构与正文核对');
    check(spawnSync('python3', [script, output, '--expect-text', '不应出现的正文']).status === 1, name + '缺少要求内容时拒绝');
    const corrupt = new Zip(await readFile(output));
    corrupt.updateFile(name === 'docx-report' ? 'word/document.xml' : name === 'xlsx-report' ? 'xl/workbook.xml' : 'ppt/presentation.xml', Buffer.from('<broken>'));
    await writeFile(output, corrupt.toBuffer());
    check(spawnSync('python3', [script, output]).status === 1, name + 'XML损坏不能只凭ZIP魔数通过');
  }
  console.log(`Office技能资源：${count}/${count}通过`);
} finally { await rm(root, { recursive: true, force: true }); }
