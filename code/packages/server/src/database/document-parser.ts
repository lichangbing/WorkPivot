import { createHash } from 'node:crypto';
import type { WorkerConfiguration } from './skill-execution.js';
import { validateParsedParts, type ParsedPart } from './parsed-content.js';
export type { ParsedPart } from './parsed-content.js';

// 固定程序，不执行文档提供的命令；仅在隔离执行器中运行。
export const parserProgram = String.raw`
import sys,json,zipfile,xml.etree.ElementTree as ET,subprocess,pathlib,datetime,math,re,posixpath,io,csv
path=pathlib.Path('/workspace/source'+sys.argv[1]); parts=[]; total=0; warnings=[]
def add(location,text,object=None):
 global total
 if not text.strip() and object is None: return
 total+=len(text)+(len(json.dumps(object,ensure_ascii=False)) if object else 0)
 if total>1000000 or len(parts)>=20000: raise ValueError('extracted content exceeds limit')
 parts.append({'location':location,'text':text,**({'object':object} if object else {})})
def xml(z,name):
 data=z.read(name)
 if b'<!DOCTYPE' in data.replace(b'\x00',b'').upper() or b'<!ENTITY' in data.replace(b'\x00',b'').upper(): raise ValueError('XML entities forbidden')
 return ET.fromstring(data)
def local(e): return e.tag.split('}')[-1]
def recognize(image,location):
 import time
 from PIL import Image,ImageOps
 if time.monotonic()>ocr_deadline: raise ValueError('OCR total timeout')
 with Image.open(image) as original:
  if original.format not in ('PNG','JPEG'): raise ValueError('unsupported image format')
  if original.width*original.height>12000000: raise ValueError('image pixel limit')
  prepared=ImageOps.exif_transpose(original).convert('RGB');prepared.thumbnail((2400,2400));prepared.save('/workspace/ocr-input.png')
 best=None
 for angle in (0,90,180,270):
  if time.monotonic()>ocr_deadline: break
  prepared.rotate(angle,expand=True).save('/workspace/ocr-input.png')
  try:
   result=subprocess.run(['tesseract','/workspace/ocr-input.png','stdout','-l','chi_sim+eng','--psm','3','tsv'],check=True,timeout=max(1,min(20,ocr_deadline-time.monotonic())),capture_output=True,text=True)
   rows=list(csv.DictReader(result.stdout.splitlines(),delimiter='\t'));words=[r for r in rows if r.get('text','').strip() and float(r.get('conf','-1'))>=0]
   if not words: continue
   confidence=round(sum(float(r['conf']) for r in words)/len(words),1)
   if best is None or confidence>best[0]: best=(confidence,words,angle)
   if confidence>=70: break
  except subprocess.TimeoutExpired: break
 if best is None: raise ValueError('OCR found no words')
 confidence,words,rotation=best;lines={}
 for row in words: lines.setdefault((row['block_num'],row['par_num'],row['line_num']),[]).append(row['text'])
 add(location,'\n'.join(' '.join(line) for line in lines.values()))
 parts[-1]['recognition']={'method':'ocr','language':'chi_sim+eng','confidence':confidence,'rotation':rotation}
 warnings.append(location+'使用OCR识别，平均词置信度'+str(confidence)+'；需核对数字、表格和低质量区域，不代表整页完整识别。')
 pathlib.Path('/workspace/ocr-input.png').unlink(missing_ok=True)
import time
ocr_deadline=time.monotonic()+90;ocr_exhausted=False
ext=sys.argv[1]
if ext=='.pdf':
 subprocess.run(['pdftotext','-layout',str(path),'/workspace/plain.txt'],check=True,timeout=60,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 if pathlib.Path('/workspace/plain.txt').stat().st_size>4000000: raise ValueError('PDF text exceeds limit')
 pages=pathlib.Path('/workspace/plain.txt').read_text().split('\f')
 if pages and not pages[-1].strip(): pages.pop()
 missing=[i+1 for i,page in enumerate(pages) if not page.strip()]; missing_order={page:index for index,page in enumerate(missing)}
 if missing: warnings.append('以下页面没有可提取文字，可能为空白或扫描页，扫描页，进入有界OCR尝试：'+','.join(map(str,missing[:100])))
 for i,page in enumerate(pages):
  if page.strip(): add('page:'+str(i+1),page);continue
  if missing_order[i+1]>=10:
   if missing_order[i+1]==10: warnings.append('剩余'+str(len(missing)-10)+'页超过本次10页OCR上限，未识别。')
   continue
  if time.monotonic()>ocr_deadline:
   if not ocr_exhausted: warnings.append('OCR累计时间耗尽，剩余无文字页未识别。');ocr_exhausted=True
   continue
  try:
   subprocess.run(['pdftoppm','-f',str(i+1),'-l',str(i+1),'-singlefile','-scale-to','2400','-png',str(path),'/workspace/ocr-page'],check=True,timeout=15,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
   recognize('/workspace/ocr-page.png','page:'+str(i+1))
  except Exception: warnings.append('page:'+str(i+1)+'OCR失败、空白、资源超限或依赖不可用，可重试；未声称识别完整。')
  finally: pathlib.Path('/workspace/ocr-page.png').unlink(missing_ok=True)

 pathlib.Path('/workspace/plain.txt').unlink()
elif ext in ('.png','.jpg','.jpeg'):
 recognize(path,'image:1')
elif ext=='.csv':
 raw=path.read_bytes()
 if len(raw)>1000000: raise ValueError('CSV exceeds 1MB')
 try: text=raw.decode('utf-8-sig')
 except UnicodeDecodeError: text=raw.decode('gb18030')
 if '\x00' in text: raise ValueError('CSV contains NUL')
 try: rows=list(csv.reader(io.StringIO(text),strict=True))
 except csv.Error as exc: raise ValueError('invalid CSV') from exc
 if not rows or len(rows)>20000: raise ValueError('CSV row count invalid')
 add('sheet:CSV','',{'kind':'sheet','sheet':'CSV','state':'visible','dateSystem':'1900'})
 add('table:csv','',{'kind':'table','parent':'sheet:CSV'})
 for ri,row in enumerate(rows,1):
  if len(row)>512: raise ValueError('CSV column limit')
  for ci,value in enumerate(row,1):
   if len(value)>32768: raise ValueError('CSV cell too large')
   address='';column=ci
   while column:
    column,remainder=divmod(column-1,26);address=chr(65+remainder)+address
   address+=str(ri)
   add('sheet:CSV!'+address,value,{'kind':'cell','parent':'sheet:CSV','sheet':'CSV','address':address,'valueType':'inlineStr','rawValue':value,'headerRow':'true' if ri==1 else 'false','dateSystem':'1900'})
 warnings.append('CSV按UTF-8或GB18030文本解析；公式外观仍按文本处理，未执行计算。')
else:
 with zipfile.ZipFile(path) as z:
  info=z.infolist()
  if len({item.filename for item in info})!=len(info): raise ValueError('duplicate archive entries')
  if any('/media/' in item.filename for item in info): warnings.append('文件包含图片或媒体，仅提取文字，未识别图片中的内容。')
  if len(info)>4000 or sum(x.file_size for x in info)>32000000 or any(x.file_size>8000000 for x in info): raise ValueError('archive exceeds limit')
  if ext=='.docx':
   root=xml(z,'word/document.xml')
   revisions={local(e) for e in root.iter()} & {'ins','del','moveFrom','moveTo','cellIns','cellDel','cellMerge','tblPrChange','trPrChange','tcPrChange','pPrChange','rPrChange'}
   if revisions: warnings.append('检测到修订：按最终正文视图读取插入和移动目标，排除删除和移动来源；属性及复杂表格修订未完整还原，须核对原件。')
   def final_text(e):
    if local(e) in ('del','moveFrom','delText','delInstrText'): return ''
    if local(e)=='t': return e.text or ''
    if local(e)=='tab': return '\t'
    if local(e)=='br': return '\n'
    return ''.join(final_text(c) for c in e)
   counters={'paragraph':0,'table':0,'table-cell':0}
   def attr(e,key,default=None):
    return next((v for k,v in e.attrib.items() if k.split('}')[-1]==key),default) if e is not None else default
   def child(e,key): return next((v for v in e if local(v)==key),None) if e is not None else None
   def ident(kind):
    counters[kind]+=1
    return kind+':'+str(counters[kind])
   def blocks(container,parent=None):
    for e in container:
     kind=local(e)
     if kind=='p':
      location=ident('paragraph')
      add(location,final_text(e),{'kind':'paragraph',**({'parent':parent} if parent else {})})
     elif kind=='tbl':
      table=ident('table'); add(table,'',{'kind':'table',**({'parent':parent} if parent else {})})
      for ri,row in enumerate(v for v in e if local(v)=='tr'):
       col=1+int(attr(child(child(row,'trPr'),'gridBefore'),'val','0'))
       for cell in (v for v in row if local(v)=='tc'):
        props=child(cell,'tcPr'); span=int(attr(child(props,'gridSpan'),'val','1')); merge=child(props,'vMerge')
        location=ident('table-cell')
        add(location,'',{'kind':'table-cell','parent':table,'headerRow':'true' if child(child(row,'trPr'),'tblHeader') is not None and attr(child(child(row,'trPr'),'tblHeader'),'val','1') not in ('0','false','off') else 'false','row':ri+1,'column':col,'columnSpan':span,**({'verticalMerge':attr(merge,'val','continue')} if merge is not None else {})})
        blocks(cell,location); col+=span
     elif kind not in ('tcPr','tblPr','tblGrid','sectPr','del','moveFrom','pPr','rPr'): blocks(e,parent)
   blocks(root)
  elif ext=='.pptx':
   def relationships(source):
    relpath=posixpath.join(posixpath.dirname(source),'_rels',posixpath.basename(source)+'.rels')
    result={}
    if relpath not in z.namelist(): return result
    for rel in xml(z,relpath):
     key=rel.get('Id')
     if not key or key in result: raise ValueError('invalid relationship identity')
     result[key]=rel
    return result
   def resolve_part(source,rel):
    target=rel.get('Target','')
    if rel.get('TargetMode')=='External': raise ValueError('external relationship forbidden')
    if not target or any(c in target for c in ('\\',':','?','#','%')): raise ValueError('invalid relationship target')
    name=posixpath.normpath(target.lstrip('/') if target.startswith('/') else posixpath.join(posixpath.dirname(source),target))
    if not name.startswith('ppt/') or name not in z.namelist(): raise ValueError('missing or unsafe relationship part')
    return name
   def direct(e,key): return next((c for c in e if local(c)==key),None) if e is not None else None
   def rich_text(e): return '\n'.join(''.join(t.text or '' for t in p.iter() if local(t)=='t') for p in e.iter() if local(p)=='p') if e is not None else ''
   def points(e):
    if e is None: return {}
    multi=next((c for c in e.iter() if local(c)=='multiLvlStrCache'),None)
    if multi is not None:
     levels=[c for c in multi if local(c)=='lvl']
     if len(levels)!=1: warnings.append('多级图表分类尚未展开，请核对原图。');return {}
     cache=levels[0]
    else: cache=next((c for c in e.iter() if local(c) in ('strCache','numCache','strLit','numLit')),None)
    if cache is None: return {}
    result={}
    for point in cache:
     if local(point)!='pt': continue
     index=point.get('idx','')
     if not index.isdigit() or int(index)>20000 or int(index) in result: raise ValueError('invalid chart point index')
     value=direct(point,'v');result[int(index)]=value.text or '' if value is not None else ''
    return result
   def chart_objects(source,rel,parent,number):
    chart_id=parent+'/chart:'+str(number)
    if rel is None or rel.get('TargetMode')=='External':
     warnings.append(chart_id+'图表关系缺失或指向外部，未读取。');return
    chart_name=resolve_part(source,rel); chart=xml(z,chart_name)
    title=rich_text(next((e for e in chart.iter() if local(e)=='title'),None))
    add(chart_id,'图表 '+title,{'kind':'chart','parent':parent,'slideNumber':i+1,'sourcePart':chart_name,'dataSource':'stored-chart-cache'})
    warnings.append(chart_id+'数值来自文件内图表缓存，未重算或核对嵌入工作簿，可能缺失或过期；不代表完整视觉理解。')
    if any(local(e)=='externalData' for e in chart.iter()): warnings.append(chart_id+'关联工作簿或外部数据未打开、未联网刷新。')
    found=False
    for series_number,series in enumerate((e for e in chart.iter() if local(e)=='ser'),1):
     tx=direct(series,'tx'); names=points(tx); literal=direct(tx,'v')
     series_name=names.get(0,(literal.text or '') if literal is not None else '系列'+str(series_number))
     channels={key:points(direct(series,key)) for key in ('cat','val','xVal','yVal','bubbleSize')}
     indices=sorted(set().union(*(set(values) for values in channels.values())))
     if not indices: warnings.append(chart_id+'系列'+str(series_number)+'没有可用缓存，未推断数值。')
     for index in indices:
      found=True
      fields={'分类':channels['cat'].get(index,'缺失'),'数值':channels['val'].get(index,'缺失')} if direct(series,'val') is not None else {'X':channels['xVal'].get(index,'缺失'),'Y':channels['yVal'].get(index,'缺失')}
      if direct(series,'bubbleSize') is not None: fields['气泡大小']=channels['bubbleSize'].get(index,'缺失')
      text='幻灯片 '+str(i+1)+'；图表 '+(title or str(number))+'；系列 '+series_name+'；数据点 '+str(index+1)+'；'+'；'.join(k+'：'+v for k,v in fields.items())+'（文件缓存，未重算）'
      add(chart_id+'/series:'+str(series_number)+'/point:'+str(index+1),text,{'kind':'chart-point','parent':chart_id,'slideNumber':i+1,'seriesName':series_name,'row':index+1,'sourcePart':chart_name,'dataSource':'stored-chart-cache'})
    if not found: warnings.append(chart_id+'无可读取系列缓存或图表类型不受支持。')
   root=xml(z,'ppt/presentation.xml'); rels=relationships('ppt/presentation.xml')
   for i,s in enumerate(e for e in root.iter() if local(e)=='sldId'):
    rid=next(v for k,v in s.attrib.items() if k.endswith('}id')); name=resolve_part('ppt/presentation.xml',rels[rid])
    slide_id='slide:'+str(i+1); tree=xml(z,name); slide_rels=relationships(name)
    add(slide_id,'',{'kind':'slide','slideNumber':i+1})
    shapes=next(e for e in tree.iter() if local(e)=='spTree')
    def shape_objects(container,parent):
     for shape in container:
      if local(shape) not in ('sp','pic','graphicFrame','grpSp'): continue
      prop=next((e for e in shape.iter() if local(e)=='cNvPr'),None)
      if prop is None: continue
      shape_id=slide_id+'/shape:'+prop.get('id');meta={'kind':'shape','parent':parent,'slideNumber':i+1,'shapeId':prop.get('id'),'shapeType':local(shape)}
      transform=next((e for e in shape.iter() if local(e)=='xfrm'),None)
      if transform is not None:
       for coordinate in transform:
        if local(coordinate)=='off': meta.update({'x':coordinate.get('x','0'),'y':coordinate.get('y','0')})
        if local(coordinate)=='ext': meta.update({'width':coordinate.get('cx','0'),'height':coordinate.get('cy','0')})
      paragraphs=[''.join(e.text or '' for e in p.iter() if local(e)=='t') for p in shape.iter() if local(p)=='p'] if local(shape)!='grpSp' else []
      add(shape_id,'\n'.join(paragraphs),meta)
      for chart_number,chart_ref in enumerate((e for e in shape.iter() if local(e)=='chart'),1):
       if local(shape)=='grpSp': break
       chart_rid=next((v for k,v in chart_ref.attrib.items() if k.endswith('}id')),None)
       chart_objects(name,slide_rels.get(chart_rid),shape_id,chart_number)
      if local(shape)=='grpSp': shape_objects(shape,shape_id)
    shape_objects(shapes,slide_id)
    for rel in slide_rels.values():
     if not rel.get('Type','').endswith('/notesSlide'): continue
     if rel.get('TargetMode')=='External': warnings.append(slide_id+'备注关系指向外部，未读取。');continue
     notes_name=resolve_part(name,rel);notes=xml(z,notes_name)
     for ni,shape in enumerate((e for e in notes.iter() if local(e)=='sp'),1):
      placeholder=next((e for e in shape.iter() if local(e)=='ph'),None)
      if placeholder is not None and placeholder.get('type') in ('sldImg','sldNum','dt','hdr','ftr'): continue
      text=rich_text(shape)
      if text.strip(): add(slide_id+'/notes:'+str(ni),'幻灯片 '+str(i+1)+' 备注：\n'+text,{'kind':'notes','parent':slide_id,'slideNumber':i+1,'sourcePart':notes_name})
  elif ext=='.xlsx':
   shared=[''.join(t.text or '' for t in e.iter() if local(t)=='t') for e in xml(z,'xl/sharedStrings.xml')] if 'xl/sharedStrings.xml' in z.namelist() else []
   styles=xml(z,'xl/styles.xml') if 'xl/styles.xml' in z.namelist() else None
   custom={e.get('numFmtId'):e.get('formatCode','') for e in styles.iter() if local(e)=='numFmt'} if styles is not None else {}
   xfs=next((list(e) for e in styles if local(e)=='cellXfs'),[]) if styles is not None else []
   rels={e.attrib['Id']:e.attrib['Target'] for e in xml(z,'xl/_rels/workbook.xml.rels')}
   workbook=xml(z,'xl/workbook.xml')
   date1904=any(local(e)=='workbookPr' and e.get('date1904','false') in ('1','true') for e in workbook.iter())
   def date_value(value,numfmt,code):
    # 只解释明确支持的格式；不将普通数字或复杂条件格式猜成日期。
    clean=re.sub(r'"[^"]*"|\\.', '', code.lower())
    mode='date' if numfmt in ('14','15','16','17') else 'time' if numfmt in ('18','19','20','21','45','47') else 'datetime' if numfmt=='22' else 'duration' if numfmt=='46' else None
    if mode is None and code:
     if re.fullmatch(r'[ymdhs :/.,Tt-]+',clean) and re.search('[yd]',clean): mode='datetime' if re.search('[hs]',clean) else 'date'
     elif re.search(r'[ymdhs]|\[h',clean): return None,'格式未支持日期转换'
    if mode is None and numfmt.isdigit() and (27<=int(numfmt)<=36 or 50<=int(numfmt)<=58): return None,'本地化内置日期格式未支持转换'
    if mode is None: return None,None
    try:
     serial=float(value)
     if not math.isfinite(serial) or serial<0: raise ValueError()
     if mode=='duration': return str(round(serial*86400,6))+' seconds',None
     if mode=='time': return (datetime.datetime(2000,1,1)+datetime.timedelta(days=serial%1)).time().isoformat(),None
     if not date1904 and 60<=serial<61: return None,'1900日期系统序列60为不存在的1900-02-29'
     base=datetime.datetime(1904,1,1) if date1904 else datetime.datetime(1899,12,31)
     result=base+datetime.timedelta(days=serial if date1904 or serial<60 else serial-1)
     return result.isoformat() if mode=='datetime' or serial%1 else result.date().isoformat(),None
    except (ValueError,OverflowError): return None,'日期序列无效或超出支持范围'
   for sheet in (e for e in workbook.iter() if local(e)=='sheet'):
    rid=next(v for k,v in sheet.attrib.items() if k.endswith('}id')); target=rels[rid]
    name=target.lstrip('/') if target.startswith('/') else 'xl/'+target
    if '..' in name.split('/'): raise ValueError('invalid relationship')
    sheet_id='sheet:'+sheet.attrib['name']; tree=xml(z,name)
    add(sheet_id,'',{'kind':'sheet','sheet':sheet.attrib['name'],'state':sheet.get('state','visible'),'dateSystem':'1904' if date1904 else '1900'})
    tables=[]
    relpath=posixpath.dirname(name)+'/_rels/'+posixpath.basename(name)+'.rels'
    sheetrels={e.get('Id'):e for e in xml(z,relpath)} if relpath in z.namelist() else {}
    for tp in (e for e in tree.iter() if local(e)=='tablePart'):
     trid=next(v for k,v in tp.attrib.items() if k.endswith('}id'));relation=sheetrels[trid]
     if relation.get('TargetMode')=='External': raise ValueError('external table forbidden')
     target=relation.get('Target','');tablepath=posixpath.normpath(target.lstrip('/') if target.startswith('/') else posixpath.dirname(name)+'/'+target)
     if not tablepath.startswith('xl/tables/'): raise ValueError('invalid table relationship')
     table=xml(z,tablepath);tables.append((table.get('name',''),table.get('ref',''),table.get('headerRowCount','1')))
    def coordinate(address):
     m=re.fullmatch(r'([A-Z]+)([1-9][0-9]*)',address)
     if not m: raise ValueError('invalid cell coordinate')
     col=0
     for ch in m[1]: col=col*26+ord(ch)-64
     return col,int(m[2])
    for merge in (e for e in tree.iter() if local(e)=='mergeCell'):
     add(sheet_id+'!merge:'+merge.attrib['ref'],'',{'kind':'merge','parent':sheet_id,'sheet':sheet.attrib['name'],'range':merge.attrib['ref']})
    for cell in (e for e in tree.iter() if local(e)=='c'):
     value=next((e.text or '' for e in cell if local(e)=='v'),'')
     if cell.get('t')=='s':
      index=int(value)
      if index<0 or index>=len(shared): raise ValueError('invalid shared string index')
      value=shared[index]
     if cell.get('t')=='inlineStr': value=''.join(e.text or '' for e in cell.iter() if local(e)=='t')
     formula=next((e for e in cell if local(e)=='f'),None)
     meta={'kind':'cell','parent':sheet_id,'sheet':sheet.attrib['name'],'address':cell.attrib['r'],'valueType':cell.get('t','n')}
     cx,cy=coordinate(cell.attrib['r'])
     for tname,tref,headers in tables:
      ends=tref.split(':');(ax,ay),(bx,by)=coordinate(ends[0]),coordinate(ends[-1])
      if ax<=cx<=bx and ay<=cy<=by:
       meta.update({'tableName':tname,'tableRange':tref,'headerRow':'true' if headers=='1' and cy==ay else 'false'})
     meta['rawValue']=value;meta['dateSystem']='1904' if date1904 else '1900'
     numfmt='0';style=cell.get('s','0');meta['styleId']=style
     if xfs:
      numfmt=xfs[int(style)].get('numFmtId','0');meta['numberFormatId']=numfmt
      if numfmt in custom: meta['numberFormatCode']=custom[numfmt]
     converted,issue=date_value(value,numfmt,custom.get(numfmt,'')) if cell.get('t','n')=='n' and value else (None,None)
     if converted is not None: meta['normalizedValue']=converted
     if issue:
      meta['conversionWarning']=issue
      message='存在无法可靠转换的日期/时间格式或数值，请按原始值、格式与日期基准核对。'
      if message not in warnings: warnings.append(message)
     if formula is not None:
      meta.update({'formula':formula.text or '', 'formulaType':formula.get('t','normal'),'cached':value})
      if 'si' in formula.attrib: meta['sharedIndex']=formula.attrib['si']
      if 'ref' in formula.attrib: meta['formulaRange']=formula.attrib['ref']
      value='formula='+(formula.text or '')+'; cached='+value
     if converted is not None: value+='; normalized='+converted+'; dateSystem='+meta['dateSystem']
     if issue: value+='; dateSystem='+meta['dateSystem']+'; warning='+issue
     add(sheet_id+'!'+cell.attrib['r'],value,meta)
  else: raise ValueError('unsupported format')
if not parts: raise ValueError('no extractable text after bounded OCR')
# 多图表文档仍可返回有界警告；明确提示省略数量，不将省略伪装为完整解析。
if len(warnings)>100: warnings=warnings[:99]+['另有'+str(len(warnings)-99)+'条解析警告未逐项展示，请按原件核对；不代表完整识别。']
path.unlink()
pathlib.Path('/workspace/parsed.json').write_text(json.dumps({'parts':parts,'coverage':'partial' if warnings else 'text-only','warnings':warnings},ensure_ascii=False))
`;

// 指纹只包含固定程序和解析契约，不含地址或凭据；升级程序会使旧结果失效。
export const parserFingerprint = createHash('sha256').update('structured-extraction-v4-table-rows\n' + parserProgram).digest('hex');
export interface ParsedDocument { parts: ParsedPart[]; coverage: 'unknown' | 'text-only' | 'partial'; warnings: string[] }
export function validateParsedDocument(value: unknown): ParsedDocument {
  if (Array.isArray(value)) return { parts: validateParsedParts(value), coverage: 'unknown', warnings: ['旧解析结果缺少覆盖范围信息，请重建后核对。'] };
  const v = value as Partial<ParsedDocument> | null;
  if (!v || !['text-only','partial'].includes(v.coverage ?? '') || !Array.isArray(v.warnings) || v.warnings.length > 100 || v.warnings.some(w => typeof w !== 'string' || w.length > 2000) || (v.coverage === 'partial' && !v.warnings.length)) throw Error('解析状态无效');
  return { parts: validateParsedParts(v.parts), coverage: v.coverage!, warnings: v.warnings };
}
export async function parseDocument(config: WorkerConfiguration, extension: string, data: Buffer): Promise<ParsedPart[]> {
  return (await parseDocumentResult(config, extension, data)).parts;
}
export async function parseDocumentResult(config: WorkerConfiguration, extension: string, data: Buffer): Promise<ParsedDocument> {
  if (!['.docx','.xlsx','.pptx','.pdf','.png','.jpg','.jpeg','.csv'].includes(extension)) throw Error('不支持此格式');
  const response = await fetch(config.url.replace(/\/$/,'')+'/v1/run', { method:'POST', headers:{authorization:`Bearer ${config.token}`,'content-type':'application/json'}, body:JSON.stringify({command:`python3 /skills/parser/read.py ${extension}`,files:[['source'+extension,data.toString('base64')]],skills:[['parser/read.py',Buffer.from(parserProgram).toString('base64')]]}),signal:AbortSignal.timeout(140000) });
  if (!response.ok) { await response.body?.cancel(); throw Error('隔离解析失败或服务繁忙；请重试。扫描PDF需要OCR，旧版Office请转换格式。'); }
  const reader=response.body!.getReader(), chunks:Uint8Array[]=[];let bytes=0;
  try { for (;;) { const next=await reader.read();if(next.done)break; bytes+=next.value.length;if(bytes>8*1024*1024)throw Error('解析结果超过限制');chunks.push(next.value); } } finally { await reader.cancel().catch(()=>undefined);reader.releaseLock(); }
  const result=JSON.parse(Buffer.concat(chunks).toString()) as {files?:unknown};
  if(!Array.isArray(result.files))throw Error('解析结果无效');
  const matches=result.files.filter((e:unknown)=>Array.isArray(e)&&e[0]==='parsed.json');
  if(matches.length!==1||typeof matches[0][1]!=='string')throw Error('缺少解析结果');
  const parts:unknown=JSON.parse(Buffer.from(matches[0][1],'base64').toString());
  return validateParsedDocument(parts);
}
