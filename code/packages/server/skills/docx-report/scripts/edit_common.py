import copy
import hashlib,io,json,pathlib,re,sys,zipfile
from xml.dom import minidom
sys.dont_write_bytecode=True

def elements(node,name=None):
 return [e for e in (node.childNodes if node is not None else []) if e.nodeType==e.ELEMENT_NODE and (name is None or e.localName==name)]
def descendants(node,name): return [e for e in node.getElementsByTagName('*') if e.localName==name]
def content(node): return ''.join(c.data for c in node.childNodes if c.nodeType in (c.TEXT_NODE,c.CDATA_SECTION_NODE))
def xml(data):
 safe=data.replace(b'\x00',b'').upper()
 if b'<!DOCTYPE' in safe or b'<!ENTITY' in safe: raise ValueError('不允许XML实体声明')
 return minidom.parseString(data)
def child(node,name): return next(iter(elements(node,name)),None)
def string(value):
 if not isinstance(value,str) or len(value)>32767 or any(ord(c)<32 for c in value): raise ValueError('需要有界单行文字')
 return value
def set_text(node,value):
 for c in list(node.childNodes): node.removeChild(c)
 node.appendChild(node.ownerDocument.createTextNode(value));node.setAttribute('xml:space','preserve')
def create(parent,name,value=None):
 node=parent.ownerDocument.createElementNS(parent.namespaceURI,(parent.prefix+':' if parent.prefix else '')+name)
 if value is not None: node.appendChild(parent.ownerDocument.createTextNode(value))
 return node
def load(source,output,spec):
 if source.resolve()==output.resolve() or output.exists(): raise ValueError('必须使用不存在的新输出文件')
 data=source.read_bytes()
 if len(data)>32000000 or spec.get('sourceSha256')!=hashlib.sha256(data).hexdigest(): raise ValueError('源文件哈希不匹配或超限')
 changes=spec.get('changes')
 if not isinstance(changes,list) or not 1<=len(changes)<=100: raise ValueError('需要1至100项修改')
 if set(spec)!={'sourceSha256','changes'}: raise ValueError('修改参数包含未知字段')
 archive=zipfile.ZipFile(io.BytesIO(data));info=archive.infolist()
 if len(info)>4000 or len({i.filename for i in info})!=len(info) or sum(i.file_size for i in info)>32000000 or any(i.file_size>8000000 for i in info): raise ValueError('源文件压缩包超限或重复')
 if archive.testzip(): raise ValueError('源文件压缩包损坏')
 if any(i.filename.startswith('_xmlsignatures/') or i.filename.endswith('vbaProject.bin') for i in info): raise ValueError('不修改带数字签名或宏的文档')
 for i in info:
  if i.filename.endswith(('.xml','.rels')): xml(archive.read(i.filename))
 return archive

def save(archive,output,changed,removed=()):
 buffer=io.BytesIO()
 with zipfile.ZipFile(buffer,'w') as target:
  for item in archive.infolist():
   if item.filename not in removed: target.writestr(copy.copy(item),changed.get(item.filename,archive.read(item.filename)))
 data=buffer.getvalue()
 with zipfile.ZipFile(io.BytesIO(data)) as reopened:
  if reopened.testzip() or sum(i.file_size for i in reopened.infolist())>32000000 or any(i.file_size>8000000 for i in reopened.infolist()): raise ValueError('修改结果结构损坏或超限')
  for item in archive.infolist():
   if item.filename in removed: continue
   expected=changed.get(item.filename,archive.read(item.filename))
   if reopened.read(item.filename)!=expected: raise ValueError('未修改范围校验失败')
   if item.filename.endswith(('.xml','.rels')): xml(reopened.read(item.filename))
 with output.open('xb') as target: target.write(data)
 return {'sourceSha256':hashlib.sha256(archive.fp.getvalue()).hexdigest(),'outputSha256':hashlib.sha256(data).hexdigest(),'changedParts':sorted(changed),'removedParts':list(removed),'content':'passed','preservedParts':'passed','visual':'not-performed','recalculation':'not-performed'}

def arguments():
 import argparse
 parser=argparse.ArgumentParser();parser.add_argument('--source',required=True);parser.add_argument('--changes',required=True);parser.add_argument('--output',required=True);args=parser.parse_args()
 path=pathlib.Path(args.changes)
 if path.stat().st_size>1000000: raise ValueError('修改参数超过1MB')
 return pathlib.Path(args.source),pathlib.Path(args.output),json.loads(path.read_text())
