import assert from 'node:assert/strict';
import { readParsedPage, parsingLimitations, validateParsedParts } from '../packages/server/src/database/parsed-content.js';
import { splitKnowledge } from '../packages/server/src/database/knowledge.js';

let checks = 0;
const check = (condition: unknown, name: string) => { assert.ok(condition, name); checks++; console.log('通过：' + name); };
const parts = [{ location: 'paragraph:1', text: '甲'.repeat(7985) + '😀' + '乙'.repeat(9000) }, { location: 'sheet:预算!B2', text: 'formula=10+20; cached=30' }];
const expected = parts.map(p => `[${p.location}]\n${p.text}`).join('\n');
let offset = 0, rebuilt = '';
const recovered = parts.map(() => '');
do {
  const page = readParsedPage(parts, offset);
  check(page.content.length <= 8000 && !/[\uD800-\uDBFF]$/.test(page.content), '分页不截断代理对');
  for (const excerpt of page.excerpts) {
    check(excerpt.content === parts[excerpt.partIndex]!.text.slice(excerpt.sourceOffset, excerpt.sourceEnd), '片段定位可精确回读原文');
    recovered[excerpt.partIndex] += excerpt.content;
  }
  if (offset > 0) check(!page.coversAllExtractedText, '最后一页不冒充全文');
  rebuilt += page.content;
  if (page.nextOffset === null) break;
  offset = page.nextOffset;
} while (true);
check(rebuilt === expected && recovered.every((text, i) => text === parts[i]!.text), '逐页和逐片段重建无遗漏无重复');
const continued = readParsedPage(parts, 8001);
check(continued.excerpts[0]?.location === 'paragraph:1' && continued.excerpts[0].continuedBefore, '续页保留段落位置');
const chunks = splitKnowledge(parts);
check(chunks[0]?.location === readParsedPage(parts, 0).excerpts[0]?.location, '知识分块与聊天读取使用相同来源');
for (const value of [[], null, [{ location: '', text: '内容' }], [{ location: '段落', text: 1 }], [{ location: '段落', text: '字'.repeat(1000001) }]]) {
  assert.throws(() => validateParsedParts(value));
  assert.throws(() => readParsedPage(value, 0));
  checks++;
}
for (const bad of [-1, NaN, 0.5, expected.length + 1, expected.indexOf('😀') + 1]) { assert.throws(() => readParsedPage(parts, bad)); checks++; }
check(readParsedPage(parts, expected.length).excerpts.length === 0, '尾部空页不伪造片段');
check(parsingLimitations('.PDF').some(x => x.includes('扫描页')), '混合扫描PDF不会宣称完整识别');
check(parsingLimitations('.xlsx').some(x => x.includes('未重新计算')), '公式缓存不冒充重算');
const dense = Array.from({ length: 1000 }, (_, i) => ({ location: `sheet:预算!A${i + 1}`, text: String(i) }));
let denseOffset = 0, denseText = '', denseParts = 0;
do {
  const page = readParsedPage(dense, denseOffset);
  assert.ok(page.excerpts.length <= 64);
  denseParts += page.excerpts.length; denseText += page.content;
  if (page.nextOffset === null) break;
  assert.ok(page.nextOffset > denseOffset); denseOffset = page.nextOffset;
} while (true);
check(denseParts === dense.length && denseText === dense.map(p => `[${p.location}]\n${p.text}`).join('\n'), '密集单元格定位数量有界且连续翻页无遗漏');
console.log(`解析契约：${checks}/${checks}通过`);
