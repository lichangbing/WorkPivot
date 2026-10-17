import argparse
import json
import pathlib
import sys
import posixpath
import zipfile
import xml.etree.ElementTree as ET

# 仅核对结构和指定文本，不执行宏、不重算公式、不宣称视觉或保真检查。
def verify(path, expected, expected_cells=None):
    required = {'.docx': 'word/document.xml', '.xlsx': 'xl/workbook.xml', '.pptx': 'ppt/presentation.xml'}
    suffix = path.suffix.lower()
    if suffix not in required:
        raise ValueError('不支持此格式')
    if not path.is_file() or path.stat().st_size > 32 * 1024 * 1024:
        raise ValueError('文件不存在或超过检查大小限制')
    with zipfile.ZipFile(path) as archive:
        info = archive.infolist()
        names = [item.filename for item in info]
        if len(names) != len(set(names)) or len(info) > 4000 or sum(item.file_size for item in info) > 32000000 or any(item.file_size > 8000000 for item in info):
            raise ValueError('压缩包重复条目或内容超限')
        if required[suffix] not in names or '[Content_Types].xml' not in names:
            raise ValueError('缺少必要文档结构')
        if archive.testzip() is not None:
            raise ValueError('压缩包校验失败')
        text = []
        xml_count = 0
        trees = {}
        for item in info:
            if not item.filename.endswith(('.xml', '.rels')):
                continue
            data = archive.read(item)
            if b'<!DOCTYPE' in data.replace(b'\x00', b'').upper() or b'<!ENTITY' in data.replace(b'\x00', b'').upper():
                raise ValueError('不支持XML实体声明')
            root = ET.fromstring(data)
            xml_count += 1
            trees[item.filename] = root
            # 只从正文资源取期望文字，属性文件和批注不作为正文命中的证据。
            name = item.filename
            body = (suffix == '.docx' and name == required[suffix]) or False or (suffix == '.pptx' and name.startswith('ppt/slides/slide') and name.endswith('.xml'))
            if body:
                text.append(''.join(node.text or '' for node in root.iter() if node.tag.split('}')[-1] in ('t', 'v')))
        cells = {}
        if suffix == '.xlsx':
            local = lambda node: node.tag.split('}')[-1]
            shared = [''.join(n.text or '' for n in item.iter() if local(n) == 't') for item in trees.get('xl/sharedStrings.xml', [])]
            rels = {r.get('Id'): r for r in trees['xl/_rels/workbook.xml.rels']}
            for sheet in (n for n in trees['xl/workbook.xml'].iter() if local(n) == 'sheet'):
                rid = next(v for k, v in sheet.attrib.items() if k.endswith('}id'))
                rel = rels[rid]
                if rel.get('TargetMode') == 'External':
                    raise ValueError('外部工作表不支持')
                target = rel.get('Target', '')
                name = posixpath.normpath(target.lstrip('/') if target.startswith('/') else 'xl/' + target)
                if not name.startswith('xl/worksheets/') or name not in trees:
                    raise ValueError('工作表关系无效')
                for cell in (n for n in trees[name].iter() if local(n) == 'c'):
                    value = next((n.text or '' for n in cell if local(n) == 'v'), '')
                    if cell.get('t') == 's':
                        index = int(value)
                        if index < 0 or index >= len(shared): raise ValueError('字符串引用越界')
                        value = shared[index]
                    elif cell.get('t') == 'inlineStr':
                        value = ''.join(n.text or '' for n in cell.iter() if local(n) == 't')
                    key = (sheet.get('name'), cell.get('r'))
                    if key in cells: raise ValueError('重复单元格')
                    cells[key] = value
                    text.append(value)
        content = '\n'.join(text)
        if expected_cells:
            if suffix != '.xlsx' or len(expected_cells) > 100: raise ValueError('单元格校验参数无效')
            for item in expected_cells:
                if not isinstance(item, dict) or set(item) != {'sheet', 'cell', 'value'} or not all(isinstance(v, str) for v in item.values()): raise ValueError('单元格校验格式无效')
                if cells.get((item['sheet'], item['cell'])) != item['value']: raise ValueError('单元格内容不匹配')
        if any(not item or len(item) > 10000 for item in expected) or len(expected) > 100:
            raise ValueError('核对文本为空或超限')
        if any(item not in content for item in expected):
            raise ValueError('产物缺少要求的正文内容')
        return {'structure': 'passed', 'expectedText': 'passed' if expected else 'not-requested', 'expectedCells': 'passed' if expected_cells else 'not-requested', 'xmlFiles': xml_count, 'recalculation': 'not-performed', 'visual': 'not-performed', 'preservation': 'not-verified'}

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='核对Office压缩包、XML与指定正文文本')
    parser.add_argument('file')
    parser.add_argument('--expect-text', action='append', default=[])
    parser.add_argument('--expect-cell', action='append', default=[], help='JSON对象：sheet、cell、value；核对原值或公式缓存，不重算')
    args = parser.parse_args()
    try:
        print(json.dumps(verify(pathlib.Path(args.file), args.expect_text, [json.loads(item) for item in args.expect_cell]), ensure_ascii=False))
    except Exception:
        print(json.dumps({'structure': 'failed', 'error': '文件结构损坏、超限或缺少预期正文；未验证重算或视觉结果'}, ensure_ascii=False))
        sys.exit(1)
