import sys,json
sys.dont_write_bytecode=True
from edit_common import elements,descendants,content,child,create,set_text,string,xml,load,save,arguments

def objects(root):
 result={};counts={'paragraph':0,'table':0,'table-cell':0}
 def add(kind,node):
  counts[kind]+=1;result[kind+':'+str(counts[kind])]=node
 def walk(container):
  for node in elements(container):
   kind=node.localName
   if kind=='p': add('paragraph',node)
   elif kind=='tbl':
    add('table',node)
    for row in elements(node,'tr'):
     for cell in elements(row,'tc'): add('table-cell',cell);walk(cell)
   elif kind not in ('tcPr','tblPr','tblGrid','sectPr'): walk(node)
 walk(root);return result

def edit(source,output,spec):
 if source.suffix.lower()!='.docx' or output.suffix.lower()!='.docx': raise ValueError('仅支持DOCX')
 archive=load(source,output,spec);dom=xml(archive.read('word/document.xml'));lookup=objects(dom)
 if any(descendants(dom,k) for k in ('ins','del','moveFrom','moveTo','sdt')): raise ValueError('文档含修订或内容控件，超出限定修改范围')
 seen=set();expected=[]
 for change in spec['changes']:
  if not isinstance(change,dict) or set(change)-{'target','expected','find','replacement'} or not {'target','expected','replacement'}<=set(change): raise ValueError('文字修改参数无效')
  target=lookup.get(change['target'])
  if target is None or target.localName not in ('p','tc'): raise ValueError('目标段落或表格单元格不存在')
  if target.localName=='tc':
   if child(child(target,'tcPr'),'vMerge') is not None: raise ValueError('纵向合并单元格不支持整格替换')
   paragraphs=elements(target,'p')
   if len(paragraphs)!=1 or any(e.localName not in ('tcPr','p') for e in elements(target)): raise ValueError('整格替换只支持单段落单元格')
   target=paragraphs[0]
  if id(target) in seen: raise ValueError('修改目标重复或重叠')
  seen.add(id(target))
  if any(e.localName not in ('pPr','r') for e in elements(target)) or any(e.localName not in ('rPr','t') for r in elements(target,'r') for e in elements(r)): raise ValueError('目标含域、链接、换行或复杂对象，拒绝修改')
  texts=descendants(target,'t');original=''.join(content(t) for t in texts)
  if original!=string(change['expected']): raise ValueError('目标原文不匹配')
  replacement=string(change['replacement']);find=change.get('find')
  if find is not None:
   string(find)
   if not find or original.count(find)!=1: raise ValueError('查找文字必须在目标内唯一')
   start=original.index(find);end=start+len(find)
  else: start=0;end=len(original)
  wanted=original[:start]+replacement+original[end:]
  if not texts:
   run=create(target,'r');node=create(run,'t');run.appendChild(node);target.appendChild(run);texts=[node]
  positions=[];position=0
  for t in texts: positions.append(position);position+=len(content(t))
  if end==0: set_text(texts[0],replacement)
  else:
   first=next(i for i,t in enumerate(texts) if positions[i]+len(content(t))>start)
   last=next(i for i,t in enumerate(texts) if positions[i]+len(content(t))>=end)
   a=start-positions[first];b=end-positions[last]
   if first==last: set_text(texts[first],content(texts[first])[:a]+replacement+content(texts[first])[b:])
   else:
    set_text(texts[first],content(texts[first])[:a]+replacement)
    for i in range(first+1,last): set_text(texts[i],'')
    set_text(texts[last],content(texts[last])[b:])
  expected.append((change['target'],wanted))
 data=dom.toxml(encoding='UTF-8');reopened=objects(xml(data))
 for target,wanted in expected:
  if ''.join(content(t) for t in descendants(reopened[target],'t'))!=wanted: raise ValueError('修改后目标内容核对失败')
 result=save(archive,output,{'word/document.xml':data});result['targets']=[key for key,_ in expected];return result
if __name__=='__main__':
 try: print(json.dumps(edit(*arguments()),ensure_ascii=False))
 except Exception as error: sys.exit('Word修改失败：'+str(error))
