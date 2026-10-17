import json,pathlib,sys,zipfile,xml.etree.ElementTree as ET
# 技能资源只读，检查器不生成解释器缓存文件。
sys.dont_write_bytecode=True
from verify import verify

# 用独立的XML读取器核对参数与正文顺序，不依赖生成器内存中的对象。
spec=json.loads(pathlib.Path(sys.argv[1]).read_text()); path=pathlib.Path(sys.argv[2])
verify(path,[])
expected=([spec['title']] if 'title' in spec else [])+spec['paragraphs']
for table in spec.get('tables',[]):
 for row in table: expected.extend(row)
with zipfile.ZipFile(path) as archive:
 root=ET.fromstring(archive.read('word/document.xml'))
 actual=[''.join(e.text or '' for e in p.iter() if e.tag.split('}')[-1]=='t') for p in root.iter() if p.tag.split('}')[-1]=='p']
 if [t for t in actual if t]!=[t for t in expected if t]: raise ValueError('生成正文与参数内容或顺序不一致')
 tables=[e for e in root.iter() if e.tag.split('}')[-1]=='tbl']
 if len(tables)!=len(spec.get('tables',[])): raise ValueError('生成表格数量不一致')
 for table, rows in zip(tables,spec.get('tables',[])):
  actual_rows=[e for e in table if e.tag.split('}')[-1]=='tr']
  if len(actual_rows)!=len(rows) or any(len([e for e in row if e.tag.split('}')[-1]=='tc'])!=len(values) for row,values in zip(actual_rows,rows)): raise ValueError('生成表格行列不一致')
print(json.dumps({'structure':'passed','content':'passed','visual':'not-performed'}))
