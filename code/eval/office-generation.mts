import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { parserProgram, validateParsedDocument } from '../packages/server/src/database/document-parser.js';
const require = createRequire(new URL('../packages/server/package.json', import.meta.url));
const {Document,Packer,Paragraph,TextRun}=require('docx'), Excel=require('exceljs'), Zip=require('adm-zip');
const root=await mkdtemp(join(tmpdir(),'wp-generate-'));let count=0;
const check=(ok:unknown,label:string)=>{assert.ok(ok,label);count++;console.log('通过：'+label);};
const scripts=(format:string)=>resolve('packages/server/skills/'+format+'-report/scripts');
const env={...process.env,NODE_PATH:resolve('packages/server/node_modules')};
try {
 await writeFile(join(root,'parse.py'),parserProgram.replaceAll('/workspace',root));
 const parse=async(data:Buffer,ext:string)=>{await writeFile(join(root,'source.'+ext),data);execFileSync('python3',[join(root,'parse.py'),'.'+ext],{stdio:'pipe'});return validateParsedDocument(JSON.parse(await readFile(join(root,'parsed.json'),'utf8')));};
 const template=await Packer.toBuffer(new Document({sections:[{children:[new Paragraph({children:[new TextRun({text:'客户：{{客',bold:true}),new TextRun('户}}，{{客户}}；保留原文')]}),new Paragraph('金额{{金额}}')]}]}));
 const fields={'客户':'张三 & <公司>','金额':'100'};
 const input=join(root,'template.docx'),out=join(root,'filled.docx'),json=join(root,'fields.json');
 await writeFile(input,template);await writeFile(json,JSON.stringify(fields));
 const args=['--template',input,'--fields',json,'--output',out];
 execFileSync('python3',[join(scripts('docx'),'template.py'),...args],{stdio:'pipe'});
 const data=await readFile(out),parsed=await parse(data,'docx');
 check(parsed.parts.some(p=>p.text==='客户：张三 & <公司>，张三 & <公司>；保留原文'),'Word跨片段与重复字段正确替换并转义');
 check((await readFile(input)).equals(template),'模板原件逐字节不变');
 const before=new Zip(template),after=new Zip(data);
 check(before.getEntries().filter((e:{entryName:string})=>e.entryName!=='word/document.xml').every((e:{entryName:string})=>before.readFile(e.entryName).equals(after.readFile(e.entryName))),'未修改的压缩包成员逐字节保留');
 check(after.readAsText('word/document.xml').includes('<w:b/>'),'字段起点的加粗样式保留');
 check(spawnSync('python3',[join(scripts('docx'),'template.py'),...args]).status===1&&(await readFile(out)).equals(data),'已存在输出拒绝覆盖');
 for(const invalid of [{'客户':'缺金额'}, {...fields,extra:'多余'}, {...fields,'金额':'两行\n内容'}, {...fields,'金额':'{{嵌套}}'}]) {
  await writeFile(json,JSON.stringify(invalid));const failed=join(root,'failed.docx');
  check(spawnSync('python3',[join(scripts('docx'),'template.py'),'--template',input,'--fields',json,'--output',failed]).status===1,'不完整或不支持字段拒绝生成');await assert.rejects(access(failed));
 }
 await writeFile(json,JSON.stringify(fields));
 const book=new Excel.Workbook(),sheet=book.addWorksheet('数据');sheet.getCell('A1').value={richText:[{text:'{{客'},{text:'户}}'}]};sheet.getCell('B1').value='{{金额}}';sheet.getCell('C1').value={formula:'1+1',result:2};
 const xinput=join(root,'template.xlsx'),xout=join(root,'filled.xlsx');await writeFile(xinput,Buffer.from(await book.xlsx.writeBuffer()));
 execFileSync('python3',[join(scripts('xlsx'),'template.py'),'--template',xinput,'--fields',json,'--output',xout],{stdio:'pipe'});
 const xp=await parse(await readFile(xout),'xlsx');
 check(xp.parts.some(p=>p.text===fields['客户'])&&xp.parts.some(p=>p.object?.formula==='1+1'&&p.object.cached==='2'),'Excel富文本字段填充且原公式缓存保持');
 const bad=new Zip(template);bad.addFile('word/header1.xml',Buffer.from('<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>{{客户}}</w:t></w:r></w:p></w:hdr>'));await writeFile(input,bad.toBuffer());
 check(spawnSync('python3',[join(scripts('docx'),'template.py'),'--template',input,'--fields',json,'--output',join(root,'header.docx')]).status===1,'页眉等不支持区域有字段时明确失败');
 for(const format of ['docx','xlsx']) {
  const spec=format==='docx'?{title:'中文标题',paragraphs:['首段内容'],tables:[[['列一','列二'],['值一','值二']]]}:{sheets:[{name:'数据',rows:[['普通等号文本','=1+1'],[1,2,{formula:'SUM(A2:B2)'}]]}]};
  const specPath=join(root,format+'.json'),output=join(root,'new.'+format);await writeFile(specPath,JSON.stringify(spec));
  execFileSync(process.execPath,[join(scripts(format),'generate.cjs'),specPath,output],{env,stdio:'pipe'});
  const result=await parse(await readFile(output),format);
  check(format==='docx'?result.parts.some(p=>p.text==='值二'):result.parts.some(p=>p.text==='=1+1'&&!p.object?.formula)&&result.parts.some(p=>p.object?.formula==='SUM(A2:B2)'&&p.object.cached===''),format+'结构化参数生成并独立解析核对');
  const verified=JSON.parse(execFileSync('python3',[join(scripts(format),'verify.py'),output,'--expect-text',format==='docx'?'首段内容':'普通等号文本'],{encoding:'utf8'}));
  check(verified.expectedText==='passed',format+'内容检查器核对成功');
  check(spawnSync(process.execPath,[join(scripts(format),'generate.cjs'),specPath,output],{env}).status===1,format+'生成器拒绝覆盖已有成果');
  await writeFile(specPath,JSON.stringify({...spec,unknown:'不支持'}));
  check(spawnSync(process.execPath,[join(scripts(format),'generate.cjs'),specPath,join(root,'invalid.'+format)],{env}).status===1,format+'拒绝静默忽略未知参数');
 }
 const inline=new Zip(await readFile(xinput));
 inline.updateFile('xl/worksheets/sheet1.xml',Buffer.from('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>{{客户}}</t></is></c><c r="B1" t="inlineStr"><is><t>{{金额}}</t></is></c></row></sheetData></worksheet>'));
 // 删除未使用共享字符串中的字段，避免把无引用条目当作另一份待填充模板。
 inline.deleteFile('xl/sharedStrings.xml');await writeFile(xinput,inline.toBuffer());
 const inlineOut=join(root,'inline.xlsx');
 execFileSync('python3',[join(scripts('xlsx'),'template.py'),'--template',xinput,'--fields',json,'--output',inlineOut],{stdio:'pipe'});
 check((await parse(await readFile(inlineOut),'xlsx')).parts.some(p=>p.text===fields['客户']),'Excel inlineStr字段正确填充');
 const tampered=new Zip(await readFile(join(root,'new.docx')));tampered.updateFile('word/document.xml',Buffer.from(tampered.readAsText('word/document.xml').replace('首段内容','被篡改内容')));await writeFile(join(root,'tampered.docx'),tampered.toBuffer());
 await writeFile(join(root,'check.json'),JSON.stringify({title:'中文标题',paragraphs:['首段内容'],tables:[[['列一','列二'],['值一','值二']]]}));
 check(spawnSync('python3',[join(scripts('docx'),'check-generation.py'),join(root,'check.json'),join(root,'tampered.docx')]).status!==0,'独立内容核对器拒绝被改动的正文');
 const unsafe=new Zip(template);unsafe.updateFile('word/document.xml',Buffer.from('<?xml version="1.0" encoding="UTF-16"?><!DOCTYPE document [<!ENTITY x "文本">]><document>&x;</document>','utf16le'));await writeFile(join(root,'unsafe.docx'),unsafe.toBuffer());
 check(spawnSync('python3',[join(scripts('docx'),'verify.py'),join(root,'unsafe.docx')]).status===1,'检查器拒绝UTF-16实体声明');
 console.log(`Office生成：${count}/${count}通过`);
} finally {await rm(root,{recursive:true,force:true});}
