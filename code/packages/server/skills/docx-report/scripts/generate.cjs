/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('node:fs');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');
const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell } = require('docx');

// 参数文件承载内容，不将用户文字拼接成可执行代码。
function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) throw Error('生成参数包含不支持的字段');
}
function text(value) {
  if (typeof value !== 'string' || value.length > 10000 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) throw Error('文字内容无效或超限');
  return value;
}
async function main() {
  const [, , input, output] = process.argv;
  if (!input || !output || !output.toLowerCase().endsWith('.docx') || fs.existsSync(output)) throw Error('需要参数文件和不存在的DOCX输出路径');
  if (fs.statSync(input).size > 1000000) throw Error('参数文件超过1MB');
  const spec = JSON.parse(fs.readFileSync(input, 'utf8')); object(spec, ['title', 'paragraphs', 'tables']);
  if (!Array.isArray(spec.paragraphs) || spec.paragraphs.length > 500 || !Array.isArray(spec.tables ?? []) || (spec.tables ?? []).length > 20) throw Error('段落或表格数量无效');
  const children = [];
  if (spec.title !== undefined) children.push(new Paragraph({ text: text(spec.title), heading: HeadingLevel.TITLE }));
  for (const paragraph of spec.paragraphs) children.push(new Paragraph({ children: [new TextRun(text(paragraph))] }));
  for (const table of spec.tables ?? []) {
    if (!Array.isArray(table) || !table.length || table.length > 200 || !Array.isArray(table[0]) || !table[0].length || table[0].length > 30) throw Error('表格大小无效');
    const width = table[0].length;
    const rows = table.map(row => {
      if (!Array.isArray(row) || row.length !== width) throw Error('表格列数必须一致');
      return new TableRow({ children: row.map(cell => new TableCell({ children: [new Paragraph(text(cell))] })) });
    });
    children.push(new Table({ rows }));
  }
  if (!children.length) throw Error('文档内容为空');
  const document = new Document({ styles: { default: { document: { run: { font: '宋体', size: 24 } } } }, sections: [{ children }] });
  const buffer = await Packer.toBuffer(document);
  // 排他创建；原模板、原成果和已有文件均不会被覆盖。
  fs.writeFileSync(output, buffer, { flag: 'wx' });
  try { execFileSync('python3', [join(__dirname, 'check-generation.py'), input, output], { stdio: 'pipe' }); }
  catch { fs.unlinkSync(output); throw Error('生成结果未通过结构和正文核对'); }
  console.log(JSON.stringify({ generated: true, verification: 'passed', visual: 'not-performed' }));
}
main().catch(error => { console.error('Word生成失败：' + error.message); process.exitCode = 1; });
