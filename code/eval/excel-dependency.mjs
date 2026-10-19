// 使用工程实际依赖验证解压器替换，不能用另装的候选包冒充。
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {Readable} from 'node:stream';
const require=createRequire(new URL('../packages/server/package.json',import.meta.url));
const Excel=require('exceljs');
const excelRequire=createRequire(require.resolve('exceljs'));
assert.equal(excelRequire('unzipper/package.json').version,'0.12.3');
const book=new Excel.Workbook();book.properties.date1904=true;
const sheet=book.addWorksheet('业务样本');
sheet.addRow(['区域','数值','日期']);sheet.addRow(['华东',42,new Date('2026-10-18T00:00:00Z')]);
sheet.getCell('C2').numFmt='yyyy-mm-dd';sheet.getCell('B3').value={formula:'B2*2',result:84};
const data=Buffer.from(await book.xlsx.writeBuffer());
const loaded=new Excel.Workbook();await loaded.xlsx.load(data);
assert.equal(loaded.properties.date1904,true);
assert.equal(loaded.worksheets[0].getCell('C2').value.toISOString(),'2026-10-18T00:00:00.000Z');
assert.equal(loaded.worksheets[0].getCell('B3').value.result,84);
const rows=[];
for await(const worksheet of new Excel.stream.xlsx.WorkbookReader(Readable.from([data]),{sharedStrings:'cache',styles:'cache'})){
 for await(const row of worksheet)rows.push(row.values);
}
assert.equal(rows[1][1],'华东');assert.equal(rows[1][2],42);assert.equal(rows[2][2].result,84);
await assert.rejects(async()=>{
 for await(const worksheet of new Excel.stream.xlsx.WorkbookReader(Readable.from([Buffer.from('not-a-zip')]))){
  for await(const row of worksheet)void row;
 }
});
const contents=await excelRequire('unzipper').Open.buffer(data);
assert(contents.files.some(file=>file.path==='xl/workbook.xml'));
console.log('Excel实际依赖兼容检查：9项通过');
