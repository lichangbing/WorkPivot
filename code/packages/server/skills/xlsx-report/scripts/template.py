import copy
import argparse,json,pathlib,re,zipfile,io
from xml.dom import minidom

# 只填充普通文本字段，不解释模板内容为代码、公式或外部命令。
FIELD=re.compile(r'\{\{([\w.-]{1,100})\}\}')
def nodes(element,name):
 return [n for n in element.getElementsByTagName('*') if n.localName==name]
def text(node):
 return ''.join(n.data for n in node.childNodes if n.nodeType in (n.TEXT_NODE,n.CDATA_SECTION_NODE))
def set_text(node,value):
 for child in list(node.childNodes): node.removeChild(child)
 node.appendChild(node.ownerDocument.createTextNode(value))
 node.setAttribute('xml:space','preserve')
def parse(data):
 upper=data.replace(b'\x00',b'').upper()
 if b'<!DOCTYPE' in upper or b'<!ENTITY' in upper: raise ValueError('模板包含不允许的XML声明')
 return minidom.parseString(data)
def fill_group(group,fields,used):
 original=[text(n) for n in group]; joined=''.join(original); matches=list(FIELD.finditer(joined))
 if '{{' in FIELD.sub('',joined) or '}}' in FIELD.sub('',joined): raise ValueError('占位符格式不支持或跨段落')
 if len(matches)>20000 or len(joined)+sum(len(fields.get(m.group(1),''))-(m.end()-m.start()) for m in matches)>1000000: raise ValueError('填充后正文超过限制')
 starts=[];position=0
 for value in original: starts.append(position);position+=len(value)
 values=original[:]
 # 从后往前修改，保留原文本片段位置；替换文字继承字段起点的格式。
 for match in reversed(matches):
  key=match.group(1)
  if key not in fields: raise ValueError('缺少模板字段：'+key)
  used.add(key)
  first=next(i for i,value in enumerate(original) if starts[i]+len(value)>match.start())
  last=next(i for i,value in enumerate(original) if starts[i]+len(value)>=match.end())
  a=match.start()-starts[first];b=match.end()-starts[last]
  if first==last: values[first]=values[first][:a]+fields[key]+values[first][b:]
  else:
   values[first]=values[first][:a]+fields[key]
   for i in range(first+1,last): values[i]=''
   values[last]=values[last][b:]
 for node,before,after in zip(group,original,values):
  if before!=after: set_text(node,after)
 return len(matches)
def render(source,output,fields):
 if source.resolve()==output.resolve(): raise ValueError('必须输出到新文件，不能覆盖模板')
 if output.exists(): raise ValueError('输出文件已存在')
 if source.suffix.lower() not in ('.docx','.xlsx') or output.suffix.lower()!=source.suffix.lower(): raise ValueError('仅支持同格式DOCX或XLSX输出')
 if not isinstance(fields,dict) or not fields or len(fields)>100: raise ValueError('需要1至100个模板字段')
 for key,value in fields.items():
  if not isinstance(key,str) or not FIELD.fullmatch('{{'+key+'}}') or not isinstance(value,str) or len(value)>10000 or any(ord(c)<32 for c in value) or '{{' in value or '}}' in value: raise ValueError('字段必须为有界的单行文本，不允许嵌套占位符')
 used=set();changes={};count=0
 with zipfile.ZipFile(source) as archive:
  info=archive.infolist()
  if len(info)>4000 or len({i.filename for i in info})!=len(info) or sum(i.file_size for i in info)>32000000 or any(i.file_size>8000000 for i in info): raise ValueError('模板压缩包超限或成员重复')
  required='word/document.xml' if source.suffix.lower()=='.docx' else 'xl/workbook.xml'
  if required not in archive.namelist() or '[Content_Types].xml' not in archive.namelist(): raise ValueError('模板缺少必要成员')
  for item in info:
   if not item.filename.endswith(('.xml','.rels')): continue
   data=archive.read(item); dom=parse(data);groups=[]
   if source.suffix.lower()=='.docx' and item.filename=='word/document.xml':
    paragraphs=nodes(dom,'p')
    if any(nodes(p,'p') for p in paragraphs): raise ValueError('不支持包含嵌套文本框的段落模板')
    groups=[nodes(p,'t') for p in paragraphs]
   elif source.suffix.lower()=='.xlsx' and item.filename=='xl/sharedStrings.xml':
    groups=[nodes(si,'t') for si in nodes(dom,'si')]
   elif source.suffix.lower()=='.xlsx' and item.filename.startswith('xl/worksheets/'):
    groups=[nodes(e,'t') for e in nodes(dom,'is')]
   before=count
   for group in groups: count+=fill_group(group,fields,used)
   # 非支持区域的字段不能静默漏填，包括页眉页脚、公式和图形文字。
   remaining=''.join(text(e)+''.join(e.attributes.item(i).value for i in range(e.attributes.length)) for e in dom.getElementsByTagName('*'))
   if '{{' in remaining or '}}' in remaining: raise ValueError('字段位于不支持的区域或跨段落：'+item.filename)
   if count>before: changes[item.filename]=dom.toxml(encoding='UTF-8')
  if set(fields)!=used: raise ValueError('存在未使用的字段：'+','.join(sorted(set(fields)-used)))
  if not count: raise ValueError('模板没有可填充字段')
  buffer=io.BytesIO()
  with zipfile.ZipFile(buffer,'w') as target:
   for item in info: target.writestr(copy.copy(item),changes.get(item.filename,archive.read(item.filename)))
 # 重新打开核对ZIP及XML，再一次性创建输出；失败不留半成品。
 payload=buffer.getvalue()
 if len(payload)>32000000: raise ValueError('填充结果超过大小限制')
 with zipfile.ZipFile(io.BytesIO(payload)) as result:
  if sum(i.file_size for i in result.infolist())>32000000 or any(i.file_size>8000000 for i in result.infolist()): raise ValueError('填充后解压内容超过限制')
  if result.testzip(): raise ValueError('输出压缩包损坏')
  for name in changes: parse(result.read(name))
 with output.open('xb') as target: target.write(payload)
 return {'fields':sorted(used),'replacements':count,'structure':'passed','visual':'not-performed','recalculation':'not-performed'}
if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--template',required=True);parser.add_argument('--fields',required=True);parser.add_argument('--output',required=True);args=parser.parse_args()
 try:
  if pathlib.Path(args.fields).stat().st_size>1000000: raise ValueError('字段参数文件超过1MB')
  print(json.dumps(render(pathlib.Path(args.template),pathlib.Path(args.output),json.loads(pathlib.Path(args.fields).read_text())),ensure_ascii=False))
 except Exception as error:
  parser.exit(1,'模板生成失败：'+str(error)+'\n')
