import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {parserProgram,validateParsedDocument} from '../packages/server/src/database/document-parser.js';
import {splitKnowledge} from '../packages/server/src/database/knowledge.js';
const require=createRequire(new URL('../packages/server/package.json',import.meta.url)),Zip=require('adm-zip');
const root=await mkdtemp(join(tmpdir(),'wp-office-reliability-'));let count=0;
const check=(value:unknown,label:string)=>{assert.ok(value,label);count++;console.log('通过：'+label);};
try{
 await writeFile(join(root,'parse.py'),parserProgram.replaceAll('/workspace',root));
 const parse=async(ext:string,z:InstanceType<typeof Zip>)=>{await writeFile(join(root,'source'+ext),z.toBuffer());execFileSync('python3',[join(root,'parse.py'),ext],{stdio:'pipe'});return validateParsedDocument(JSON.parse(await readFile(join(root,'parsed.json'),'utf8')));};
 const book=(epoch:boolean,value='45000',fmt='14')=>{
  const z=new Zip();z.addFile('[Content_Types].xml',Buffer.from('<Types/>'));
  z.addFile('xl/workbook.xml',Buffer.from(`<workbook xmlns:r="urn:r"><workbookPr date1904="${epoch}"/><sheets><sheet name="数据" r:id="r1"/></sheets></workbook>`));
  z.addFile('xl/_rels/workbook.xml.rels',Buffer.from('<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>'));
  z.addFile('xl/styles.xml',Buffer.from(`<styleSheet><cellXfs><xf numFmtId="${fmt}"/></cellXfs></styleSheet>`));
  z.addFile('xl/worksheets/sheet1.xml',Buffer.from(`<worksheet><sheetData><row><c r="A1"><v>${value}</v></c></row></sheetData></worksheet>`));return z;
 };
 const a=await parse('.xlsx',book(false)),b=await parse('.xlsx',book(true));
 const ac=a.parts.find(p=>p.object?.kind==='cell')!,bc=b.parts.find(p=>p.object?.kind==='cell')!;
 check(ac.object?.rawValue==='45000'&&ac.object.dateSystem==='1900'&&bc.object?.dateSystem==='1904','原值和日期基准不丢失');
 check(ac.object?.normalizedValue==='2023-03-15'&&bc.object?.normalizedValue==='2027-03-16','两个基准相同数值转换不同且正确');
 check(ac.text.includes('2023-03-15'),'普通文字读取也包含转换日期');
 for(const [value,expected] of [['59','1900-02-28'],['61','1900-03-01']])check((await parse('.xlsx',book(false,value))).parts[1]?.object?.normalizedValue===expected,'1900闰年边界 '+value);
 const invalid=await parse('.xlsx',book(false,'60'));check(invalid.coverage==='partial'&&!invalid.parts[1]?.object?.normalizedValue,'虚构的1900-02-29不伪装真实日期');
 check((await parse('.xlsx',book(true,'0'))).parts[1]?.object?.normalizedValue==='1904-01-01','1904零序列');
 check((await parse('.xlsx',book(false,'0.5','20'))).parts[1]?.object?.normalizedValue==='12:00:00','纯时间不错误添加日期');
 check((await parse('.xlsx',book(false,'45000','0'))).parts[1]?.object?.normalizedValue===undefined,'普通数字不猜成日期');
 check((await parse('.xlsx',book(false,'-1'))).coverage==='partial','负日期序列明确警告');
 const word=new Zip();word.addFile('word/document.xml',Buffer.from('<document><body><moveFrom><p><r><t>整段移动</t></r></p></moveFrom><moveTo><p><r><t>整段移动</t></r></p></moveTo><p><moveFrom><r><t>行内移动</t></r></moveFrom><moveTo><r><t>行内移动</t></r></moveTo><del><r><t>已删除</t></r></del><ins><r><t>新增</t></r></ins></p></body></document>'));
 const revision=await parse('.docx',word),text=revision.parts.map(p=>p.text).join('|');
 check(text==='整段移动|行内移动新增','段落及行内移动只保留目标，删除内容不进入正文');
 check(revision.coverage==='partial'&&revision.warnings.some(w=>w.includes('最终正文')),'修订视图及能力边界明确提示');
 const stale=book(false);stale.addFile('xl/sharedStrings.xml',Buffer.from('<sst><si><t>当前说明</t></si><si><t>已删除的预算说明</t></si></sst>'));stale.addFile('xl/worksheets/sheet1.xml',Buffer.from('<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>'));
 const file=join(root,'check.xlsx');await writeFile(file,stale.toBuffer());
 for(const skill of ['docx-report','xlsx-report','pptx-report']){
  const script=resolve('packages/server/skills',skill,'scripts/verify.py');
  const run=(...args:string[])=>execFileSync('python3',[script,file,...args],{stdio:'pipe'});
  assert.throws(()=>run('--expect-text','已删除的预算说明'));check(true,skill+'拒绝未引用字符串');
  check(JSON.parse(run('--expect-cell',JSON.stringify({sheet:'数据',cell:'A1',value:'当前说明'})).toString()).expectedCells==='passed',skill+'按坐标匹配实际正文');
  assert.throws(()=>run('--expect-cell',JSON.stringify({sheet:'数据',cell:'B1',value:'当前说明'})));check(true,skill+'拒绝错误坐标');
 }
 const Excel=require('exceljs'),wb=new Excel.Workbook(),ws=wb.addWorksheet('销售');
 ws.addTable({name:'Sales',ref:'A3',headerRow:true,columns:[{name:'地区'},{name:'销售额（万元）'}],rows:[['华东',120],['华北',80]]});
 const z=new Zip(Buffer.from(await wb.xlsx.writeBuffer())),parsed=await parse('.xlsx',z),chunks=splitKnowledge(parsed.parts);
 const east=chunks.find(c=>c.location.endsWith(':4'))!;
 check(east.content.includes('华东')&&east.content.includes('120')&&east.content.includes('销售额（万元）')&&east.content.includes('显式表头'),'真实Excel表格行保留地区、指标、单位及数值');
 check(east.content.includes('sheet:销售!A4')&&east.content.includes('sheet:销售!B4'),'组合行保留实际单元格定位');
 const w=new Zip();w.addFile('word/document.xml',Buffer.from('<document><body><tbl><tr><trPr><tblHeader/></trPr><tc><p><t>地区</t></p></tc><tc><p><t>销售额（万元）</t></p></tc></tr><tr><tc><p><t>华东</t></p></tc><tc><p><t>120</t></p></tc></tr></tbl></body></document>'));
 const wordChunks=splitKnowledge((await parse('.docx',w)).parts),row=wordChunks.find(c=>c.location==='row:table:1:2')!;
 check(row.content.includes('华东')&&row.content.includes('120')&&row.content.includes('销售额（万元）'),'Word表格按行附带显式表头');
 check(row.content.includes('paragraph:3')&&row.content.includes('列2'),'Word引用保留段落与列位置');
 const long=parsed.parts.map(p=>p.object?.address==='B4'?{...p,text:'长值'.repeat(2000)}:p);
 const longRows=splitKnowledge(long).filter(p=>p.location.endsWith(':4'));
 check(longRows.length>1&&longRows.every(p=>p.content.includes('sheet:销售!B4')&&p.content.includes('销售额（万元）')),'长行续片重复表头和原定位');
 const fallback=parsed.parts.map(p=>p.object?{...p,object:{...p.object,tableName:undefined,tableRange:undefined}}:p);
 // 省略属性必须移除，不能作为非法undefined对象字段进入契约。
 for(const p of fallback){if(p.object){delete p.object.tableName;delete p.object.tableRange;delete p.object.headerRow;}}
 check(splitKnowledge(fallback).every(p=>p.content.includes('未确认是表头')),'未标记表头只作为上下文，不冒充表头');
 check((await parse('.xlsx',book(false,'45000','27'))).coverage==='partial','未支持的本地化日期格式明确警告');
 w.addFile('word/document.xml',Buffer.from('<document><body><tbl><tr><trPr><tblHeader val="0"/></trPr><tc><p><t>普通行</t></p></tc></tr></tbl></body></document>'));
 check(splitKnowledge((await parse('.docx',w)).parts)[0]?.content.includes('未确认是表头'),'显式关闭重复表头不能误判为表头');
 const cached=book(false,'45000','22');cached.addFile('xl/worksheets/sheet1.xml',Buffer.from('<worksheet><sheetData><row><c r="A1"><f>DATE(2023,3,15)</f><v>45000.5</v></c></row></sheetData></worksheet>'));
 const cachedDate=(await parse('.xlsx',cached)).parts[1]!;
 check(cachedDate.object?.cached==='45000.5'&&cachedDate.object.normalizedValue==='2023-03-15T12:00:00','公式缓存日期转换不覆盖原缓存与公式');
 console.log(`Office可靠性：${count}/${count}通过`);
}finally{await rm(root,{recursive:true,force:true});}
