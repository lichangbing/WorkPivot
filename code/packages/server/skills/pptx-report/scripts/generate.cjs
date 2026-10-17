/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');
const Pptx = require('pptxgenjs');
async function main() {
  const [, , input, output] = process.argv;
  if (!input || !output?.endsWith('.pptx') || fs.existsSync(output) || fs.statSync(input).size > 1000000) throw Error('需要有界参数与不存在的PPTX输出');
  const spec = JSON.parse(fs.readFileSync(input, 'utf8'));
  if (Object.keys(spec).some(k => k !== 'slides') || !Array.isArray(spec.slides) || !spec.slides.length || spec.slides.length > 30) throw Error('需要1至30页幻灯片');
  const ppt = new Pptx(); ppt.layout = 'LAYOUT_WIDE';
  ppt.author = 'WorkPivot'; ppt.subject = '按结构化大纲生成';
  for (const entry of spec.slides) {
    if (!entry || Object.keys(entry).some(k => !['title', 'bullets'].includes(k)) || typeof entry.title !== 'string' || !entry.title.trim() || entry.title.length > 40 || !Array.isArray(entry.bullets) || entry.bullets.length > 5 || entry.bullets.some(t => typeof t !== 'string' || t.length > 70 || /[\x00-\x1f]/.test(t))) throw Error('每页需要40字以内标题及最多5条70字以内正文');
    const slide = ppt.addSlide();slide.background = { color: 'F7F9FC' };
    slide.addText(entry.title, { x: 0.65, y: 0.45, w: 12, h: 0.8, fontFace: 'Noto Sans CJK SC', fontSize: 28, bold: true, color: '16304B', margin: 0, breakLine: false });
    entry.bullets.forEach((text, i) => slide.addText(text, { x: 0.85, y: 1.55 + i * 1.05, w: 11.6, h: 0.9, fontFace: 'Noto Sans CJK SC', fontSize: 20, color: '23384D', margin: 0, valign: 'mid', breakLine: false }));
  }
  fs.writeFileSync(output, Buffer.from(await ppt.write({ outputType: 'nodebuffer' })), { flag: 'wx' });
  try { execFileSync('python3', [join(__dirname, 'inspect.py'), '--source', output, '--expected', input], { stdio: 'pipe' }); }
  catch { fs.unlinkSync(output); throw Error('生成后的大纲或布局边界检查失败'); }
  console.log(JSON.stringify({ generated: true, layout: 'bounded-template', visual: 'not-performed', verification: 'passed' }));
}
main().catch(e => { console.error('PPT生成失败：' + e.message); process.exitCode = 1; });
