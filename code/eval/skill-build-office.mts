import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {SkillBuilds} from '../packages/server/src/database/skill-builds.js';

/** 代表性办公用例在真实沙箱内创建合成 Excel，并检查生成 Word 的内部正文。 */
export async function testBuiltOffice(builds:SkillBuilds,actor:string,taskId:string,check:(v:unknown,n:string)=>void){
 const script=`// 将指定 Excel 第二列的数值合计写入 Word。\nconst Excel=require('exceljs');const {Document,Packer,Paragraph}=require('docx');const fs=require('node:fs');\nmodule.exports=async function(input,output){const book=new Excel.Workbook();await book.xlsx.readFile(input);let total=0;book.worksheets[0].eachRow((row,index)=>{if(index>1)total+=Number(row.getCell(2).value)||0;});const doc=new Document({sections:[{children:[new Paragraph('合计：'+total)]}]});fs.writeFileSync(output,await Packer.toBuffer(doc));return total;};`;
 const test=`// 合成 Excel 和 Word 不读取业务文件；检查合计及 DOCX 内部正文。\nconst assert=require('node:assert/strict');const Excel=require('exceljs');const Zip=require('adm-zip');const fs=require('node:fs');const generate=require('../scripts/office.cjs');\n(async()=>{const book=new Excel.Workbook();const sheet=book.addWorksheet('数据');sheet.addRow(['项目','金额']);sheet.addRow(['A',10]);sheet.addRow(['B',20]);await book.xlsx.writeFile('/workspace/input.xlsx');const total=await generate('/workspace/input.xlsx','/workspace/report.docx');assert.equal(total,30);const xml=new Zip('/workspace/report.docx').readAsText('word/document.xml');assert.ok(xml.includes('合计：30'));fs.writeFileSync('/workspace/result.json',JSON.stringify({total,wordVerified:true}));console.log('Excel 合计30，Word正文检查通过');})().catch(e=>{console.error(e.message);process.exitCode=1;});`;
 let b=await builds.propose(actor,taskId,{requestId:randomUUID(),displayName:'Excel转Word测试技能',purpose:'完整草稿办公试运行',files:[{path:'SKILL.md',content:'---\nname: office-build\ndescription: 汇总Excel并生成Word\n---\n\n# 输入输出\n输入指定Excel，输出Word。\n# 操作\n调用[scripts/office.cjs](scripts/office.cjs)，第二列求和后生成Word。\n# 验证\n运行 node {{skill_root}}/tests/run.cjs，检查合计和Word正文。'},{path:'scripts/office.cjs',content:script},{path:'tests/run.cjs',content:test}]});
 b=await builds.validate(actor,b.id,b.revision);assert.ok(b.validation?.valid);
 b=await builds.trial(actor,b.id,b.revision,{command:`node /skills/${b.name}/tests/run.cjs`,outputs:['report.docx','result.json']});
 check(b.trial?.passed&&b.trial.previews.some(p=>p.path==='report.docx'&&p.size>0)&&b.trial.previews.some(p=>p.content==='{"total":30,"wordVerified":true}'),'生成的Office草稿在真实Docker中完成Excel→Word及正文断言');
 return b;
}
