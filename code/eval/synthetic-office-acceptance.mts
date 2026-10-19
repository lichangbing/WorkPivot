import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdir,mkdtemp,readFile,writeFile,copyFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {startWorker} from '../scripts/skill-worker.mjs';
import {pool,installSchema,transaction} from '../packages/server/src/database/connection.js';
import {AccountRepository} from '../packages/server/src/database/accounts.js';
import {WorkspaceRepository} from '../packages/server/src/database/workspace.js';
import {FileRepository} from '../packages/server/src/database/files.js';
import {DocumentProcessing} from '../packages/server/src/database/document-processing.js';
import {KnowledgeRepository} from '../packages/server/src/database/knowledge.js';
import {parseDocumentResult,type ParsedDocument} from '../packages/server/src/database/document-parser.js';

// 合成资料与验收证据保留在独立目录；数据库、账号和执行器只用于本轮。
const target=process.env.WORKPIVOT_TEST_PG_URL;
if(process.env.WORKPIVOT_TEST_PG_DISPOSABLE!=='1'||!target||new URL(target).hostname!=='127.0.0.1'||new URL(target).pathname!=='/workpivot_test')throw Error('仅允许一次性本机数据库');
const parent=resolve('../local-runtime/acceptance');await mkdir(parent,{recursive:true});
const root=await mkdtemp(join(parent,'synthetic-office-')),sources=join(root,'originals'),outputs=join(root,'outputs');
await mkdir(sources);await mkdir(outputs);
const require=createRequire(new URL('../packages/server/package.json',import.meta.url));
const {Document,Packer,Paragraph,Table,TableRow,TableCell,WidthType}=require('docx'),Excel=require('exceljs'),Pptx=require('pptxgenjs');
const checks:string[]=[],boundaries:Record<string,unknown>={};
const check=(ok:unknown,label:string)=>{assert.ok(ok,label);checks.push(label);console.log('通过：'+label);};
const hash=(data:Buffer)=>createHash('sha256').update(data).digest('hex');
const secret=randomBytes(32).toString('hex'),admin=pool(target);
const urlFor=(name:string)=>{const url=new URL(target);url.username=name;url.password=secret;return url.href;};
const db=pool(urlFor('synthetic_app')),auth=pool(urlFor('synthetic_auth'));
let worker:Awaited<ReturnType<typeof startWorker>>|undefined;
const manifest:Array<{name:string;sha256:string;bytes:number}>=[];
try{
 const cell=(text:string)=>new TableCell({children:[new Paragraph(text)]});
 const rows=[new TableRow({tableHeader:true,children:['地区','销售额（万元）','合同日期'].map(cell)}),...Array.from({length:72},(_,i)=>new TableRow({children:[i===0?'华东':i===1?'华北':'区域'+String(i+1).padStart(2,'0'),String(i===0?120:i===1?80:10+i),'2026-10-18'].map(cell)}))];
 const word=new Document({styles:{default:{document:{run:{font:'Noto Sans CJK SC',size:22}}}},sections:[{children:[new Paragraph({text:'合成销售结算报告',heading:'Heading1'}),new Paragraph('仅用于WorkPivot测试；不对应真实公司或个人。'),new Paragraph('结算编号 SYN20261018；回款金额 12345 元；负责人 测试甲。'),new Paragraph('合同日期：2026-10-18。所有金额和日期均为人工设定的标准答案。'),new Paragraph({text:'跨页销售明细',pageBreakBefore:true,heading:'Heading1'}),new Table({width:{size:100,type:WidthType.PERCENTAGE},rows})]}]});
 await writeFile(join(sources,'sales-report.docx'),await Packer.toBuffer(word));
 for(const epoch of [false,true]){
  const book=new Excel.Workbook();book.properties.date1904=epoch;const sheet=book.addWorksheet('销售明细');
  sheet.addTable({name:'Sales',ref:'A1',headerRow:true,columns:[{name:'地区'},{name:'销售额（万元）'},{name:'合同日期'}],rows:[['华东',120,new Date('2026-10-18T00:00:00Z')],['华北',80,new Date('2026-10-19T00:00:00Z')]]});
  sheet.getColumn(3).numFmt='yyyy-mm-dd';sheet.getCell('A4').value='合计';sheet.getCell('B4').value={formula:'SUM(B2:B3)',result:200};
  const info=book.addWorksheet('说明');info.mergeCells('A1:C1');info.getCell('A1').value='仅为合成数据，金额单位万元';
  await book.xlsx.writeFile(join(sources,epoch?'sales-1904.xlsx':'sales-1900.xlsx'));
 }
 const ppt=new Pptx();ppt.layout='LAYOUT_WIDE';ppt.author='WorkPivot 合成验收';ppt.subject='无真实业务资料';
 const title=ppt.addSlide();title.addText('合成季度经营汇报',{x:0.7,y:0.5,w:11,h:0.8,fontFace:'Noto Sans CJK SC',fontSize:28});title.addText('华东销售额：120万元\n华北销售额：80万元\n合计：200万元',{x:0.7,y:1.7,w:8,h:2.2,fontFace:'Noto Sans CJK SC',fontSize:24});
 const chart=ppt.addSlide();chart.addText('图表与备注能力边界',{x:0.7,y:0.5,w:11,h:0.8,fontFace:'Noto Sans CJK SC',fontSize:28});chart.addChart(ppt.ChartType.bar,[{name:'仅图表数值',labels:['样例A','样例B'],values:[34567,45678]}],{x:1,y:1.6,w:10,h:4,fontFace:'Noto Sans CJK SC',showValue:true});chart.addNotes('备注专用标识 NOTES_ONLY_SYN_20261018；不得用正文解析冒充已读备注。');
 await ppt.writeFile({fileName:join(sources,'quarterly-review.pptx')});
 const env={...process.env,SAL_USE_VCLPLUGIN:'gen'};
 execFileSync('libreoffice',[`-env:UserInstallation=${pathToFileURL(join(root,'lo-profile')).href}`,'--headless','--convert-to','pdf','--outdir',sources,join(sources,'sales-report.docx')],{env,stdio:'pipe',timeout:60000});
 execFileSync('pdftoppm',['-f','1','-l','1','-singlefile','-scale-to','2200','-png',join(sources,'sales-report.pdf'),join(outputs,'scan-source')],{stdio:'pipe'});
 execFileSync('python3',['-c','from PIL import Image; import sys; Image.open(sys.argv[1]).convert("RGB").save(sys.argv[2],resolution=180)',join(outputs,'scan-source.png'),join(sources,'scanned-receipt.pdf')],{stdio:'pipe'});
 execFileSync('pdfunite',[join(sources,'scanned-receipt.pdf'),join(sources,'sales-report.pdf'),join(sources,'mixed-report.pdf')],{stdio:'pipe'});
 const names=['sales-report.docx','sales-1900.xlsx','sales-1904.xlsx','quarterly-review.pptx','sales-report.pdf','scanned-receipt.pdf','mixed-report.pdf'];
 for(const name of names){const data=await readFile(join(sources,name));manifest.push({name,sha256:hash(data),bytes:data.length});}
 await writeFile(join(root,'manifest.json'),JSON.stringify({synthetic:true,documents:manifest,answers:{eastSalesWan:120,northSalesWan:80,totalSalesWan:200,contractDate:'2026-10-18',receiptAmountYuan:12345,receiptNumber:'SYN20261018',chartOnly:[34567,45678],notesOnly:'NOTES_ONLY_SYN_20261018'},limitations:['图表数值、备注是否被解析必须单独观察','扫描识别需核对数字','不代表真实业务或第二设备验收']},null,2));
 worker=await startWorker({token:secret,image:process.env.WORKPIVOT_TEST_IMAGE??'workpivot-executor:office-stage-20261017-v2',port:0,owner:'workpivot-synthetic-office-test'});
 const address=worker.server.address();assert(address&&typeof address!=='string');const config={url:`http://127.0.0.1:${address.port}`,token:secret};
 await admin.query(`CREATE ROLE synthetic_app LOGIN PASSWORD '${secret}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; CREATE ROLE synthetic_auth LOGIN PASSWORD '${secret}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
 await installSchema(admin,'synthetic_app','synthetic_auth');
 const actor=(await new AccountRepository(auth).registerFirst('synthetic-office',secret,secret,secret)).user.id;
 const workspace=new WorkspaceRepository(db),project=await workspace.createProject(actor,'合成业务验收'),task=await workspace.createTask(actor,'原件解析',project.id),questionTask=await workspace.createTask(actor,'跨任务引用',project.id);
 const files=new FileRepository(db,join(root,'isolated-files')),processing=DocumentProcessing.worker(db,files,config),knowledge=new KnowledgeRepository(db);
 const versions=new Map<string,string>(),parsed=new Map<string,ParsedDocument>();
 for(const name of names){
  const uploaded=await files.upload(actor,task.id,name,await readFile(join(sources,name)),randomUUID());versions.set(name,uploaded.id);await processing.process(actor);
  const result=await transaction(db,async c=>(await c.query('SELECT status,parts,coverage,warnings FROM workpivot.document_processing WHERE version_id=$1',[uploaded.id])).rows[0],actor);
  check(result.status==='completed',name+'通过真实隔离执行器解析');parsed.set(name,result);await writeFile(join(outputs,name+'.parsed.json'),JSON.stringify(result,null,2));
  check(await knowledge.indexNext(actor),name+'成功发布知识索引');
 }
 for(const [name,epoch] of [['sales-1900.xlsx','1900'],['sales-1904.xlsx','1904']]){
  const date=parsed.get(name)!.parts.find(p=>p.location==='sheet:销售明细!C2')!;
  check(date.object?.dateSystem===epoch&&date.object.normalizedValue==='2026-10-18',name+'日期基准与实际日期一致');
  check(parsed.get(name)!.parts.some(p=>p.object?.formula==='SUM(B2:B3)'&&p.object.cached==='200'),name+'公式与缓存同时保留');
 }
 for(const name of ['sales-report.docx','sales-1900.xlsx']){
  const result=await knowledge.search(actor,questionTask.id,'华东 销售额',undefined,[versions.get(name)!]);
  check(result.matches.some(m=>m.content.includes('华东')&&m.content.includes('120')&&m.content.includes('销售额（万元）')),name+'真实数据库检索保持行列与单位');
  check(result.matches.every(m=>m.versionId===versions.get(name)&&m.citation.includes('#citation/')),name+'引用绑定已选版本');
 }
 check(!(await knowledge.search(actor,questionTask.id,'华东',undefined,[])).matches.length,'撤销文件范围后检索为空');
 const unrelated=await workspace.createTask(actor,'无项目范围');check(!(await knowledge.search(actor,unrelated.id,'华东',undefined,[versions.get('sales-report.docx')!])).matches.length,'跨项目不能通过指定版本越权检索');
 const native=parsed.get('sales-report.pdf')!;check(native.parts.length>=3&&native.parts.some(p=>/区域\s*72\s+81\s+2026-10-18/.test(p.text)),'原生PDF跨页明细末行可读');
 const scan=parsed.get('scanned-receipt.pdf')!;check(scan.coverage==='partial'&&scan.parts.some(p=>p.recognition?.method==='ocr'&&p.text.replace(/\s/g,'').includes('12345')),'扫描PDF金额识别且明确OCR部分覆盖');
 const mixed=parsed.get('mixed-report.pdf')!;check(mixed.parts.some(p=>p.location==='page:1'&&p.recognition?.method==='ocr')&&mixed.parts.some(p=>p.location==='page:2'&&!p.recognition),'混合PDF分别保留扫描页和原生文字页定位');
 const pptParsed=parsed.get('quarterly-review.pptx')!;check(pptParsed.parts.some(p=>p.text.includes('120万元')),'PPT正文数值可读取');
 const pptText=pptParsed.parts.map(p=>p.text).join('\n');check(pptText.includes('34567')&&pptText.includes('45678'),'PPT原生图表缓存数值可读');check(pptText.includes('NOTES_ONLY_SYN_20261018'),'PPT备注可读');
 const chartSearch=await knowledge.search(actor,questionTask.id,'34567',undefined,[versions.get('quarterly-review.pptx')!]);check(chartSearch.matches.some(m=>m.content.includes('34567')&&m.content.includes('样例A')&&m.content.includes('仅图表数值')),'PPT图表检索保留系列分类及数值');
 const noteSearch=await knowledge.search(actor,questionTask.id,'NOTES_ONLY_SYN_20261018',undefined,[versions.get('quarterly-review.pptx')!]);check(noteSearch.matches.some(m=>m.content.includes('备注')&&m.content.includes('NOTES_ONLY_SYN_20261018')),'PPT备注进入知识库且标注来源');
 boundaries.ppt={chartValuesRead:true,notesRead:true,notice:'仅读取传统图表缓存和备注；缓存未重算，不代表图片或复杂版式理解'};
 const original=await readFile(join(sources,'sales-1900.xlsx'));const changes=join(outputs,'excel-changes.json');await writeFile(changes,JSON.stringify({sourceSha256:hash(original),changes:[{sheet:'销售明细',address:'B2',expected:'120',value:150}]}));
 execFileSync('python3',[resolve('packages/server/skills/xlsx-report/scripts/edit.py'),'--source',join(sources,'sales-1900.xlsx'),'--changes',changes,'--output',join(outputs,'sales-edited.xlsx')],{stdio:'pipe'});
 const edited=await parseDocumentResult(config,'.xlsx',await readFile(join(outputs,'sales-edited.xlsx')));check(edited.parts.some(p=>p.location==='sheet:销售明细!B2'&&p.text==='150')&&edited.parts.some(p=>p.object?.formula==='SUM(B2:B3)'&&p.object.cached===''),'Excel修改后清除旧合计缓存');
 execFileSync('python3',[resolve('packages/server/skills/xlsx-report/scripts/convert.py'),'--source',join(outputs,'sales-edited.xlsx'),'--mode','recalculate','--output',join(outputs,'sales-recalculated.xlsx')],{stdio:'pipe',timeout:85000});
 check((await parseDocumentResult(config,'.xlsx',await readFile(join(outputs,'sales-recalculated.xlsx')))).parts.some(p=>p.object?.cached==='230'&&p.object?.formula==='SUM(B2:B3)'),'Excel真实重算合计为230万元');
 for(const entry of manifest)check(hash(await readFile(join(sources,entry.name)))===entry.sha256,entry.name+'原件哈希不变');
 await writeFile(join(root,'report.json'),JSON.stringify({passed:true,checks,boundaries,scope:'合成样本；真实隔离解析、PostgreSQL关键词检索及受限修改；未调用真实模型或向量服务，未验收第二设备'},null,2));
 await copyFile(join(outputs,'scan-source.png'),join(root,'preview.png'));
 console.log(JSON.stringify({root,passed:checks.length,boundaries}));
}catch(error){await writeFile(join(root,'report.json'),JSON.stringify({passed:false,checks,boundaries,error:error instanceof Error?error.message:'验收失败'},null,2));throw error;}
finally{await worker?.close();await Promise.all([db.end(),auth.end(),admin.end()]);await rm(join(root,'isolated-files'),{recursive:true,force:true});}
