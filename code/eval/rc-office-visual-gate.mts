/**
 * RC Office 视觉门禁：生成 20 份固定结构样本，经真实隔离执行器渲染 PDF/PNG，
 * 核对页数、关键字和首个缩略图，并输出人工复核用联系表。
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { startWorker } from '../scripts/skill-worker.mjs';
import { runSandbox } from '../packages/server/src/database/sandbox.js';

const require = createRequire(new URL('../packages/server/package.json', import.meta.url));
const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, HeadingLevel, ImageRun, Header, Footer, AlignmentType } = require('docx');
const Excel = require('exceljs');
const Pptx = require('pptxgenjs');

const root = resolve('../local-runtime/acceptance/rc-office-visual');
const inputs = join(root, 'inputs'), outputs = join(root, 'outputs');
await rm(root, { recursive: true, force: true });
await mkdir(inputs, { recursive: true });
await mkdir(outputs, { recursive: true });
const token = randomBytes(32).toString('hex');
const worker = await startWorker({
  token,
  image: process.env['WORKPIVOT_TEST_IMAGE'] ?? 'workpivot-executor:local-stack',
  port: 0,
  owner: 'workpivot-rc-office-visual',
});
const address = worker.server.address();
assert(address && typeof address !== 'string');
const workerConfig = { url: `http://127.0.0.1:${address.port}`, token };

interface Sample {
  id: string;
  name: string;
  format: 'docx' | 'xlsx' | 'pptx';
  expected: string[];
  minPages: number;
}
const samples: Sample[] = [];
const add = (sample: Sample): void => { samples.push(sample); };

const cell = (text: string) => new TableCell({ children: [new Paragraph(text)] });
const pageBreak = () => new Paragraph({ text: '', pageBreakBefore: true });
const docDefaults = { styles: { default: { document: { run: { font: 'Noto Sans CJK SC', size: 22 } } } } };

const wordSamples: Array<[string, () => Promise<Buffer>, string[]]> = [
  ['word-01-basic', async () => Packer.toBuffer(new Document({ ...docDefaults, sections: [{ children: [new Paragraph({ text: '基础业务报告', heading: HeadingLevel.TITLE }), new Paragraph('本文用于 WorkPivot RC 视觉门禁，包含中文标题与正文。'), new Paragraph('结论：数据结构有效，版式需保持稳定。')] }] })), ['基础业务报告', '视觉门禁']],
  ['word-02-headings', async () => Packer.toBuffer(new Document({ ...docDefaults, sections: [{ children: [new Paragraph({ text: '第一章 经营概览', heading: HeadingLevel.HEADING_1 }), new Paragraph('第一级正文说明。'), new Paragraph({ text: '1.1 收入结构', heading: HeadingLevel.HEADING_2 }), new Paragraph('第二级正文说明。'), new Paragraph({ text: '1.1.1 产品分布', heading: HeadingLevel.HEADING_3 }), new Paragraph('第三级正文说明。')] }] })), ['第一章', '收入结构', '产品分布']],
  ['word-03-table', async () => {
    const rows = [new TableRow({ tableHeader: true, children: ['序号', '合同', '金额（万元）'].map(cell) })];
    for (let i = 1; i <= 40; i++) rows.push(new TableRow({ children: [cell(String(i)), cell(`SYN-${String(i).padStart(3, '0')}`), cell(String(i * 10))] }));
    return Packer.toBuffer(new Document({ ...docDefaults, sections: [{ children: [new Paragraph({ text: '合同明细表', heading: HeadingLevel.HEADING_1 }), new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows })] }] }));
  }, ['合同明细表', 'SYN-040', '400']],
  ['word-04-long-text', async () => Packer.toBuffer(new Document({ ...docDefaults, sections: [{ children: [new Paragraph({ text: '长段落排版检查', heading: HeadingLevel.HEADING_1 }), new Paragraph('这是用于检查中文自动换行、标点挤压和段落间距的合成长文本。'.repeat(18)), new Paragraph('第二段包含数字 2026、金额 1,234,567.89 元以及英文 WorkPivot Acceptance。')] }] })), ['长段落排版检查', '1,234,567.89', 'Acceptance']],
  ['word-05-pagination', async () => Packer.toBuffer(new Document({ ...docDefaults, sections: [{ children: [new Paragraph({ text: '第 1 页：项目背景', heading: HeadingLevel.HEADING_1 }), new Paragraph('背景内容。'), pageBreak(), new Paragraph({ text: '第 2 页：实施计划', heading: HeadingLevel.HEADING_1 }), new Paragraph('实施内容。'), pageBreak(), new Paragraph({ text: '第 3 页：风险清单', heading: HeadingLevel.HEADING_1 }), new Paragraph('风险内容。')] }] })), ['第 1 页', '第 2 页', '第 3 页']],
  ['word-06-header-footer', async () => Packer.toBuffer(new Document({ ...docDefaults, sections: [{ headers: { default: new Header({ children: [new Paragraph({ children: [new TextRun('WorkPivot 合成报告 · 页眉')], alignment: AlignmentType.CENTER })] }) }, footers: { default: new Footer({ children: [new Paragraph({ children: [new TextRun('内部验收 · 页脚')], alignment: AlignmentType.CENTER })] }) }, children: [new Paragraph({ text: '页眉页脚检查', heading: HeadingLevel.HEADING_1 }), new Paragraph('正文应位于页眉页脚之间。')] }] })), ['页眉页脚检查', '合成报告']],
  ['word-07-image', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l4n5WQAAAABJRU5ErkJggg==', 'base64');
    return Packer.toBuffer(new Document({ ...docDefaults, sections: [{ children: [new Paragraph({ text: '图片占位检查', heading: HeadingLevel.HEADING_1 }), new Paragraph({ children: [new ImageRun({ data: png, transformation: { width: 260, height: 160 }, type: 'png' })] }), new Paragraph('图片下方说明：合成色块不是业务图片。')] }] }));
  }, ['图片占位检查', '合成色块']],
  ['word-08-mixed', async () => Packer.toBuffer(new Document({ ...docDefaults, sections: [{ children: [new Paragraph({ text: '综合样版', heading: HeadingLevel.TITLE }), new Paragraph({ children: [new TextRun({ text: '加粗结论：', bold: true }), new TextRun('收入与合同金额必须一致。')] }), new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [new TableRow({ tableHeader: true, children: ['指标', '数值'].map(cell) }), new TableRow({ children: ['收入', '100 万元'].map(cell) }), new TableRow({ children: ['合同', '120 万元'].map(cell) })] }), new Paragraph({ children: [new TextRun({ text: '差异说明：', italics: true }), new TextRun('合同口径包含税。')] })] }] })), ['综合样版', '加粗结论', '差异说明']],
];
for (const [id, factory, expected] of wordSamples) {
  const name = `${id}.docx`;
  await writeFile(join(inputs, name), await factory());
  add({ id, name, format: 'docx', expected, minPages: id === 'word-05-pagination' ? 3 : 1 });
}

async function workbookSample(id: string, expected: string[], build: (book: InstanceType<typeof Excel.Workbook>) => void): Promise<void> {
  const book = new Excel.Workbook();
  book.creator = 'WorkPivot RC Visual Gate';
  build(book);
  const name = `${id}.xlsx`;
  await book.xlsx.writeFile(join(inputs, name));
  add({ id, name, format: 'xlsx', expected, minPages: 1 });
}
await workbookSample('excel-01-basic', ['项目', '收入', '120'], book => { const s = book.addWorksheet('经营数据'); s.addRow(['项目', '金额']); s.addRow(['收入', 120]); s.addRow(['成本', 80]); s.addRow(['利润', 40]); s.columns = [{ width: 18 }, { width: 16 }]; });
await workbookSample('excel-02-formula', ['合计', '30', '11'], book => { const s = book.addWorksheet('公式'); s.addRow(['A', 'B', '合计']); s.addRow([10, 20, { formula: 'A2+B2', result: 30 }]); s.addRow([5, 6, { formula: 'A3+B3', result: 11 }]); });
await workbookSample('excel-03-wide', ['项目', '六月', '收入'], book => { const s = book.addWorksheet('宽表'); s.addRow(['项目', '一月', '二月', '三月', '四月', '五月', '六月']); s.addRow(['收入', 1, 2, 3, 4, 5, 6]); s.addRow(['成本', 2, 3, 4, 5, 6, 7]); for (let c = 1; c <= 7; c++) s.getColumn(c).width = 14; });
await workbookSample('excel-04-dates', ['里程碑', '签约', '交付', '计划'], book => { const s = book.addWorksheet('日期'); s.addRow(['里程碑', '日期', '状态']); s.addRow(['签约', new Date('2026-11-03T00:00:00Z'), '完成']); s.addRow(['交付', new Date('2026-12-31T00:00:00Z'), '计划']); s.getColumn(2).numFmt = 'yyyy-mm-dd'; });
await workbookSample('excel-05-multisheet', ['合成多工作表样版', '序号', '金额'], book => { book.addWorksheet('摘要').addRow(['合成多工作表样版']); const d = book.addWorksheet('明细'); d.addRow(['序号', '金额']); for (let i = 1; i <= 25; i++) d.addRow([i, i * 2]); book.addWorksheet('说明').addRow(['本文件仅用于视觉验收']); });
await workbookSample('excel-06-format', ['金额', '1,234,567.89', '12.5%'], book => { const s = book.addWorksheet('格式'); s.getCell('A1').value = '金额'; s.getCell('B1').value = '比例'; s.getCell('A2').value = 1234567.89; s.getCell('A2').numFmt = '#,##0.00'; s.getCell('B2').value = 0.125; s.getCell('B2').numFmt = '0.0%'; s.getCell('C2').value = '合成备注'; s.getCell('C2').alignment = { wrapText: true }; s.getColumn(1).width = 20; s.getColumn(2).width = 16; s.getColumn(3).width = 28; });

const pptSamples: Array<[string, () => Promise<void>, string[], number]> = [
  ['ppt-01-cover', async () => { const p = new Pptx(); p.layout = 'LAYOUT_WIDE'; const s = p.addSlide(); s.background = { color: 'F2F2F2' }; s.addText('WorkPivot 合成经营汇报', { x: 0.8, y: 1.2, w: 11, h: 0.8, fontFace: 'Noto Sans CJK SC', fontSize: 30, bold: true }); s.addText('视觉门禁 · 2026', { x: 0.8, y: 2.3, w: 8, h: 0.5, fontFace: 'Noto Sans CJK SC', fontSize: 18 }); await p.writeFile({ fileName: join(inputs, 'ppt-01-cover.pptx') }); }, ['合成经营汇报', '视觉门禁'], 1],
  ['ppt-02-content', async () => { const p = new Pptx(); p.layout = 'LAYOUT_WIDE'; const s = p.addSlide(); s.addText('核心结论', { x: 0.6, y: 0.4, w: 10, h: 0.6, fontFace: 'Noto Sans CJK SC', fontSize: 26 }); s.addText('收入同比增长 12%\n毛利率保持稳定\n回款周期缩短 5 天', { x: 1, y: 1.4, w: 9, h: 3, fontFace: 'Noto Sans CJK SC', fontSize: 22, bullet: true }); await p.writeFile({ fileName: join(inputs, 'ppt-02-content.pptx') }); }, ['核心结论', '回款周期'], 1],
  ['ppt-03-table', async () => { const p = new Pptx(); p.layout = 'LAYOUT_WIDE'; const s = p.addSlide(); s.addText('区域销售', { x: 0.6, y: 0.4, w: 9, h: 0.6, fontFace: 'Noto Sans CJK SC', fontSize: 26 }); s.addTable([['区域', '收入', '利润'], ['华东', '120', '30'], ['华北', '80', '20']], { x: 0.8, y: 1.3, w: 9, h: 2.5, fontFace: 'Noto Sans CJK SC', fontSize: 18, border: { pt: 1, color: '999999' } }); await p.writeFile({ fileName: join(inputs, 'ppt-03-table.pptx') }); }, ['区域销售', '华东', '120'], 1],
  ['ppt-04-chart', async () => { const p = new Pptx(); p.layout = 'LAYOUT_WIDE'; const s = p.addSlide(); s.addText('季度趋势', { x: 0.6, y: 0.4, w: 9, h: 0.6, fontFace: 'Noto Sans CJK SC', fontSize: 26 }); s.addChart(p.ChartType.bar, [{ name: '收入', labels: ['Q1', 'Q2', 'Q3', 'Q4'], values: [80, 95, 110, 120] }], { x: 0.8, y: 1.2, w: 9, h: 4, showValue: true, fontFace: 'Noto Sans CJK SC' }); await p.writeFile({ fileName: join(inputs, 'ppt-04-chart.pptx') }); }, ['季度趋势'], 1],
  ['ppt-05-blocks', async () => { const p = new Pptx(); p.layout = 'LAYOUT_WIDE'; const s = p.addSlide(); s.addText('三阶段计划', { x: 0.6, y: 0.4, w: 10, h: 0.6, fontFace: 'Noto Sans CJK SC', fontSize: 26 }); ['评估', '建设', '验收'].forEach((text, i) => s.addShape(p.ShapeType.roundRect, { x: 0.8 + i * 3.3, y: 1.8, w: 2.7, h: 1.4, fill: { color: ['DDEBF7', 'E2F0D9', 'FFF2CC'][i] }, line: { color: '7F7F7F' } }).addText(text, { x: 0.8 + i * 3.3, y: 2.2, w: 2.7, h: 0.5, align: 'center', fontFace: 'Noto Sans CJK SC', fontSize: 22 })); await p.writeFile({ fileName: join(inputs, 'ppt-05-blocks.pptx') }); }, ['三阶段计划', '建设', '验收'], 1],
  ['ppt-06-multipage', async () => { const p = new Pptx(); p.layout = 'LAYOUT_WIDE'; for (let i = 1; i <= 3; i++) { const s = p.addSlide(); s.addText(`第 ${i} 页`, { x: 0.6, y: 0.4, w: 8, h: 0.6, fontFace: 'Noto Sans CJK SC', fontSize: 26 }); s.addText(`合成多页内容 ${i}\n用于检查页数、标题和纵向排版。`, { x: 0.8, y: 1.3, w: 9, h: 2.4, fontFace: 'Noto Sans CJK SC', fontSize: 22 }); } await p.writeFile({ fileName: join(inputs, 'ppt-06-multipage.pptx') }); }, ['第 1 页', '第 2 页', '第 3 页'], 3],
];
for (const [id, factory, expected, minPages] of pptSamples) {
  await factory();
  add({ id, name: `${id}.pptx`, format: 'pptx', expected, minPages });
}

const results: Array<Record<string, unknown>> = [];
try {
  for (const sample of samples) {
    const data = await readFile(join(inputs, sample.name));
    const extension = `.${sample.format}`;
    const command = [
      `mkdir -p /workspace/out /workspace/lo /workspace/thumbs`,
      `libreoffice -env:UserInstallation=file:///workspace/lo --headless --norestore --convert-to pdf --outdir /workspace/out /workspace/source${extension}`,
      `pdfinfo /workspace/out/source.pdf > /workspace/pdfinfo.txt`,
      `pdftotext -layout /workspace/out/source.pdf /workspace/plain.txt`,
      `pdftoppm -f 1 -l 3 -scale-to 1280 -png /workspace/out/source.pdf /workspace/thumbs/page`,
    ].join(' && ');
    const result = await runSandbox(workerConfig, {
      command,
      files: [[`source${extension}`, data.toString('base64')]],
      skills: [],
    });
    const file = (name: string): Buffer => {
      const found = result.files.find(([path]) => path === name || path.endsWith('/' + name));
      assert(found, `${sample.id} 缺少 ${name}`);
      return Buffer.from(found[1], 'base64');
    };
    const pdf = file('out/source.pdf');
    assert(pdf.subarray(0, 5).toString('ascii') === '%PDF-', `${sample.id} 未生成 PDF`);
    const info = file('pdfinfo.txt').toString('utf8');
    const pages = Number(info.match(/^Pages:\s+(\d+)/m)?.[1]);
    assert(pages >= sample.minPages, `${sample.id} 页数不足：${pages}`);
    const text = file('plain.txt').toString('utf8').replace(/\s+/g, ' ');
    for (const expected of sample.expected) assert(text.includes(expected.replace(/\s+/g, ' ')), `${sample.id} 缺少文本：${expected}`);
    const thumbs = result.files.filter(([path]) => path.includes('thumbs/page')).map(([path, value]) => ({ name: basename(path), data: Buffer.from(value, 'base64') }));
    assert(thumbs.length > 0, `${sample.id} 没有缩略图`);
    const safe = sample.id.replace(/[^a-z0-9-]/gi, '');
    await writeFile(join(outputs, `${safe}.pdf`), pdf);
    await writeFile(join(outputs, `${safe}.txt`), text);
    for (const thumb of thumbs) await writeFile(join(outputs, `${safe}-${thumb.name}`), thumb.data);
    results.push({ ...sample, pages, bytes: data.length, pdfBytes: pdf.length, thumbnails: thumbs.length, passed: true });
    console.log(`✅ ${sample.id} · ${sample.format.toUpperCase()} · ${pages} 页 · 文本与渲染通过`);
  }
  const sheetScript = String.raw`
from PIL import Image, ImageDraw
from pathlib import Path
import json, sys
root=Path(sys.argv[1]); report=Path(sys.argv[2])
items=json.loads(Path(sys.argv[3]).read_text())
thumbs=[]
for item in items:
    paths=sorted(root.glob(item['id']+'-page*.png'))
    if paths:
        img=Image.open(paths[0]).convert('RGB'); img.thumbnail((360,240))
        thumbs.append((item['id']+'  '+str(item['pages'])+'p',img.copy()))
cols=4; cellw,cellh=380,290; rows=(len(thumbs)+cols-1)//cols
sheet=Image.new('RGB',(cols*cellw,rows*cellh),'white'); draw=ImageDraw.Draw(sheet)
for i,(caption,img) in enumerate(thumbs):
    x=(i%cols)*cellw+10; y=(i//cols)*cellh+10
    sheet.paste(img,(x,y+24)); draw.text((x,y+4),caption,fill='black')
sheet.save(root.parent/'rc-office-contact-sheet.png')
`;
  const reportJson = join(root, 'samples.json');
  await writeFile(reportJson, JSON.stringify(results, null, 2));
  execFileSync('python3', ['-c', sheetScript, outputs, join(root, 'report.json'), reportJson], { stdio: 'pipe' });
  const report = {
    passed: true,
    generatedAt: new Date().toISOString(),
    sampleCount: results.length,
    formats: { docx: 8, xlsx: 6, pptx: 6 },
    checks: ['真实隔离执行器生成 PDF', 'PDF 页数满足样本规则', '关键中文/数字文本可提取', '每份样本至少生成一张页面缩略图'],
    contactSheet: resolve(root, '../rc-office-contact-sheet.png'),
    visualReview: process.env['WORKPIVOT_VISUAL_REVIEW'] === 'passed' ? 'passed-manual-contact-sheet' : 'pending-human-inspection',
    scope: '合成样本视觉基线；LibreOffice 渲染，不是 Microsoft Word/WPS 像素级保真比较',
    samples: results,
  };
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, sampleCount: results.length, contactSheet: report.contactSheet }));
} finally {
  await worker.close();
}
