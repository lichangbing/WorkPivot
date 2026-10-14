import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {parseDocument} from '../packages/server/src/database/document-parser.js';
const require=createRequire('/app/packages/server/package.json');
const Excel=require('exceljs'),{Document,Packer,Paragraph}=require('docx'),Pptx=require('pptxgenjs');
const config=JSON.parse(await readFile('/data/workpivot/worker.json','utf8'));
const word=await Packer.toBuffer(new Document({sections:[{children:[new Paragraph('Office parser fixture')]}]}));
const book=new Excel.Workbook();book.addWorksheet('Budget').getCell('B2').value={formula:'10+20',result:30};
const ppt=new Pptx();ppt.addSlide().addText('Slide parser fixture',{x:1,y:1,w:5,h:1});
const stream='BT /F1 12 Tf 72 720 Td (PDF parser fixture) Tj ET';
const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
let pdf='%PDF-1.4\n';const offsets=[0];for(const [i,obj] of objects.entries()){offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${obj}\nendobj\n`;}
const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(o=>String(o).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
const cases:[string,Buffer,string,string][]=[['.docx',word,'paragraph:1','Office parser fixture'],['.xlsx',Buffer.from(await book.xlsx.writeBuffer()),'sheet:Budget!B2','formula=10+20; cached=30'],['.pptx',Buffer.from(await ppt.write({outputType:'nodebuffer'})),'slide:1','Slide parser fixture'],['.pdf',Buffer.from(pdf),'page:1','PDF parser fixture']];
for(const [ext,data,location,text] of cases){const parts=await parseDocument(config,ext,data);assert(parts.some(p=>p.location===location&&p.text.includes(text)));console.log('PASS isolated '+ext+' extraction with source location');}
await assert.rejects(parseDocument(config,'.docx',Buffer.from('not a zip')));console.log('PASS malformed Office rejected; no user records written');
