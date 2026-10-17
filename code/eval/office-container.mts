import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startWorker } from '../scripts/skill-worker.mjs';
import { officeSkillArchive,officeSkillNames } from '../packages/server/src/database/office-skills.js';
import { decodePackageZip } from '../packages/server/src/skill-package-store.js';
import { parserProgram,validateParsedDocument } from '../packages/server/src/database/document-parser.js';
const token=randomBytes(32).toString('hex');
const worker=await startWorker({token,image:process.env.WORKPIVOT_TEST_IMAGE??'workpivot-executor:office-stage-20261017-v2',port:0,owner:'workpivot-office-stage-test'});
const address=worker.server.address();assert.ok(address&&typeof address!=='string');
const endpoint=`http://127.0.0.1:${address.port}`;
const resources:[string,string][]=[];
for(const name of officeSkillNames)for(const [path,data] of Object.entries(decodePackageZip(name,officeSkillArchive(name)).files))resources.push([name+'/'+path,data]);
resources.push(['parser/read.py',Buffer.from(parserProgram).toString('base64')]);
const encode=(value:unknown)=>Buffer.from(typeof value==='string'?value:JSON.stringify(value)).toString('base64');
let count=0;const check=(ok:unknown,label:string)=>{assert.ok(ok,label);count++;console.log('通过：'+label);};
const run=async(command:string,files:[string,string][],ok=true)=>{
 const response=await fetch(endpoint+'/v1/run',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({command,files,skills:resources}),signal:AbortSignal.timeout(145000)});
 const result=await response.json() as {files?:[string,string][];error?:string;output?:string};
 if(ok)assert.ok(response.ok,result.error);else assert.ok(!response.ok&&!result.files,'失败不能返回待发布文件');
 return result;
};
const file=(result:{files?:[string,string][]},name:string)=>{const row=result.files?.find(f=>f[0]===name);assert.ok(row,'缺少 '+name);return row;};
const evidence=await mkdtemp(join(tmpdir(),'workpivot-office-stage-evidence-'));
try {
 const generated=await run('node /skills/pptx-report/scripts/generate.cjs /workspace/ppt.json /workspace/slides.pptx && python3 /skills/pptx-report/scripts/convert.py --source /workspace/slides.pptx --mode render --output /workspace/slides.pdf && pdftoppm -f 1 -l 1 -singlefile -scale-to 1800 -png /workspace/slides.pdf /workspace/preview',[
  ['ppt.json',encode({slides:[{title:'WorkPivot 文档验收',bullets:['中文内容与数字 12345','生成、读取和修改验证']},{title:'第二页',bullets:['保留未修改内容']}]})]
 ]);
 check(!!file(generated,'slides.pdf'),'真实无网络容器生成PPT并渲染PDF');
 const preview=file(generated,'preview.png');await writeFile(join(evidence,'slides.pdf'),Buffer.from(file(generated,'slides.pdf')[1],'base64'));await writeFile(join(evidence,'preview.png'),Buffer.from(preview[1],'base64'));
 const image=await run('python3 /skills/parser/read.py .png',[['source.png',preview[1]]]);
 const recognized=validateParsedDocument(JSON.parse(Buffer.from(file(image,'parsed.json')[1],'base64').toString()));
 check(recognized.parts.some(p=>p.text.replace(/\s/g,'').includes('12345'))&&recognized.parts.some(p=>p.recognition?.method==='ocr'),'图片OCR包含真实文字、来源和置信度');
 const jpeg=await run("python3 -c \"from PIL import Image; Image.open('input.png').convert('RGB').save('source.jpg')\" && python3 /skills/parser/read.py .jpg",[['input.png',preview[1]]]);
 check(validateParsedDocument(JSON.parse(Buffer.from(file(jpeg,'parsed.json')[1],'base64').toString())).parts.some(p=>p.text.replace(/\s/g,'').includes('12345')),'JPEG图片使用同一OCR流程');
 const rotated=await run("python3 -c \"from PIL import Image; Image.open('input.png').rotate(90,expand=True).save('source.png')\" && python3 /skills/parser/read.py .png",[['input.png',preview[1]]]);
 check(validateParsedDocument(JSON.parse(Buffer.from(file(rotated,'parsed.json')[1],'base64').toString())).parts.some(p=>p.text.replace(/\s/g,'').includes('12345')),'旋转图片按有界识别流程可读');
 const scanned=await run("python3 -c \"from PIL import Image; Image.open('input.png').convert('RGB').save('source.pdf')\" && python3 /skills/parser/read.py .pdf",[['input.png',preview[1]]]);
 const scan=validateParsedDocument(JSON.parse(Buffer.from(file(scanned,'parsed.json')[1],'base64').toString()));
 check(scan.parts.some(p=>p.location==='page:1'&&p.recognition?.method==='ocr')&&scan.coverage==='partial','扫描PDF回退OCR保留页码及部分识别状态');
 const mixed=await run("python3 -c \"from PIL import Image; Image.open('input.png').convert('RGB').save('scan.pdf')\" && pdfunite scan.pdf native.pdf source.pdf && python3 /skills/parser/read.py .pdf",[['input.png',preview[1]],['native.pdf',file(generated,'slides.pdf')[1]]]);
 const mixedParsed=validateParsedDocument(JSON.parse(Buffer.from(file(mixed,'parsed.json')[1],'base64').toString()));
 check(mixedParsed.parts.some(p=>p.location==='page:1'&&p.recognition?.method==='ocr')&&mixedParsed.parts.some(p=>p.location==='page:2'&&!p.recognition),'混合PDF逐页选择OCR并保留原生文字页');
 await run("python3 -c \"from PIL import Image; Image.new('RGB',(200,200),'white').save('source.png')\" && python3 /skills/parser/read.py .png",[],false);check(true,'空白图片不伪造识别成功');
 const excel=await run('node /skills/xlsx-report/scripts/generate.cjs /workspace/excel.json /workspace/raw.xlsx && python3 /skills/xlsx-report/scripts/convert.py --source /workspace/raw.xlsx --mode recalculate --output /workspace/done.xlsx',[
  ['excel.json',encode({sheets:[{name:'预算',rows:[['金额'],[10],[20],[{formula:'SUM(A2:A3)'}]]}]})]
 ]);
 const parsedExcel=await run('python3 /skills/parser/read.py .xlsx',[['source.xlsx',file(excel,'done.xlsx')[1]]]);
 check(validateParsedDocument(JSON.parse(Buffer.from(file(parsedExcel,'parsed.json')[1],'base64').toString())).parts.some(p=>p.object?.formula==='SUM(A2:A3)'&&p.object.cached==='30'),'容器中真实公式重算并由共用解析器核对缓存');
 const failed=await run('node /skills/xlsx-report/scripts/generate.cjs /workspace/excel.json /workspace/raw.xlsx && python3 /skills/xlsx-report/scripts/convert.py --source /workspace/raw.xlsx --mode recalculate --output /workspace/done.xlsx',[
  ['excel.json',encode({sheets:[{name:'预算',rows:[[{formula:'1/0'}]]}]})]
 ],false);check(!!failed.error,'错误公式不发布伪成功成果');
 await run('node /skills/xlsx-report/scripts/generate.cjs /workspace/excel.json /workspace/raw.xlsx && python3 /skills/xlsx-report/scripts/convert.py --source /workspace/raw.xlsx --mode recalculate --output /workspace/done.xlsx',[
  ['excel.json',encode({sheets:[{name:'预算',rows:[[{formula:'WEBSERVICE("https://example.invalid")'}]]}]})]
 ],false);check(true,'不支持的联网公式在转换前拒绝');
 await run("python3 -c \"import zipfile; z=zipfile.ZipFile('input.pptx'); o=zipfile.ZipFile('missing.pptx','w'); [o.writestr(i,z.read(i.filename).replace(b'Noto Sans CJK SC',b'WorkPivot Missing Font 123')) for i in z.infolist()]; o.close()\" && python3 /skills/pptx-report/scripts/convert.py --source /workspace/missing.pptx --mode render --output /workspace/missing.pdf",[['input.pptx',file(generated,'slides.pptx')[1]]],false);check(true,'明确指定但未安装的字体使渲染失败');
 console.log(`容器文档验收：${count}/${count}通过；视觉证据：${evidence}`);
} finally {await worker.close();}
