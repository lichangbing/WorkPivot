import { RepositoryError } from './connection.js';
import { validateParsedParts } from './parsed-content.js';

/** 对象编号只在同一不可变文件版本内有效，不作为跨版本编辑标识。 */
export interface DocumentObject {
  kind: 'paragraph' | 'table' | 'table-cell' | 'sheet' | 'cell' | 'merge' | 'slide' | 'shape' | 'chart' | 'chart-point' | 'notes';
  sourcePart?: string;
  dataSource?: string;
  seriesName?: string;
  slideNumber?: number;
  shapeId?: string;
  shapeType?: string;
  x?: string;
  y?: string;
  width?: string;
  height?: string;
  parent?: string;
  sheet?: string;
  row?: number;
  column?: number;
  columnSpan?: number;
  verticalMerge?: string;
  address?: string;
  range?: string;
  state?: string;
  valueType?: string;
  formula?: string;
  formulaType?: string;
  sharedIndex?: string;
  formulaRange?: string;
  cached?: string;
  tableName?: string;
  tableRange?: string;
  headerRow?: string;
  dateSystem?: string;
  rawValue?: string;
  normalizedValue?: string;
  conversionWarning?: string;
  styleId?: string;
  numberFormatId?: string;
  numberFormatCode?: string;
}

export function validateDocumentObject(value: unknown): asserts value is DocumentObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('文档对象无效');
  const v = value as Record<string, unknown>;
  if (!['paragraph', 'table', 'table-cell', 'sheet', 'cell', 'merge', 'slide', 'shape', 'chart', 'chart-point', 'notes'].includes(String(v['kind']))) throw Error('文档对象类型无效');
  for (const [key, item] of Object.entries(v)) {
    if (['row', 'column', 'columnSpan', 'slideNumber'].includes(key)) {
      if (!Number.isSafeInteger(item) || (item as number) < 1 || (item as number) > 1048576) throw Error('文档对象坐标无效');
    } else if (!['kind', 'parent', 'sheet', 'verticalMerge', 'address', 'range', 'state', 'valueType', 'formula', 'formulaType', 'sharedIndex', 'formulaRange', 'cached', 'styleId', 'numberFormatId', 'numberFormatCode', 'tableName', 'tableRange', 'headerRow', 'dateSystem', 'rawValue', 'normalizedValue', 'conversionWarning', 'sourcePart', 'dataSource', 'seriesName', 'shapeId', 'shapeType', 'x', 'y', 'width', 'height'].includes(key) || typeof item !== 'string' || item.length > 32768) throw Error('文档对象属性无效');
  }
  if (v['parent'] !== undefined && (!(v['parent'] as string).length || (v['parent'] as string).length > 500)) throw Error('父对象编号无效');
  if (['sheet', 'cell', 'merge'].includes(String(v['kind'])) && (typeof v['sheet'] !== 'string' || !v['sheet'] || v['sheet'].length > 100)) throw Error('工作表名称无效');
  if (v['kind'] === 'cell') cellPosition(String(v['address']));
  if (v['kind'] === 'merge') rectangle(String(v['range']));
  if (v['kind'] === 'table-cell' && (!v['parent'] || !v['row'] || !v['column'] || !v['columnSpan'])) throw Error('表格单元格坐标缺失');
  if (v['verticalMerge'] !== undefined && !['restart', 'continue'].includes(String(v['verticalMerge']))) throw Error('纵向合并状态无效');
}

function cellPosition(address: string) {
  const match = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(address);
  if (!match) throw new RepositoryError(400, '区域须使用A1或A1:C20格式');
  const column = [...match[1]!].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0), row = Number(match[2]);
  if (column > 16384 || row > 1048576) throw new RepositoryError(400, '区域超出工作表边界');
  return { column, row };
}
function rectangle(range: string) {
  const ends = range.split(':');
  if (ends.length > 2) throw new RepositoryError(400, '区域格式无效');
  const a = cellPosition(ends[0]!), b = cellPosition(ends[1] ?? ends[0]!);
  if (a.column > b.column || a.row > b.row) throw new RepositoryError(400, '区域起点不能大于终点');
  return { a, b };
}
export interface StructureQuery { offset?: number; textOffset?: number; parent?: string; sheet?: string; range?: string }

export function readStructurePage(value: unknown, query: StructureQuery = {}) {
  const parts = validateParsedParts(value);
  if (!parts.some(p => p.object)) throw new RepositoryError(409, '该解析结果没有结构化对象，请重建解析');
  for (const key of ['parent', 'sheet', 'range'] as const) if (query[key] !== undefined && (typeof query[key] !== 'string' || !query[key]!.length || query[key]!.length > 500)) throw new RepositoryError(400, '结构筛选条件无效');
  if (query.range && !query.sheet) throw new RepositoryError(400, '读取区域必须同时指定工作表名称');
  if (query.sheet && !parts.some(p => p.object?.kind === 'sheet' && p.object.sheet === query.sheet)) throw new RepositoryError(404, '工作表不存在');
  if (query.parent && !parts.some(p => p.location === query.parent && p.object)) throw new RepositoryError(404, '父对象不存在');
  const area = query.range ? rectangle(query.range) : undefined;
  const selected = parts.filter(p => {
    const o = p.object;
    if (!o || (query.parent && o.parent !== query.parent) || (query.sheet && o.sheet !== query.sheet)) return false;
    if (!area) return true;
    if (o.kind === 'cell' && o.address) {
      const c = cellPosition(o.address);
      return c.row >= area.a.row && c.row <= area.b.row && c.column >= area.a.column && c.column <= area.b.column;
    }
    if (o.kind === 'merge' && o.range) {
      const r = rectangle(o.range);
      return r.a.row <= area.b.row && r.b.row >= area.a.row && r.a.column <= area.b.column && r.b.column >= area.a.column;
    }
    return false;
  });
  const offset = query.offset ?? 0, textOffset = query.textOffset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > selected.length || !Number.isSafeInteger(textOffset) || textOffset < 0 || textOffset > (selected[offset]?.text.length ?? 0)) throw new RepositoryError(400, '结构读取位置无效');
  const items = []; let index = offset, from = textOffset, budget = 8000, metadataSize = 0;
  while (index < selected.length && items.length < 32 && budget > 0) {
    const p = selected[index]!;
    const size = JSON.stringify(p.object).length + p.location.length;
    if (items.length && metadataSize + size > 64000) break;
    metadataSize += size;
    if (from && /[\uD800-\uDBFF]/.test(p.text[from - 1]!) && /[\uDC00-\uDFFF]/.test(p.text[from] ?? '')) throw new RepositoryError(400, '读取位置位于字符中间');
    let end = Math.min(p.text.length, from + budget);
    if (end < p.text.length && /[\uD800-\uDBFF]/.test(p.text[end - 1]!)) end--;
    if (end === from && p.text.length > from) break;
    items.push({ id: p.location, ...p.object, text: p.text.slice(from, end), textOffset: from, totalCharacters: p.text.length });
    budget -= end - from;
    if (end < p.text.length) { from = end; break; }
    index++; from = 0;
  }
  return { items, totalObjects: selected.length, next: index < selected.length ? { offset: index, textOffset: from } : null, offsetUnit: 'utf16', scope: 'stored-document-objects', sparse: true };
}
