import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

// 仅生成合成文件；每次探测使用独立目录和LibreOffice配置，不读取业务资料。
const require = createRequire(new URL('../packages/server/package.json', import.meta.url));
const { Document, Packer, Paragraph, TextRun } = require('docx');
const Excel = require('exceljs'), Pptx = require('pptxgenjs'), Zip = require('adm-zip');
const root = await mkdtemp(join(tmpdir(), 'workpivot-office-probe-'));
const output = join(root, 'output');
await mkdir(output);
const word = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph({ children: [new TextRun({ text: '{{客', bold: true }), new TextRun('户}}测试')] })] }] }));
await writeFile(join(root, 'sample.docx'), word);
const xml = new Zip(word).readAsText('word/document.xml');
assert.ok(!xml.includes('{{客户}}') && xml.includes('{{客') && xml.includes('户}}'));
const book = new Excel.Workbook(), sheet = book.addWorksheet('预算');
sheet.getCell('A1').value = 10; sheet.getCell('A2').value = 20; sheet.getCell('A3').value = { formula: 'SUM(A1:A2)' };
await book.xlsx.writeFile(join(root, 'sample.xlsx'));
const before = new Excel.Workbook(); await before.xlsx.readFile(join(root, 'sample.xlsx'));
assert.equal(before.getWorksheet('预算').getCell('A3').result, undefined);
const ppt = new Pptx(); ppt.addSlide().addText('中文办公测试', { x: 1, y: 1, w: 6, h: 1, fontFace: 'Noto Sans CJK SC' });
await ppt.writeFile({ fileName: join(root, 'sample.pptx') });
const env = { ...process.env, SAL_USE_VCLPLUGIN: 'gen', XDG_CACHE_HOME: join(root, 'cache'), XDG_CONFIG_HOME: join(root, 'config') };
const convert = (format: string, file: string) => execFileSync('libreoffice', [`-env:UserInstallation=${pathToFileURL(join(root, 'profile')).href}`, '--headless', '--convert-to', format, '--outdir', output, join(root, file)], { env, encoding: 'utf8', timeout: 60000 });
const version = execFileSync('libreoffice', ['--version'], { env, encoding: 'utf8' }).trim();
convert('xlsx', 'sample.xlsx');
const after = new Excel.Workbook(); await after.xlsx.readFile(join(output, 'sample.xlsx'));
assert.equal(after.getWorksheet('预算').getCell('A3').result, 30);
const rendered: string[] = [];
for (const ext of ['docx', 'xlsx', 'pptx']) {
  // 三种格式名称相同，读取并另存证据后再转换下一种。
  convert('pdf', 'sample.' + ext);
  const pdf = await readFile(join(output, 'sample.pdf'));
  assert.ok(pdf.subarray(0, 5).equals(Buffer.from('%PDF-')));
  await writeFile(join(output, ext + '.pdf'), pdf);
  const text = execFileSync('pdftotext', [join(output, ext + '.pdf'), '-'], { encoding: 'utf8', timeout: 10000 });
  assert.ok(text.includes(ext === 'docx' ? '测试' : ext === 'pptx' ? '中文办公测试' : '30'));
  rendered.push(ext);
}
const report = { version, wordSplitPlaceholder: '直接XML字符串替换无法匹配跨文本片段占位符', excelBefore: '公式未计算，无缓存', excelAfter: 30, rendered, boundary: '宿主合成样本探测；不代表容器集成、复杂格式保真或视觉验收通过' };
await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ root, ...report }, null, 2));
