import sys,json,re
sys.dont_write_bytecode=True
from edit_common import descendants,elements,content,child,set_text,string,xml,load,save,arguments

def edit(source,output,spec):
 if source.suffix.lower()!='.pptx' or output.suffix.lower()!='.pptx':raise ValueError('仅支持PPTX')
 archive=load(source,output,spec);presentation=xml(archive.read('ppt/presentation.xml'));rels=xml(archive.read('ppt/_rels/presentation.xml.rels'))
 targets={e.getAttribute('Id'):e.getAttribute('Target') for e in elements(rels.documentElement)};paths=[]
 for slide in descendants(presentation,'sldId'):
  rid=next(a.value for a in slide.attributes.values() if a.localName=='id' and a.namespaceURI);target=targets[rid];path=target.lstrip('/') if target.startswith('/') else 'ppt/'+target
  if '..' in path.split('/'):raise ValueError('幻灯片路径无效')
  paths.append(path)
 changed={};seen=set();checks=[]
 for change in spec['changes']:
  if not isinstance(change,dict) or set(change)!={'slide','shapeId','expected','replacement'}:raise ValueError('PPT修改参数无效')
  number=change['slide'];shape_id=change['shapeId']
  if not isinstance(number,int) or isinstance(number,bool) or not 1<=number<=len(paths) or not isinstance(shape_id,str):raise ValueError('页码或对象编号无效')
  if (number,shape_id) in seen:raise ValueError('修改对象重复')
  seen.add((number,shape_id));path=paths[number-1];dom=xml(changed.get(path,archive.read(path)));tree=next(iter(descendants(dom,'spTree')))
  shapes=[s for s in elements(tree,'sp') if any(e.getAttribute('id')==shape_id for e in descendants(s,'cNvPr'))]
  if len(shapes)!=1:raise ValueError('只支持未分组的普通文字形状，不支持图形、表格或组合对象')
  shape=shapes[0];paragraphs=descendants(shape,'p')
  if len(paragraphs)!=1 or any(e.localName not in ('pPr','r','endParaRPr') for e in elements(paragraphs[0])):raise ValueError('首版仅替换单段落普通文字形状')
  runs=elements(paragraphs[0],'r')
  if not runs or any(e.localName not in ('rPr','t') for r in runs for e in elements(r)):raise ValueError('文字对象包含不支持的字段')
  texts=descendants(shape,'t');before=''.join(content(t) for t in texts)
  if before!=string(change['expected']):raise ValueError('形状原文不匹配')
  replacement=string(change['replacement'])
  if len(replacement)>max(len(before),70):raise ValueError('替换文字过长，请缩短并进行渲染核对')
  set_text(texts[0],replacement)
  for t in texts[1:]:set_text(t,'')
  data=dom.toxml(encoding='UTF-8');check=xml(data);matched=[s for s in descendants(check,'sp') if any(e.getAttribute('id')==shape_id for e in descendants(s,'cNvPr'))]
  if len(matched)!=1 or ''.join(content(t) for t in descendants(matched[0],'t'))!=replacement:raise ValueError('修改文字读回不一致')
  changed[path]=data;checks.append({'slide':number,'shapeId':shape_id})
 result=save(archive,output,changed);result['targets']=checks;return result
if __name__=='__main__':
 try:print(json.dumps(edit(*arguments()),ensure_ascii=False))
 except Exception as error:sys.exit('PPT修改失败：'+str(error))
