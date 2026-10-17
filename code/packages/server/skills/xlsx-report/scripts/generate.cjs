/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('node:fs');
const Excel = require('exceljs');

// 明确区分普通文本与显式公式，字符串以等号开头也不会自动执行为公式。
function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) throw Error('生成参数包含不支持的字段');
}
function cell(value) {
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  if (typeof value === 'string' && value.length <= 32767 && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) return value;
  object(value, ['formula']);
  if (typeof value.formula !== 'string' || !value.formula.length || value.formula.length > 8192 || value.formula.startsWith('=')) throw Error('公式必须为不带等号的表达式，不能传入伪缓存');
  return { formula: value.formula };
}
async function main() {
  const [, , input, output] = process.argv;
  if (!input || !output || !output.toLowerCase().endsWith('.xlsx') || fs.existsSync(output)) throw Error('需要参数文件和不存在的XLSX输出路径');
  if (fs.statSync(input).size > 1000000) throw Error('参数文件超过1MB');
  const spec = JSON.parse(fs.readFileSync(input, 'utf8')); object(spec, ['sheets']);
  if (!Array.isArray(spec.sheets) || !spec.sheets.length || spec.sheets.length > 20) throw Error('需要1至20张工作表');
  const book = new Excel.Workbook(), names = new Set(); let count = 0;
  book.calcProperties.fullCalcOnLoad = true;
  for (const sheet of spec.sheets) {
    object(sheet, ['name', 'rows']);
    if (typeof sheet.name !== 'string' || !sheet.name.trim() || sheet.name.length > 31 || /[\\/*?:\[\]\x00-\x1f]/.test(sheet.name) || names.has(sheet.name.toLowerCase())) throw Error('工作表名称无效或重复');
    names.add(sheet.name.toLowerCase());
    if (!Array.isArray(sheet.rows) || sheet.rows.length > 10000) throw Error('工作表行数无效');
    const target = book.addWorksheet(sheet.name);
    for (const row of sheet.rows) {
      if (!Array.isArray(row) || row.length > 200 || (count += row.length) > 50000) throw Error('单元格数量超限');
      target.addRow(row.map(cell));
    }
  }
  const buffer = Buffer.from(await book.xlsx.writeBuffer());
  const reopened = new Excel.Workbook(); await reopened.xlsx.load(buffer);
  if (reopened.worksheets.length !== spec.sheets.length) throw Error('生成工作表数量不一致');
  for (const sheet of spec.sheets) {
    const actual = reopened.getWorksheet(sheet.name);
    if (!actual) throw Error('生成工作表缺失');
    sheet.rows.forEach((row, r) => row.forEach((expected, c) => {
      const got = actual.getCell(r + 1, c + 1).value;
      if (expected && typeof expected === 'object' ? got?.formula !== expected.formula || got?.result !== undefined : got !== expected && !(expected === '' && got === null)) throw Error('生成单元格内容与参数不一致');
    }));
  }
  fs.writeFileSync(output, buffer, { flag: 'wx' });
  console.log(JSON.stringify({ generated: true, verification: 'passed', recalculation: 'not-performed', visual: 'not-performed' }));
}
main().catch(error => { console.error('Excel生成失败：' + error.message); process.exitCode = 1; });
