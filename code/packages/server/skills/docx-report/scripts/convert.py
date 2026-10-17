import copy
import argparse,json,pathlib,subprocess,tempfile,zipfile,re,sys,shutil
import xml.etree.ElementTree as ET

def inspect(path,recalculate=False):
 with zipfile.ZipFile(path) as z:
  items=z.infolist()
  if len(items)>4000 or len({i.filename for i in items})!=len(items) or sum(i.file_size for i in items)>32000000 or any(i.file_size>8000000 for i in items): raise ValueError('输入压缩包超限或重复')
  formulas={};font_names=set()
  for item in items:
   name=item.filename
   if item.is_dir(): continue
   if '/embeddings/' in name or 'vbaProject' in name or name.startswith('_xmlsignatures/') or '/externalLinks/' in name: raise ValueError('拒绝宏、签名或外部工作簿')
   if not name.endswith(('.xml','.rels')): continue
   raw=z.read(name);scan=raw.replace(b'\x00',b'').upper()
   if b'<!DOCTYPE' in scan or b'<!ENTITY' in scan: raise ValueError('拒绝XML实体')
   root=ET.fromstring(raw)
   for e in root.iter():
    local=e.tag.split('}')[-1]
    if any('vbaproject' in v.lower() or 'macroenabled' in v.lower() for v in e.attrib.values()): raise ValueError('拒绝宏类型或宏关系')
    if local=='Relationship' and e.get('TargetMode')=='External': raise ValueError('拒绝含外部关系的转换输入')
    if local in ('ddeLink','oleObject','oleObj','definedName','externalReference','instrText','fldSimple','fldChar'): raise ValueError('输入包含不支持的外部对象或定义名称')
    if name.startswith('ppt/slides/slide') and local in ('latin','ea','cs') and e.get('typeface') and not e.get('typeface').startswith('+'): font_names.add(e.get('typeface'))
    if name=='word/document.xml' and local=='rFonts': font_names.update(v for k,v in e.attrib.items() if k.split('}')[-1] in ('ascii','hAnsi','eastAsia'))
    if local=='c' and name.startswith('xl/worksheets/'):
     formula=next((c for c in e if c.tag.split('}')[-1]=='f'),None)
     if formula is None: continue
     if any(c.tag.split('}')[-1] not in ('f','v') for c in e): raise ValueError('公式单元格扩展结构不在转换范围')
     expression=formula.text or ''
     if formula.get('t','normal')!='normal': raise ValueError('共享、数组和数据表公式不在首批重算范围')
     # 首批只计算同表引用、四则运算及明确允许的常用函数。
     if recalculate:
      if len(expression)>8192 or re.search(r'[^A-Za-z0-9_$.:,+*/()=<>%\-\s]',expression): raise ValueError('公式包含不支持的引用或字符')
      tokens=re.findall(r'[A-Za-z_][A-Za-z_0-9.]*',expression.replace('$',''))
      allowed={'SUM','AVERAGE','MIN','MAX','COUNT','COUNTA','IF','ROUND','AND','OR','NOT','ABS','TRUE','FALSE'}
      if any(not re.fullmatch(r'[A-Za-z]{1,3}[1-9][0-9]*',t) and t.upper() not in allowed for t in tokens): raise ValueError('公式函数或名称不受支持')
     cached=next((c.text for c in e if c.tag.split('}')[-1]=='v'),None)
     formulas[(name,e.get('r'))]=(expression,cached,e.get('t','n'))
  return formulas,font_names

def run(source,output,mode):
 if source.resolve()==output.resolve() or output.exists(): raise ValueError('需要不存在的新输出文件')
 if source.suffix.lower() not in ('.docx','.xlsx','.pptx') or output.suffix.lower()!=('.xlsx' if mode=='recalculate' else '.pdf'): raise ValueError('输入或输出格式无效')
 if mode=='recalculate' and source.suffix.lower()!='.xlsx': raise ValueError('仅XLSX支持重算')
 before,fonts=inspect(source,True)
 if mode=='recalculate' and not before: raise ValueError('文件没有待重算公式')
 if not shutil.which('libreoffice'): raise ValueError('缺少LibreOffice转换依赖')
 available=subprocess.run(['fc-list',':','family'],capture_output=True,text=True,check=True,timeout=10).stdout.casefold()
 missing=sorted(f for f in fonts if f.casefold() not in available)
 if mode=='render' and missing: raise ValueError('缺少指定字体：'+','.join(missing[:20]))
 with tempfile.TemporaryDirectory(prefix='wp-office-') as directory:
  root=pathlib.Path(directory);profile=root/'profile';profile.mkdir();(root/'out').mkdir()
  (profile/'registrymodifications.xcu').write_text('''<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item></oor:items>''')
  extension='xlsx' if mode=='recalculate' else 'pdf'
  subprocess.run(['libreoffice','-env:UserInstallation='+profile.as_uri(),'--headless','--norestore','--convert-to',extension,'--outdir',str(root/'out'),str(source.resolve())],check=True,timeout=65,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
  result=root/'out'/(source.stem+'.'+extension)
  if not result.is_file() or result.stat().st_size>16000000: raise ValueError('转换没有生成有效产物或超过大小限制')
  if mode=='recalculate':
   after,_=inspect(result)
   # 保存源包，只移植经核对的公式缓存，避免引擎重写其他格式对象。
   if set(before)!=set(after) or any(before[k][0].replace(' ','').upper()!=after[k][0].replace(' ','').upper() for k in before): raise ValueError('重算改变公式或定位，拒绝发布')
   if any(v[1] is None or v[2]=='e' for v in after.values()): raise ValueError('重算存在错误或缺失缓存')
   from xml.dom import minidom
   import io
   buffer=io.BytesIO()
   with zipfile.ZipFile(source) as original,zipfile.ZipFile(buffer,'w') as target:
    for item in original.infolist():
     data=original.read(item.filename)
     if any(k[0]==item.filename for k in before):
      dom=minidom.parseString(data)
      for cell in [e for e in dom.getElementsByTagName('*') if e.localName=='c']:
       key=(item.filename,cell.getAttribute('r'))
       if key not in after: continue
       for v in [c for c in cell.childNodes if c.nodeType==c.ELEMENT_NODE and c.localName=='v']:cell.removeChild(v)
       node=dom.createElementNS(cell.namespaceURI,(cell.prefix+':' if cell.prefix else '')+'v');node.appendChild(dom.createTextNode(after[key][1]));cell.appendChild(node)
       if after[key][2]=='n':
        if cell.hasAttribute('t'):cell.removeAttribute('t')
       else:cell.setAttribute('t',after[key][2])
      data=dom.toxml(encoding='UTF-8')
     target.writestr(copy.copy(item),data)
   payload=buffer.getvalue()
  else:
   payload=result.read_bytes()
   if not payload.startswith(b'%PDF-'): raise ValueError('渲染输出不是PDF')
  with output.open('xb') as target:target.write(payload)
 return {'mode':mode,'structure':'passed','recalculation':'passed' if mode=='recalculate' else 'not-performed','formulas':len(before),'render':'passed' if mode=='render' else 'not-performed','visual':'not-performed','missingFonts':missing}
if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--source',required=True);parser.add_argument('--output',required=True);parser.add_argument('--mode',choices=['render','recalculate'],required=True);args=parser.parse_args()
 try:print(json.dumps(run(pathlib.Path(args.source),pathlib.Path(args.output),args.mode),ensure_ascii=False))
 except Exception as error:sys.exit('转换失败：'+str(error))
