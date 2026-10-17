import { readStructurePage } from '../packages/server/src/database/document-structure.js';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parserProgram, validateParsedDocument, parserFingerprint } from '../packages/server/src/database/document-parser.js';

const require = createRequire(new URL('../packages/server/package.json', import.meta.url));
const Zip = require('adm-zip');
const root = await mkdtemp(join(tmpdir(), 'wp-parser-metadata-'));
let count = 0;
const check = (ok: unknown, label: string) => { assert.ok(ok, label); count++; console.log('通过：' + label); };
try {
  // 仅替换合成测试目录；实际解析器仍固定在隔离容器/workspace内执行。
  await writeFile(join(root, 'parse.py'), parserProgram.replaceAll('/workspace', root));
  const zip = new Zip();
  zip.addFile('word/document.xml', Buffer.from('<document><body><p><t>中文正文</t></p></body></document>'));
  const parse = async (ext: string, data: Buffer) => {
    await writeFile(join(root, 'source' + ext), data);
    execFileSync('python3', [join(root, 'parse.py'), ext], { timeout: 10000 });
    return validateParsedDocument(JSON.parse(await readFile(join(root, 'parsed.json'), 'utf8')));
  };
  const plain = await parse('.docx', zip.toBuffer());
  check(plain.coverage === 'text-only' && plain.parts[0]?.text === '中文正文', '文字提取范围不等于完整文档');
  zip.addFile('word/media/image1.png', Buffer.from('合成媒体占位，不解码图片'));
  const partial = await parse('.docx', zip.toBuffer());
  check(partial.coverage === 'partial' && partial.warnings[0]?.includes('图片'), '未识别媒体产生部分状态');
  const stream = 'BT /F1 12 Tf 72 720 Td (Readable page) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>'];
  let pdf = '%PDF-1.4\n'; const offsets: number[] = [];
  for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 7\n0000000000 65535 f \n${offsets.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const mixed = await parse('.pdf', Buffer.from(pdf));
  check(mixed.coverage === 'partial' && mixed.warnings.some(w => w.includes('：2')) && mixed.parts[0]?.location === 'page:1', 'PDF空文字页保留原页号并提示可能为空白或扫描');
  check(validateParsedDocument(plain.parts).coverage === 'unknown', '旧数组契约不伪造覆盖范围');
  check(/^[a-f0-9]{64}$/.test(parserFingerprint), '程序和契约产生固定指纹');
  for (const invalid of [{ ...plain, coverage: 'complete' }, { ...plain, warnings: [12] }, { ...plain, coverage: 'partial', warnings: [] }]) { assert.throws(() => validateParsedDocument(invalid)); count++; }
  const word = new Zip();
  word.addFile('word/document.xml', Buffer.from('<document><body><p><t>标题</t></p><tbl><tr><trPr><gridBefore val="1"/></trPr><tc><tcPr><gridSpan val="2"/><vMerge val="restart"/></tcPr><p><t>合并内容</t></p><tbl><tr><tc><p><t>内嵌表</t></p></tc></tr></tbl></tc></tr><tr><tc><tcPr><vMerge/></tcPr><p/></tc></tr></tbl></body></document>'));
  const structured = await parse('.docx', word.toBuffer());
  check(structured.parts.find(p => p.location === 'table-cell:1')?.object?.column === 2 && structured.parts.find(p => p.location === 'table-cell:1')?.object?.columnSpan === 2, 'Word网格前移及跨列保留');
  check(structured.parts.find(p => p.location === 'table:2')?.object?.parent === 'table-cell:1', '嵌套表保留父单元格');
  check(structured.parts.find(p => p.location === 'table-cell:3')?.object?.verticalMerge === 'continue', '纵向合并省略值仍为延续');
  check(readStructurePage(structured.parts, {parent:'table-cell:1'}).items.length === 2, '按父对象只读取直接子对象');
  check(structured.parts.filter(p=>p.text==='内嵌表').length===1, '嵌套表文字不重复进入知识索引');
  const book = new Zip();
  book.addFile('xl/workbook.xml', Buffer.from('<workbook xmlns:r="urn:rel"><sheets><sheet name="收入" r:id="r1" state="hidden"/><sheet name="空表" r:id="r2"/></sheets></workbook>'));
  book.addFile('xl/_rels/workbook.xml.rels', Buffer.from('<Relationships><Relationship Id="r1" Target="worksheets/s1.xml"/><Relationship Id="r2" Target="worksheets/s2.xml"/></Relationships>'));
  book.addFile('xl/worksheets/s1.xml', Buffer.from('<worksheet><sheetData><row><c r="A1" t="inlineStr"><is><t>金额</t></is></c><c r="B2"><f t="shared" si="0" ref="B2:B3">A2*2</f><v>0</v></c><c r="B3"><f t="shared" si="0"/></c></row></sheetData><mergeCells><mergeCell ref="A4:C4"/></mergeCells></worksheet>'));
  book.addFile('xl/worksheets/s2.xml', Buffer.from('<worksheet><sheetData/></worksheet>'));
  const workbook = await parse('.xlsx', book.toBuffer());
  check(workbook.parts.some(p=>p.object?.kind==='sheet'&&p.object.state==='hidden'), '隐藏工作表显式标记');
  const region=readStructurePage(workbook.parts,{sheet:'收入',range:'B2:B4'});
  check(region.items.length===3&&region.items.some(p=>p.kind==='merge'), '区域读取包含相交合并范围且不展开空白矩阵');
  check(region.items.some(p=>p.formula==='A2*2'&&p.cached==='0')&&region.items.some(p=>p.formula===''&&p.sharedIndex==='0'), '零缓存和共享公式从属单元格不丢失');
  check(readStructurePage(workbook.parts,{sheet:'空表',range:'A1:C3'}).items.length===0, '空工作表可读取且区域返回空对象');
  for(const query of [{sheet:'不存在'},{range:'A1'},{sheet:'收入',range:'XFE1'},{sheet:'收入',range:'B2:A1'},{offset:-1},{parent:'不存在'}]) {assert.throws(()=>readStructurePage(workbook.parts,query));count++;}
  const longParts=[{location:'paragraph:1',text:'😀'.repeat(9000),object:{kind:'paragraph' as const}}];
  let cursor={offset:0,textOffset:0}, combined='';
  for(;;) { const page=readStructurePage(longParts,cursor);combined+=page.items.map(p=>p.text).join('');if(!page.next)break;cursor=page.next; }
  check(combined===longParts[0]!.text,'超长对象跨页不丢文字及代理对');
  assert.throws(()=>readStructurePage(longParts,{textOffset:1}));count++;
  const blank=new Zip();blank.addFile('word/document.xml',Buffer.from('<document><body><p/></body></document>'));
  check((await parse('.docx',blank.toBuffer())).parts[0]?.text==='', '空白段落作为对象保留');
  const unsafe=new Zip();unsafe.addFile('word/document.xml',Buffer.from('<?xml version="1.0" encoding="utf-16"?><!DOCTYPE document [<!ENTITY x "注入">]><document><p><t>&x;</t></p></document>','utf16le'));
  await assert.rejects(parse('.docx',unsafe.toBuffer()));count++;
  const {Document,Packer,Paragraph,Table,TableRow,TableCell}=require('docx');
  const generatedWord=await parse('.docx',await Packer.toBuffer(new Document({sections:[{children:[new Table({rows:[new TableRow({children:[new TableCell({children:[new Paragraph('真实生成表格')]}),new TableCell({children:[new Paragraph('第二列')]})]})]})]}]})));
  check(generatedWord.parts.some(p=>p.object?.kind==='table-cell'&&p.object.column===2)&&generatedWord.parts.some(p=>p.text==='真实生成表格'),'真实docx生成器输出可定位表格');
  const Excel=require('exceljs'), realBook=new Excel.Workbook(), realSheet=realBook.addWorksheet('真实表');
  realSheet.getCell('A1').value='合并标题';realSheet.mergeCells('A1:C1');realSheet.getCell('D2').value={formula:'1+1',result:2};
  const generatedBook=await parse('.xlsx',Buffer.from(await realBook.xlsx.writeBuffer()));
  check(readStructurePage(generatedBook.parts,{sheet:'真实表',range:'B1:D2'}).items.some(p=>p.range==='A1:C1')&&generatedBook.parts.some(p=>p.object?.formula==='1+1'&&p.object.cached==='2'),'真实exceljs输出保留合并范围和原公式缓存');
  const dense=Array.from({length:75},(_,i)=>({location:'paragraph:'+i,text:'',object:{kind:'paragraph' as const}}));
  check(readStructurePage(dense).items.length===32&&readStructurePage(dense,{offset:64}).items.length===11,'空对象按数量分页且可读完');
  for(const object of [{kind:'cell',sheet:'表',address:'XFE1'}, {kind:'table-cell',row:0}, {kind:'paragraph',parent:'不存在'}]) {
    assert.throws(()=>validateParsedDocument({parts:[{location:'invalid',text:'',object}],coverage:'text-only',warnings:[]}));count++;
  }
  console.log(`解析元数据：${count}/${count}通过`);
} finally { await rm(root, { recursive: true, force: true }); }
