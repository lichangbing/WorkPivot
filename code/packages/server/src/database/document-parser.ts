import type { WorkerConfiguration } from './skill-execution.js';

// Fixed program, never a command supplied by the document. Runs only in the isolated worker.
export const parserProgram = String.raw`
import sys,json,zipfile,xml.etree.ElementTree as ET,subprocess,pathlib
path=pathlib.Path('/workspace/source'+sys.argv[1]); parts=[]; total=0
def add(location,text):
 global total
 if not text.strip(): return
 total+=len(text)
 if total>1000000 or len(parts)>=20000: raise ValueError('extracted content exceeds limit')
 parts.append({'location':location,'text':text})
def xml(z,name):
 data=z.read(name)
 if b'<!DOCTYPE' in data.upper() or b'<!ENTITY' in data.upper(): raise ValueError('XML entities forbidden')
 return ET.fromstring(data)
def local(e): return e.tag.split('}')[-1]
ext=sys.argv[1]
if ext=='.pdf':
 subprocess.run(['pdftotext','-layout',str(path),'/workspace/plain.txt'],check=True,timeout=60,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 if pathlib.Path('/workspace/plain.txt').stat().st_size>4000000: raise ValueError('PDF text exceeds limit')
 for i,page in enumerate(pathlib.Path('/workspace/plain.txt').read_text().split('\f')): add('page:'+str(i+1),page)
 pathlib.Path('/workspace/plain.txt').unlink()
else:
 with zipfile.ZipFile(path) as z:
  info=z.infolist()
  if len(info)>4000 or sum(x.file_size for x in info)>32000000 or any(x.file_size>8000000 for x in info): raise ValueError('archive exceeds limit')
  if ext=='.docx':
   root=xml(z,'word/document.xml')
   for i,p in enumerate(e for e in root.iter() if local(e)=='p'):
    add('paragraph:'+str(i+1),''.join(e.text or '' if local(e)=='t' else '\t' if local(e)=='tab' else '\n' for e in p.iter() if local(e) in ('t','tab','br')))
  elif ext=='.pptx':
   root=xml(z,'ppt/presentation.xml'); rels={e.attrib['Id']:e.attrib['Target'] for e in xml(z,'ppt/_rels/presentation.xml.rels')}
   for i,s in enumerate(e for e in root.iter() if local(e)=='sldId'):
    rid=next(v for k,v in s.attrib.items() if k.endswith('}id')); target=rels[rid]
    name=target.lstrip('/') if target.startswith('/') else 'ppt/'+target
    if '..' in name.split('/'): raise ValueError('invalid relationship')
    add('slide:'+str(i+1),'\n'.join(e.text or '' for e in xml(z,name).iter() if local(e)=='t'))
  elif ext=='.xlsx':
   shared=[''.join(t.text or '' for t in e.iter() if local(t)=='t') for e in xml(z,'xl/sharedStrings.xml')] if 'xl/sharedStrings.xml' in z.namelist() else []
   rels={e.attrib['Id']:e.attrib['Target'] for e in xml(z,'xl/_rels/workbook.xml.rels')}
   for sheet in (e for e in xml(z,'xl/workbook.xml').iter() if local(e)=='sheet'):
    rid=next(v for k,v in sheet.attrib.items() if k.endswith('}id')); target=rels[rid]
    name=target.lstrip('/') if target.startswith('/') else 'xl/'+target
    if '..' in name.split('/'): raise ValueError('invalid relationship')
    for cell in (e for e in xml(z,name).iter() if local(e)=='c'):
     value=next((e.text or '' for e in cell if local(e)=='v'),'')
     if cell.get('t')=='s': value=shared[int(value)] if value else ''
     if cell.get('t')=='inlineStr': value=''.join(e.text or '' for e in cell.iter() if local(e)=='t')
     formula=next((e.text for e in cell if local(e)=='f'),None)
     if formula: value='formula='+formula+'; cached='+value
     add('sheet:'+sheet.attrib['name']+'!'+cell.attrib['r'],value)
  else: raise ValueError('unsupported format')
if not parts: raise ValueError('no extractable text; OCR is not enabled')
path.unlink()
pathlib.Path('/workspace/parsed.json').write_text(json.dumps(parts,ensure_ascii=False))
`;

export interface ParsedPart { location: string; text: string }
export async function parseDocument(config: WorkerConfiguration, extension: string, data: Buffer): Promise<ParsedPart[]> {
  if (!['.docx','.xlsx','.pptx','.pdf'].includes(extension)) throw Error('不支持此格式');
  const response = await fetch(config.url.replace(/\/$/,'')+'/v1/run', { method:'POST', headers:{authorization:`Bearer ${config.token}`,'content-type':'application/json'}, body:JSON.stringify({command:`python3 /skills/parser/read.py ${extension}`,files:[['source'+extension,data.toString('base64')]],skills:[['parser/read.py',Buffer.from(parserProgram).toString('base64')]]}),signal:AbortSignal.timeout(140000) });
  if (!response.ok) { await response.body?.cancel(); throw Error('隔离解析失败或服务繁忙；请重试。扫描PDF需要OCR，旧版Office请转换格式。'); }
  const reader=response.body!.getReader(), chunks:Uint8Array[]=[];let bytes=0;
  try { for (;;) { const next=await reader.read();if(next.done)break; bytes+=next.value.length;if(bytes>8*1024*1024)throw Error('解析结果超过限制');chunks.push(next.value); } } finally { await reader.cancel().catch(()=>undefined);reader.releaseLock(); }
  const result=JSON.parse(Buffer.concat(chunks).toString()) as {files?:unknown};
  if(!Array.isArray(result.files))throw Error('解析结果无效');
  const matches=result.files.filter((e:unknown)=>Array.isArray(e)&&e[0]==='parsed.json');
  if(matches.length!==1||typeof matches[0][1]!=='string')throw Error('缺少解析结果');
  const parts:unknown=JSON.parse(Buffer.from(matches[0][1],'base64').toString());
  if(!Array.isArray(parts)||!parts.length||parts.length>20000)throw Error('解析内容为空或超限');
  let size=0;
  for(const part of parts) { if(!part||typeof part.location!=='string'||part.location.length>500||typeof part.text!=='string')throw Error('解析内容无效');size+=part.text.length; }
  if(size>1000000)throw Error('解析内容超过100万字符');
  return parts as ParsedPart[];
}
