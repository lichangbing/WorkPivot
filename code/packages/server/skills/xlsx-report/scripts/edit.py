import sys,json,re,math
sys.dont_write_bytecode=True
from edit_common import elements,descendants,content,child,create,string,xml,load,save,arguments

def position(address):
 match=re.fullmatch(r'([A-Z]{1,3})([1-9][0-9]{0,6})',address)
 if not match: raise ValueError('单元格地址无效')
 col=0
 for c in match[1]: col=col*26+ord(c)-64
 row=int(match[2])
 if col>16384 or row>1048576: raise ValueError('单元格地址超限')
 return col,row

def value(cell,shared):
 raw=content(child(cell,'v')) if child(cell,'v') is not None else ''
 if cell.getAttribute('t')=='s': raw=shared[int(raw)] if raw else ''
 if cell.getAttribute('t')=='inlineStr': raw=''.join(content(t) for t in descendants(cell,'t'))
 formula=child(cell,'f')
 return 'formula='+content(formula)+'; cached='+raw if formula is not None else raw

def edit(source,output,spec):
 if source.suffix.lower()!='.xlsx' or output.suffix.lower()!='.xlsx': raise ValueError('仅支持XLSX')
 archive=load(source,output,spec);book=xml(archive.read('xl/workbook.xml'));rels=xml(archive.read('xl/_rels/workbook.xml.rels'));changed={};removed=[]
 if descendants(book,'externalReference'): raise ValueError('外部工作簿链接不支持修改')
 shared=[''.join(content(t) for t in descendants(si,'t')) for si in descendants(xml(archive.read('xl/sharedStrings.xml')),'si')] if 'xl/sharedStrings.xml' in archive.namelist() else []
 targets={e.getAttribute('Id'):e for e in elements(rels.documentElement)};sheets={}
 for sheet in descendants(book,'sheet'):
  rid=next(a.value for a in sheet.attributes.values() if a.localName=='id');rel=targets[rid];path=rel.getAttribute('Target')
  name=path.lstrip('/') if path.startswith('/') else 'xl/'+path
  if '..' in name.split('/') or rel.getAttribute('TargetMode')=='External': raise ValueError('工作表关系无效')
  dom=xml(archive.read(name))
  if dom.documentElement.localName!='worksheet': raise ValueError('暂不修改含非普通工作表的工作簿')
  if descendants(dom,'sheetProtection'): raise ValueError('工作表受保护')
  for formula in descendants(dom,'f'):
   if formula.getAttribute('t') not in ('','normal'): raise ValueError('共享、数组或数据表公式暂不支持修改')
  sheets[sheet.getAttribute('name')]=(name,dom)
 seen=set();checks=[];dirty=set()
 for change in spec['changes']:
  if not isinstance(change,dict) or set(change)!={'sheet','address','expected','value'}: raise ValueError('单元格修改参数无效')
  key=(change['sheet'],change['address'])
  if key in seen or key[0] not in sheets: raise ValueError('工作表不存在或目标重复')
  seen.add(key);point=position(key[1]);name,dom=sheets[key[0]]
  cells=[c for c in descendants(dom,'c') if c.getAttribute('r')==key[1]]
  if len(cells)!=1: raise ValueError('首版仅修改已存储单元格，不能插入行列或扩展区域')
  cell=cells[0];dirty.add(name)
  for merged in descendants(dom,'mergeCell'):
   bounds=merged.getAttribute('ref').split(':');a=position(bounds[0]);b=position(bounds[-1])
   if a[0]<=point[0]<=b[0] and a[1]<=point[1]<=b[1] and point!=a: raise ValueError('只能修改合并区域左上角单元格')
  if value(cell,shared)!=string(change['expected']): raise ValueError('单元格原值不匹配')
  if any(c.localName not in ('v','f','is') for c in elements(cell)): raise ValueError('目标单元格包含不支持的扩展对象')
  new=change['value']
  for c in list(cell.childNodes): cell.removeChild(c)
  if cell.hasAttribute('t'): cell.removeAttribute('t')
  if new is None: expected=''
  elif isinstance(new,bool): cell.setAttribute('t','b');cell.appendChild(create(cell,'v','1' if new else '0'));expected='1' if new else '0'
  elif isinstance(new,(int,float)) and math.isfinite(new): cell.appendChild(create(cell,'v',str(new)));expected=str(new)
  elif isinstance(new,str):
   string(new);cell.setAttribute('t','inlineStr');inline=create(cell,'is');node=create(inline,'t',new);node.setAttribute('xml:space','preserve');inline.appendChild(node);cell.appendChild(inline);expected=new
  elif isinstance(new,dict) and set(new)=={'formula'}:
   formula=string(new['formula'])
   if not formula or formula.startswith('=') or len(formula)>8192 or '[' in formula or '|' in formula: raise ValueError('公式无效或含外部引用')
   cell.appendChild(create(cell,'f',formula));expected='formula='+formula+'; cached='
  else: raise ValueError('单元格新值类型无效')
  checks.append((key,expected))
 # 无依赖图时保守清除所有普通公式缓存；不返回已经过时的计算结果。
 for name,dom in sheets.values():
  for cell in descendants(dom,'c'):
   if child(cell,'f') is not None:
    if elements(cell,'v') or cell.hasAttribute('t'): dirty.add(name)
    for cached in elements(cell,'v'): cell.removeChild(cached)
    if cell.hasAttribute('t'): cell.removeAttribute('t')
  data=dom.toxml(encoding='UTF-8')
  if name in dirty: changed[name]=data
 calc=next(iter(descendants(book,'calcPr')),None)
 if calc is None:
  calc=create(book.documentElement,'calcPr');root=book.documentElement
  following=next((e for e in elements(root) if e.localName in ('oleSize','customWorkbookViews','pivotCaches','smartTagPr','smartTagTypes','webPublishing','fileRecoveryPr','webPublishObjects','extLst')),None)
  root.insertBefore(calc,following)
 for key,v in {'calcMode':'auto','fullCalcOnLoad':'1','forceFullCalc':'1'}.items(): calc.setAttribute(key,v)
 changed['xl/workbook.xml']=book.toxml(encoding='UTF-8')
 for rel in list(elements(rels.documentElement)):
  if rel.getAttribute('Type').endswith('/calcChain'):
   target=rel.getAttribute('Target');path=target.lstrip('/') if target.startswith('/') else 'xl/'+target
   if '..' in path.split('/') or path!='xl/calcChain.xml': raise ValueError('计算链路径不支持')
   removed.append(path);rels.documentElement.removeChild(rel)
 if removed:
  changed['xl/_rels/workbook.xml.rels']=rels.toxml(encoding='UTF-8');types=xml(archive.read('[Content_Types].xml'))
  for entry in list(elements(types.documentElement)):
   if entry.getAttribute('PartName').lstrip('/') in removed: types.documentElement.removeChild(entry)
  changed['[Content_Types].xml']=types.toxml(encoding='UTF-8')
 for (sheet,address),expected in checks:
  name,_=sheets[sheet];reopened=xml(changed[name]);cell=next(c for c in descendants(reopened,'c') if c.getAttribute('r')==address)
  if value(cell,shared)!=expected: raise ValueError('修改后单元格核对失败')
 result=save(archive,output,changed,removed);result['targets']=[sheet+'!'+address for (sheet,address),_ in checks];result['formulaCaches']='cleared';return result
if __name__=='__main__':
 try: print(json.dumps(edit(*arguments()),ensure_ascii=False))
 except Exception as error: sys.exit('Excel修改失败：'+str(error))
