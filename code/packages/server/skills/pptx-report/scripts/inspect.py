import sys,json,pathlib,argparse,zipfile,xml.etree.ElementTree as ET
sys.dont_write_bytecode=True
from verify import verify

def inspect(path):
 verify(path,[])
 with zipfile.ZipFile(path) as z:
  presentation=ET.fromstring(z.read('ppt/presentation.xml'));local=lambda e:e.tag.split('}')[-1]
  size=next(e for e in presentation if local(e)=='sldSz');width=int(size.get('cx'));height=int(size.get('cy'))
  rels={e.get('Id'):e.get('Target') for e in ET.fromstring(z.read('ppt/_rels/presentation.xml.rels'))};slides=[];warnings=[]
  for index,slide in enumerate(e for e in presentation.iter() if local(e)=='sldId'):
   rid=next(v for k,v in slide.attrib.items() if k.endswith('}id'));target=rels[rid];name=target.lstrip('/') if target.startswith('/') else 'ppt/'+target
   if '..' in name.split('/'):raise ValueError('页关系无效')
   root=ET.fromstring(z.read(name));tree=next(e for e in root.iter() if local(e)=='spTree');objects=[]
   for shape in tree:
    if local(shape) not in ('sp','pic','graphicFrame','grpSp'):continue
    prop=next((e for e in shape.iter() if local(e)=='cNvPr'),None)
    transform=next((e for e in shape.iter() if local(e)=='xfrm'),None)
    if local(shape)=='grpSp':warnings.append('第'+str(index+1)+'页组合对象未进行独立布局检查')
    off=next((e for e in transform if local(e)=='off'),None) if transform is not None else None
    ext=next((e for e in transform if local(e)=='ext'),None) if transform is not None else None
    if off is not None and ext is not None:
     x,y,cx,cy=int(off.get('x')),int(off.get('y')),int(ext.get('cx')),int(ext.get('cy'))
     if min(x,y,cx,cy)<0 or x+cx>width or y+cy>height:raise ValueError('第'+str(index+1)+'页对象超出画布')
    else:warnings.append('第'+str(index+1)+'页对象使用继承布局，未核对边界')
    paragraphs=[''.join(e.text or '' for e in p.iter() if local(e)=='t') for p in shape.iter() if local(p)=='p']
    objects.append({'shapeId':prop.get('id') if prop is not None else None,'type':local(shape),'text':'\n'.join(paragraphs)})
   slides.append({'slide':index+1,'objects':objects})
 return {'slides':slides,'layout':'partial' if warnings else 'bounds-passed','warnings':warnings,'visual':'not-performed'}
if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--source',required=True);parser.add_argument('--expected');args=parser.parse_args()
 try:
  result=inspect(pathlib.Path(args.source))
  if args.expected:
   spec=json.loads(pathlib.Path(args.expected).read_text())
   if len(spec['slides'])!=len(result['slides']):raise ValueError('页数与大纲不一致')
   for expected,actual in zip(spec['slides'],result['slides']):
    if [o['text'] for o in actual['objects']]!=[expected['title']]+expected['bullets']:raise ValueError('幻灯片正文与大纲不一致')
  print(json.dumps(result,ensure_ascii=False))
 except Exception as error:sys.exit('PPT检查失败：'+str(error))
