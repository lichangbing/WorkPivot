import { validateDocumentObject, type DocumentObject } from './document-structure.js';
import { RepositoryError } from './connection.js';

/** 聊天读取与知识分块共用的持久解析契约，兼容已有文件版本。 */
export interface ParsedPart { location: string; text: string; object?: DocumentObject; recognition?: {method:'ocr';language:string;confidence:number;rotation?:number} }

export function validateParsedParts(value: unknown): ParsedPart[] {
  if (!Array.isArray(value) || !value.length || value.length > 20000) throw Error('解析内容为空或超限');
  let size = 0;
  const objectIds = new Set<string>();
  for (const part of value) {
    if (!part || typeof part.location !== 'string' || !part.location.trim() || part.location.length > 500 || typeof part.text !== 'string') throw Error('解析内容无效');
    if (part.object !== undefined) {
      validateDocumentObject(part.object);
      if (objectIds.has(part.location) || (part.object.parent && !objectIds.has(part.object.parent))) throw Error('文档对象重复或父对象不存在');
      objectIds.add(part.location);
      size += JSON.stringify(part.object).length;
    }
    if (part.recognition && (part.recognition.method !== 'ocr' || part.recognition.language !== 'chi_sim+eng' || !Number.isFinite(part.recognition.confidence) || part.recognition.confidence < 0 || part.recognition.confidence > 100 || (part.recognition.rotation !== undefined && ![0,90,180,270].includes(part.recognition.rotation)))) throw Error('OCR识别信息无效');
    size += part.text.length;
  }
  if (size > 1000000) throw Error('解析内容超过100万字符');
  return value as ParsedPart[];
}

/** 延续原有UTF-16游标；结构片段额外携带定位，跨页时不丢失出处。 */
export function readParsedPage(value: unknown, offset: number) {
  const parts = validateParsedParts(value);
  const spans: { partIndex: number; location: string; text: string; recognition?: ParsedPart['recognition']; start: number; end: number }[] = [];
  let position = 0;
  const text = parts.map((part, partIndex) => {
    const prefix = `[${part.location}]\n`;
    const start = position + prefix.length;
    spans.push({ ...part, partIndex, start, end: start + part.text.length });
    position = start + part.text.length + 1;
    return prefix + part.text;
  }).join('\n');
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) throw new RepositoryError(400, '读取位置无效');
  if (offset > 0 && /[\uD800-\uDBFF]/.test(text[offset - 1]!) && /[\uDC00-\uDFFF]/.test(text[offset] ?? '')) throw new RepositoryError(400, '读取位置位于字符中间，请使用返回的nextOffset');
  let end = Math.min(offset + 8000, text.length);
  // 密集单元格的定位元数据也要有界，缩短本页并用原游标继续，不能静默丢弃片段。
  const overflow = spans.filter(part => part.end > offset && part.start < end)[64];
  if (overflow) end = overflow.start;
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
  const excerpts = spans.filter(part => part.end > offset && part.start < end).map(part => {
    const from = Math.max(offset, part.start) - part.start;
    const to = Math.min(end, part.end) - part.start;
    return { recognition: part.recognition, partIndex: part.partIndex, location: part.location, sourceOffset: from, sourceEnd: to, totalCharacters: part.text.length, content: part.text.slice(from, to), continuedBefore: from > 0, continuedAfter: to < part.text.length };
  });
  return { format: 'extracted', offset, endOffset: end, offsetUnit: 'utf16', totalCharacters: text.length, content: text.slice(offset, end), nextOffset: end < text.length ? end : null, excerpts, totalParts: parts.length, hasMore: end < text.length, scope: 'extracted-text', coversAllExtractedText: offset === 0 && end === text.length };
}

export function parsingLimitations(extension: string): string[] {
  const common = ['结果仅覆盖已提取文字，不代表完整视觉内容、排版或所有文档对象。'];
  switch (extension.toLowerCase()) {
    case '.xlsx': return [...common, '公式及缓存来自原文件，未重新计算；缓存可能缺失或过期，未解析图表及完整格式。'];
    case '.png': case '.jpg': case '.jpeg': case '.pdf': return [...common, '图片或扫描页（无文字PDF页）按资源上限尝试OCR；文字PDF页中的嵌入图片不额外识别。OCR可能漏识或误识，置信度不是准确率，不能依据完成状态判断每页均已识别。'];
    case '.docx': return [...common, '当前解析主要覆盖正文段落（包括表格内文字），不提供真实分页、完整表格样式、页眉页脚或图片识别。'];
    case '.pptx': return [...common, '当前解析主要覆盖幻灯片文字，不包含完整图表数据、备注、动画及图片识别。'];
    default: return common;
  }
}
