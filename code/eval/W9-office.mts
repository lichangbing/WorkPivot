/**
 * W9 端到端评测（M1-08：PPT/Excel 生成，真实库零 LLM 成本）：
 * 模拟 LLM 状态机（写生成脚本 → bash 运行真实 pptxgenjs/exceljs → 写后自检）
 * → 真实服务层 → 断言：
 * 内置技能 pptx-report/xlsx-report 被发现并注入目录；斜杠激活；.pptx/.xlsx 真实产出可读回（zip 魔数+内部标记）；
 * 坏脚本→自检失败→修复重试链（复用 W4 验证过的模式，各走一次）。
 * 运行：pnpm eval:w9
 */
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---- 隔离环境（必须在 import 服务层之前设置） ----
const home = mkdtempSync(join(tmpdir(), 'wp9-home-'));
const workspace = mkdtempSync(join(tmpdir(), 'wp9-ws-'));
process.env['WORKPIVOT_HOME'] = home;
process.env['WORKPIVOT_WORKSPACE'] = workspace;

const { startServer } = await import('../packages/server/src/index.js');

const results: Array<{ name: string; pass: boolean; detail?: string }> = [];
function assert(name: string, pass: boolean, detail?: string): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ` —— ${detail}` : ''}`);
}

// ---- 模拟 OpenAI 兼容供应商（状态机按任务判别） ----
const MOCK_PORT = 39909;
let sawPptxSkill = false;
let sawXlsxSkill = false;

function toolCall(name: string, argsJson: string): unknown {
  return { choices: [{ delta: { tool_calls: [{ index: 0, id: `c_${Math.random().toString(36).slice(2, 8)}`, function: { name, arguments: argsJson } }] } }] };
}
function textDelta(text: string): unknown {
  return { choices: [{ delta: { content: text } }] };
}

/** PPT 生成状态机：坏脚本→自检失败→修复→通过 */
function pptScriptTurns(bad: boolean): Array<Array<{ send: (p: unknown) => void; reply: (t: string) => void }>> {
  const genBad = "require('fs').writeFileSync(process.argv[2], 'not a pptx');";
  const genGood = [
    "const pptxgen = require('pptxgenjs');",
    'const p = new pptxgen();',
    "p.defineLayout({ name: 'L16x9', width: 13.33, height: 7.5 });",
    "p.layout = 'L16x9';",
    'const s = p.addSlide();',
    "s.addText('W9 汇报', { x: 0.5, y: 0.4, w: 12, fontSize: 28, bold: true, fontFace: 'Microsoft YaHei' });",
    "s.addText('要点一', { x: 0.8, y: 1.8, w: 11, fontSize: 16, fontFace: 'Microsoft YaHei' });",
    "p.writeFile({ fileName: process.argv[2] }).then(() => console.log('ok'));",
  ].join('\n');
  const check = [
    "const b=require('fs').readFileSync(process.argv[2]);",
    "const ok=b[0]===0x50&&b[1]===0x4b&&b.includes(Buffer.from('ppt/presentation.xml'))&&b.length>5000;",
    "if(!ok){console.error('自检失败');process.exit(1)}console.log('自检通过',b.length,'字节');",
  ].join('\n');
  if (!bad) {
    return [
      [
        { send: () => {}, reply: (t) => t(toolCall('write', JSON.stringify({ path: 'gen-pptx.cjs', content: genGood }))) },
      ],
      [{ send: () => {}, reply: (t) => t(toolCall('bash', JSON.stringify({ command: 'node gen-pptx.cjs 汇报.pptx' }))) }],
      [{ send: () => {}, reply: (t) => t(toolCall('write', JSON.stringify({ path: 'check-pptx.cjs', content: check }))) }],
      [{ send: () => {}, reply: (t) => t(toolCall('bash', JSON.stringify({ command: 'node check-pptx.cjs 汇报.pptx' }))) }],
      [{ send: () => {}, reply: (t) => t(textDelta('PPT 已生成并通过自检。W9-PPTX-OK')) }],
    ];
  }
  return [
    [{ send: () => {}, reply: (t) => t(toolCall('write', JSON.stringify({ path: 'gen-pptx.cjs', content: genBad }))) }],
    [{ send: () => {}, reply: (t) => t(toolCall('bash', JSON.stringify({ command: 'node gen-pptx.cjs 汇报.pptx' }))) }],
    [{ send: () => {}, reply: (t) => t(toolCall('write', JSON.stringify({ path: 'check-pptx.cjs', content: check }))) }],
    [{ send: () => {}, reply: (t) => t(toolCall('bash', JSON.stringify({ command: 'node check-pptx.cjs 汇报.pptx' }))) }],
    [{ send: () => {}, reply: (t) => t(toolCall('write', JSON.stringify({ path: 'gen-pptx.cjs', content: genGood }))) }],
    [{ send: () => {}, reply: (t) => t(toolCall('bash', JSON.stringify({ command: 'node gen-pptx.cjs 汇报.pptx' }))) }],
    [{ send: () => {}, reply: (t) => t(toolCall('bash', JSON.stringify({ command: 'node check-pptx.cjs 汇报.pptx' }))) }],
    [{ send: () => {}, reply: (t) => t(textDelta('PPT 已生成并通过自检。W9-PPTX-OK')) }],
  ];
}

/** Excel 生成状态机（一次通过） */
function xlsxScriptTurns(): Array<Array<{ send: (p: unknown) => void; reply: (t: (s: unknown) => void) => void }>> {
  const gen = [
    "const ExcelJS = require('exceljs');",
    '(async () => {',
    '  const wb = new ExcelJS.Workbook();',
    "  const ws = wb.addWorksheet('汇总');",
    '  ws.columns = [',
    "    { header: '名称', key: 'name', width: 20 },",
    "    { header: '数量', key: 'qty', width: 10 },",
    '  ];',
    "  ws.addRow({ name: '项目甲', qty: 3 });",
    "  ws.addRow({ name: '项目乙', qty: 5 });",
    "  await wb.xlsx.writeFile(process.argv[2]);",
    "  console.log('ok');",
    '})();',
  ].join('\n');
  const check = [
    "const b=require('fs').readFileSync(process.argv[2]);",
    "const ok=b[0]===0x50&&b[1]===0x4b&&b.includes(Buffer.from('xl/workbook.xml'))&&b.length>2000;",
    "if(!ok){console.error('自检失败');process.exit(1)}console.log('自检通过',b.length,'字节');",
  ].join('\n');
  return [
    [{ send: () => {}, reply: (t) => t(toolCall('write', JSON.stringify({ path: 'gen-xlsx.cjs', content: gen }))) }],
    [{ send: () => {}, reply: (t) => t(toolCall('bash', JSON.stringify({ command: 'node gen-xlsx.cjs 报表.xlsx' }))) }],
    [{ send: () => {}, reply: (t) => t(toolCall('write', JSON.stringify({ path: 'check-xlsx.cjs', content: check }))) }],
    [{ send: () => {}, reply: (t) => t(toolCall('bash', JSON.stringify({ command: 'node check-xlsx.cjs 报表.xlsx' }))) }],
    [{ send: () => {}, reply: (t) => t(textDelta('Excel 已生成并通过自检。W9-XLSX-OK')) }],
  ];
}

/** M1-07 模板生成状态机：adm-zip 读模板 → 替换占位符 → 写出（模板路径从 system 注入里抓） */
function templateTurns(templatePath: string): Array<Array<{ send: (p: unknown) => void; reply: (emit: (s: unknown) => void) => void }>> {
  const gen = [
    "const AdmZip = require('adm-zip');",
    `const zip = new AdmZip(${JSON.stringify(templatePath)});`,
    "let xml = zip.readAsText('word/document.xml');",
    "const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');",
    "xml = xml",
    "  .replace(/\\{\\{标题\\}\\}/g, esc('W9 季度报告'))",
    "  .replace(/\\{\\{日期\\}\\}/g, esc('2026-09-07'))",
    "  .replace(/\\{\\{正文\\}\\}/g, esc('模板生成的内容段落'));",
    "zip.updateFile('word/document.xml', Buffer.from(xml, 'utf8'));",
    "zip.writeZip('模板报告.docx');",
    "console.log('ok');",
  ].join('\n');
  const check = [
    "const b=require('fs').readFileSync('模板报告.docx');",
    "const ok=b[0]===0x50&&b[1]===0x4b&&b.includes(Buffer.from('word/document.xml'))&&b.length>2000;",
    "if(!ok){console.error('自检失败');process.exit(1)}console.log('自检通过',b.length,'字节');",
  ].join('\n');
  return [
    [{ send: () => {}, reply: (t) => t(toolCall('write', JSON.stringify({ path: 'gen-tpl.cjs', content: gen }))) }],
    [{ send: () => {}, reply: (t) => t(toolCall('bash', JSON.stringify({ command: 'node gen-tpl.cjs' }))) }],
    [{ send: () => {}, reply: (t) => t(toolCall('write', JSON.stringify({ path: 'check-tpl.cjs', content: check }))) }],
    [{ send: () => {}, reply: (t) => t(toolCall('bash', JSON.stringify({ command: 'node check-tpl.cjs' }))) }],
    [{ send: () => {}, reply: (t) => t(textDelta('已按模板生成并通过自检。W9-TEMPLATE-OK')) }],
  ];
}

const mock: Server = createServer((req, res) => {
  void (async () => {
    if (req.method === 'GET' && req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
      return;
    }
    if (req.method === 'POST' && req.url?.endsWith('/chat/completions')) {
      let body = '';
      for await (const chunk of req) body += String(chunk);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (payload: unknown): void => {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      };
      if (body.includes('pptx-report')) sawPptxSkill = true;
      if (body.includes('xlsx-report')) sawXlsxSkill = true;
      const lastUser = [...(JSON.parse(body).messages ?? [])].reverse().find((m: { role: string }) => m.role === 'user');
      const userText = typeof lastUser?.content === 'string' ? lastUser.content : '';
      let turns: Array<Array<unknown>> | null = null;
      if (userText.includes('/pptx-report')) turns = pptScriptTurns(true) as unknown as Array<Array<unknown>>;
      else if (userText.includes('/xlsx-report')) turns = xlsxScriptTurns() as unknown as Array<Array<unknown>>;
      else if (userText.includes('/docx-report') && body.includes('企业 Word 模板')) {
        // M1-07：从 system 注入里抓模板绝对路径（JSON 中的 Windows 路径为 \\ 转义）
        const m = body.match(/[A-Z]:\\\\[^"]*?templates\\\\files\\\\[^"]*?\.docx/) ?? body.match(/\/[^\s"']*templates\/files\/[^\s"']*?\.docx/);
        turns = templateTurns(m ? m[0].replace(/\\\\/g, '\\') : '') as unknown as Array<Array<unknown>>;
      }
      if (turns === null) {
        send(textDelta('（默认回复）'));
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      // 按已回填 tool 结果数推进状态机
      const toolResults = (body.match(/"role":"tool"/g) ?? []).length;
      const idx = Math.min(toolResults, turns.length - 1);
      const turn = turns[idx] as Array<{ send: (p: unknown) => void; reply: (emit: (s: unknown) => void) => void }>;
      send({ choices: [{ delta: { role: 'assistant' } }] });
      const isFinal = idx === turns.length - 1;
      if (isFinal) {
        turn[0]!.reply((s) => send(s));
      } else {
        turn[0]!.reply((s) => send(s));
      }
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  })();
});
await new Promise<void>((resolve) => mock.listen(MOCK_PORT, '127.0.0.1', resolve));

const server = await startServer({ port: 39971, webDistDir: undefined });
const base = `http://127.0.0.1:${server.port}`;

try {
  const reg = await fetch(`${base}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'w9-smoke-123' }),
  });
  const { token } = (await reg.json()) as { token: string };
  const auth = { 'content-type': 'application/json', authorization: `Bearer ${token}` };

  await fetch(`${base}/api/providers`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ name: '模拟', baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, modelId: 'mock-1' }),
  });

  // 两个任务共用一个工作目录？不——各建各的，产物隔离
  const mkTask = async (name: string): Promise<{ id: string; directory: string }> => {
    const r = await fetch(`${base}/api/tasks`, { method: 'POST', headers: auth, body: JSON.stringify({ name }) });
    return ((await r.json()) as { task: { id: string; directory: string } }).task;
  };
  const runTask = async (taskId: string, content: string): Promise<string> => {
    const r = await fetch(`${base}/api/tasks/${taskId}/messages`, {
      method: 'POST', headers: auth, body: JSON.stringify({ content }),
      signal: AbortSignal.timeout(120_000),
    });
    return await r.text();
  };

  // 1. PPT：坏脚本→自检失败→修复→通过
  const pptTask = await mkTask('W9 PPT 生成');
  const pptSse = await runTask(pptTask.id, '/pptx-report 生成一页 W9 汇报 PPT');
  const pptFile = join(pptTask.directory, '汇报.pptx');
  assert('M1-08 pptx-report 技能注入 system', sawPptxSkill);
  assert('PPT 生成（坏脚本自检失败→修复重试链走通）', pptSse.includes('W9-PPTX-OK'), pptSse.slice(-300));
  assert('PPT 文件真实存在', existsSync(pptFile));
  if (existsSync(pptFile)) {
    const b = readFileSync(pptFile);
    assert('PPT 为合法 zip 且含 ppt/presentation.xml', b[0] === 0x50 && b[1] === 0x4b && b.includes(Buffer.from('ppt/presentation.xml')), `${b.length} 字节`);
  }

  // 2. Excel：一次通过
  const xlsxTask = await mkTask('W9 Excel 生成');
  const xlsxSse = await runTask(xlsxTask.id, '/xlsx-report 生成一张 W9 数据报表');
  const xlsxFile = join(xlsxTask.directory, '报表.xlsx');
  assert('M1-08 xlsx-report 技能注入 system', sawXlsxSkill);
  assert('Excel 生成链走通', xlsxSse.includes('W9-XLSX-OK'), xlsxSse.slice(-300));
  assert('Excel 文件真实存在', existsSync(xlsxFile));
  if (existsSync(xlsxFile)) {
    const b = readFileSync(xlsxFile);
    assert('Excel 为合法 zip 且含 xl/workbook.xml', b[0] === 0x50 && b[1] === 0x4b && b.includes(Buffer.from('xl/workbook.xml')), `${b.length} 字节`);
  }

  // 3. M1-07 企业 Word 模板：上传（用真实 docx 库现场造模板）→ 默认 → 生成链走 adm-zip 替换
  const { createRequire } = await import('node:module');
  const serverRequire = createRequire(join(import.meta.dirname, '..', 'packages', 'server', 'package.json'));
  const { Document, Packer, Paragraph, TextRun } = serverRequire('docx');
  const tplDoc = new Document({
    sections: [{
      children: [
        new Paragraph({ children: [new TextRun({ text: 'W9-TEMPLATE-HEAD {{标题}}', bold: true })] }),
        new Paragraph({ children: [new TextRun('日期：{{日期}}')] }),
        new Paragraph({ children: [new TextRun('{{正文}}')] }),
      ],
    }],
  });
  const tplBuf = await Packer.toBuffer(tplDoc);

  const upResp = await fetch(`${base}/api/templates?name=W9模板&kind=report`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${token}` },
    body: new Uint8Array(tplBuf),
  });
  const upJson = (await upResp.json()) as { template?: { id: string; isDefault: boolean }; error?: string };
  assert('H01 模板上传成功且自动设默认', upResp.status === 200 && upJson.template?.isDefault === true, JSON.stringify(upJson).slice(0, 120));
  const tplList = (await (await fetch(`${base}/api/templates`, { headers: auth })).json()) as { templates: Array<{ name: string; isDefault: boolean }> };
  assert('H01 模板清单可见', tplList.templates.some((t) => t.name === 'W9模板' && t.isDefault));

  // 模板生成任务：mock 检测到 system 含「企业 Word 模板」时走 adm-zip 替换链
  const tplTask = await mkTask('W9 模板生成');
  const tplSse = await runTask(tplTask.id, '/docx-report 按公司模板生成报告');
  const tplOut = join(tplTask.directory, '模板报告.docx');
  assert('H01 生成链走通（模板替换）', tplSse.includes('W9-TEMPLATE-OK'), tplSse.slice(-300));
  assert('H01 模板产物存在', existsSync(tplOut));
  if (existsSync(tplOut)) {
    const AdmZip = serverRequire('adm-zip');
    const outXml = new AdmZip(tplOut).readAsText('word/document.xml');
    assert('H01 占位符被替换（标题/日期/正文）', outXml.includes('W9 季度报告') && outXml.includes('2026-09-07') && outXml.includes('模板生成的内容段落'));
    assert('H01 模板固有内容保留', outXml.includes('W9-TEMPLATE-HEAD W9 季度报告') && !outXml.includes('{{正文}}'), outXml.slice(0, 80));
  }

  // 删除模板（回收站路径）
  const delTpl = await fetch(`${base}/api/templates/${upJson.template?.id}`, { method: 'DELETE', headers: auth });
  assert('H01 模板删除', delTpl.status === 200);
} finally {
  try { await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { 'content-type': 'application/json' } }); } catch { /* 忽略 */ }
  server.close();
  mock.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
}

const passed = results.filter((r) => r.pass).length;
console.log(`\n===== W9 冒烟：${passed}/${results.length} 通过 =====`);
if (passed !== results.length) process.exit(1);
